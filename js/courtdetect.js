// Automatic court calibration from one frame:
//   1. white-line pixels (bright, thin, unsaturated — Farin et al. line detector)
//   2. Hough transform -> straight line candidates
//   3. model fitting: every pair of "transverse" and "longitudinal" image lines matched to court lines
//      gives a homography; hypotheses are pruned by the camera pose they imply (known intrinsics) and
//      scored against the line mask
//   4. refinement: the court model is projected, line pixels are searched along the normals, lines
//      re-fitted, and the camera pose optimised on point-to-line distances.
// Images here are "processing" images (<= ~960 px wide); intrinsics are scaled to match.
import { CameraModel, poseFromHomography } from './camera.js';
import { homography4, homographyDLT, applyH, fitLine, intersectLines, levenbergMarquardt, rotFromVec, vecFromRot, mul33, inv33, spdInverse } from './linalg.js';
import { LINES, LINE_X, LINE_Y, KEYPOINTS, netHeightAt } from './court.js';

// ---------- 1. line pixels ----------
export function luminance(img) {
  const { data, width: w, height: h } = img;
  const lum = new Uint8Array(w * h), chroma = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    lum[i] = (r * 77 + g * 150 + b * 29) >> 8;
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { lum, chroma, w, h };
}

// Painted lines are thin bright ridges. Every pixel gets a ridge strength (Farin et al.: brighter than
// the pixels tau away on both sides, horizontally or vertically, for a tau around the line width) and
// the direction of its local structure. A line pixel is a ridge that stands out from the texture
// around it: clay brush marks, leaves and grass are ridges too, only weaker than the lines next to
// them. The threshold is local, so lines inside a shadow count as much as lines in the sun.
export function lineEvidence({ lum, chroma, w, h }) {
  const N = w * h, B = 11;
  const str = new Float32Array(N);
  const taus = [2, 4, 7, 11];
  for (let y = B; y < h - B; y++) {
    for (let x = B; x < w - B; x++) {
      const i = y * w + x, g = lum[i];
      // white, or whitish: tapes on clay get brushed over and turn pink
      if (g < 40 || chroma[i] > 0.6 * g + 12) continue;
      let best = 0;
      for (const t of taus) {
        const a = Math.min(g - lum[i - t], g - lum[i + t]), b = Math.min(g - lum[i - t * w], g - lum[i + t * w]);
        if (a > best) best = a;
        if (b > best) best = b;
      }
      str[i] = best;
    }
  }
  // Texture level: mean ridge strength in a window around the pixel. Strengths are capped so that
  // the lines themselves (wide near the camera, crossing at the corners) do not raise it much.
  const R = Math.max(8, Math.round(w / 64)), W1 = w + 1, CAP = 30;
  const ii = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += Math.min(CAP, str[y * w + x]); ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + row; }
  }
  const boxMean = (x, y) => {
    const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    return (ii[y1 * W1 + x1] - ii[y0 * W1 + x1] - ii[y1 * W1 + x0] + ii[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const gx = new Int16Array(N), gy = new Int16Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - 1] + lum[i + w - 1]);
    gy[i] = (lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1]);
  }
  // strong: ridges that stand out from the texture (any shape); mask: those that are also line-like
  const mask = new Uint8Array(N), strong = new Uint8Array(N), ori = new Float32Array(N);
  const r = 3;
  for (let y = B; y < h - B; y++) for (let x = B; x < w - B; x++) {
    const i = y * w + x, s = str[i];
    if (s < 12 || s < 0.1 * lum[i] || s < 3 * boxMean(x, y)) continue;
    strong[i] = 1;
    // Structure tensor: gradients across a line share one axis (coherence); that axis is the normal
    let jxx = 0, jxy = 0, jyy = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = i + dy * w + dx, a = gx[k], b = gy[k];
      jxx += a * a; jxy += a * b; jyy += b * b;
    }
    const tr = jxx + jyy;
    if (!tr || Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / tr < 0.5) continue;
    mask[i] = 1;
    let th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
    if (th < 0) th += Math.PI;
    ori[i] = th;
  }
  return { mask, strong, ori, str };
}
export const linePixels = lc => lineEvidence(lc).mask;

function dilate(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) out[i] = 1;
  }
  return out;
}

// ---------- 2. Hough ----------
const NT = 360;
const COS = new Float64Array(NT), SIN = new Float64Array(NT);
for (let k = 0; k < NT; k++) { COS[k] = Math.cos(k * Math.PI / NT); SIN[k] = Math.sin(k * Math.PI / NT); }

// Straight lines from line pixels. Each pixel votes only for lines along its own direction, so
// texture (random directions) spreads its votes thin. A candidate line is kept only where its pixels
// run continuously: texture can line up by chance, but it does not draw a solid stroke.
// ev: { mask, ori } from lineEvidence (a bare mask votes in all directions).
export function houghLines(ev, w, h, { maxLines = 24, minVotes = 30 } = {}) {
  const mask = ev.mask || ev, ori = ev.ori || null;
  let pts = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) pts.push(i);
  if (pts.length > 80000) { const keep = 80000 / pts.length; pts = pts.filter(() => Math.random() < keep); }
  const n = pts.length;
  const xs = new Float32Array(n), ys = new Float32Array(n), tk = new Int16Array(n), th = new Float32Array(n);
  // Pixel centres in continuous image coordinates (pixel i spans [i, i+1))
  for (let k = 0; k < n; k++) {
    xs[k] = pts[k] % w + 0.5; ys[k] = ((pts[k] / w) | 0) + 0.5;
    th[k] = ori ? ori[pts[k]] : -1;
    tk[k] = ori ? Math.round(th[k] / Math.PI * NT) % NT : -1;
  }
  const D = Math.ceil(Math.hypot(w, h)), NR = 2 * D + 1;
  const acc = new Int32Array(NT * NR);
  const SPREAD = 5; // +-2.5 deg around the pixel's own direction
  const vote = (k, s) => {
    const x = xs[k], y = ys[k];
    if (tk[k] < 0) { for (let t = 0; t < NT; t++) acc[t * NR + Math.round(x * COS[t] + y * SIN[t]) + D] += s; return; }
    for (let d = -SPREAD; d <= SPREAD; d++) {
      const t = (tk[k] + d + NT) % NT;
      acc[t * NR + Math.round(x * COS[t] + y * SIN[t]) + D] += s;
    }
  };
  for (let k = 0; k < n; k++) vote(k, 1);
  const used = new Uint8Array(n);
  const lines = [];
  const diag = Math.hypot(w, h), minLen = Math.max(minVotes, 0.03 * diag), bridge = 0.05 * diag;
  const angTol = 12 * Math.PI / 180;
  for (let it = 0; it < 400 && lines.length < maxLines; it++) {
    let best = 0, bi = -1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best) { best = acc[i]; bi = i; }
    if (best < minVotes) break;
    const t = Math.floor(bi / NR), rho = bi % NR - D;
    let L = [COS[t], SIN[t], -rho];
    let sup = [];
    for (let pass = 0; pass < 3; pass++) {
      const nTh = Math.atan2(L[1], L[0]);
      sup = [];
      for (let k = 0; k < n; k++) {
        if (used[k] || Math.abs(L[0] * xs[k] + L[1] * ys[k] + L[2]) > 1.5) continue;
        if (th[k] >= 0) { let d = Math.abs(th[k] - nTh) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; if (d > angTol) continue; }
        sup.push(k);
      }
      if (sup.length < 3) break;
      const f = fitLine(sup.map(k => [xs[k], ys[k]]));
      if (f) L = f;
    }
    // Continuity: 1-px bins along the line that hold a line pixel; strokes broken by short gaps
    // (players, net posts, wear) are bridged
    const dir = [-L[1], L[0]];
    const proj = sup.map(k => xs[k] * dir[0] + ys[k] * dir[1]);
    const bins = [...new Set(proj.map(Math.round))].sort((a, b) => a - b);
    const runs = [];
    for (let k = 0, s0 = 0; k <= bins.length; k++) {
      if (k === bins.length || bins[k] - bins[k - 1] > 4) { if (k > s0) runs.push({ a: bins[s0], b: bins[k - 1], n: k - s0 }); s0 = k; }
    }
    // Best chain of runs: bridged over gaps up to `bridge`, as long as the chain stays mostly solid
    let bestChain = null;
    for (let i0 = 0; i0 < runs.length; i0++) {
      let cnt = 0;
      for (let i1 = i0; i1 < runs.length; i1++) {
        if (i1 > i0 && runs[i1].a - runs[i1 - 1].b > bridge) break;
        cnt += runs[i1].n;
        const len = runs[i1].b - runs[i0].a + 1;
        if (cnt / len >= 0.5 && (!bestChain || cnt > bestChain.n)) bestChain = { a: runs[i0].a, b: runs[i1].b, n: cnt };
      }
    }
    if (!bestChain || bestChain.n < minLen) {
      // Not a stroke: take this direction out and let the next peak through
      acc[bi] = 0;
      continue;
    }
    const inChain = sup.filter((k, j) => proj[j] >= bestChain.a - 0.5 && proj[j] <= bestChain.b + 0.5);
    for (const k of inChain) { used[k] = 1; vote(k, -1); }
    const foot = [-L[0] * L[2], -L[1] * L[2]];
    lines.push({ L, votes: bestChain.n, a: [foot[0] + dir[0] * bestChain.a, foot[1] + dir[1] * bestChain.a], b: [foot[0] + dir[0] * bestChain.b, foot[1] + dir[1] * bestChain.b], px: inChain.map(k => pts[k]) });
  }
  return mergeLines(lines);
}

// One painted line can come back several times: parallel peaks across a thick near line, or pieces
// cut apart by the net posts and the players. Merge lines that are nearly the same line.
function mergeLines(lines) {
  const out = [];
  for (const l of lines.slice().sort((a, b) => b.votes - a.votes)) {
    const dist = (L, p) => Math.abs(L[0] * p[0] + L[1] * p[1] + L[2]);
    const same = out.find(o => Math.abs(o.L[0] * l.L[0] + o.L[1] * l.L[1]) > Math.cos(1.5 * Math.PI / 180) && dist(o.L, l.a) < 6 && dist(o.L, l.b) < 6);
    if (!same) { out.push({ ...l }); continue; }
    // Extend the kept line over the union of both extents
    const dir = [-same.L[1], same.L[0]];
    const ts = [same.a, same.b, l.a, l.b].map(p => p[0] * dir[0] + p[1] * dir[1]);
    const foot = [-same.L[0] * same.L[2], -same.L[1] * same.L[2]];
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    same.a = [foot[0] + dir[0] * t0, foot[1] + dir[1] * t0]; same.b = [foot[0] + dir[0] * t1, foot[1] + dir[1] * t1];
    same.votes += l.votes;
    if (same.px && l.px) same.px = same.px.concat(l.px);
  }
  return out;
}

// ---------- 3. model fitting ----------
const T_Y = LINE_Y, L_X = LINE_X;

function samplePoints(step) {
  const pts = [];
  for (const [x1, y1, x2, y2] of LINES) {
    const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(2, Math.round(len / step));
    for (let k = 0; k <= n; k++) pts.push([x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n]);
  }
  return pts;
}
const COARSE = samplePoints(1.0), FINE = samplePoints(0.25);

function scoreH(H, mask, w, h, pts) {
  let s = 0;
  for (const [x, y] of pts) {
    const wq = H[6] * x + H[7] * y + H[8];
    if (wq <= 0) return -1e9;
    const u = (H[0] * x + H[1] * y + H[2]) / wq, v = (H[3] * x + H[4] * y + H[5]) / wq;
    if (u < 1 || v < 1 || u >= w - 1 || v >= h - 1) continue;
    s += mask[(v | 0) * w + (u | 0)] ? 1 : -0.5;
  }
  return s;
}

// Group lines by vanishing point: the two court directions each converge to one point (possibly at
// infinity, possibly inside the frame — so image angle alone cannot separate them).
const lineDir = l => [-l.L[1], l.L[0]];
const mid = l => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
const atInfinity = (v, scale) => Math.abs(v[2]) * scale < 1e-6 * Math.hypot(v[0], v[1]);
function towards(l, v, scale) {
  // Unit direction from the line midpoint to v (homogeneous), or the direction of v at infinity
  const m = mid(l);
  let tx, ty;
  if (atInfinity(v, scale)) { tx = v[0]; ty = v[1]; }
  else { tx = v[0] / v[2] - m[0]; ty = v[1] / v[2] - m[1]; }
  const n = Math.hypot(tx, ty) || 1;
  return [tx / n, ty / n];
}
function consistent(l, v, scale, cosMin) {
  const d = lineDir(l), t = towards(l, v, scale);
  return Math.abs(d[0] * t[0] + d[1] * t[1]) > cosMin;
}
function bestVP(lines, scale) {
  const cosMin = Math.cos(2 * Math.PI / 180);
  let best = null;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i].L, b = lines[j].L;
    let v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const n = Math.hypot(...v); if (!n) continue;
    v = v.map(x => x / n);
    let s = 0; const members = [];
    for (const l of lines) if (consistent(l, v, scale, cosMin)) { s += l.votes; members.push(l); }
    if (members.length >= 2 && (!best || s > best.s)) best = { v, s, members };
  }
  return best;
}
// Order a pencil of lines around its vanishing point (or by offset when they are parallel).
function orderFamily(fam, v, scale) {
  let keyed;
  if (atInfinity(v, scale) || Math.hypot(v[0] / v[2], v[1] / v[2]) > 50 * scale) {
    const d = atInfinity(v, scale) ? [v[0], v[1]] : [v[0] / v[2], v[1] / v[2]];
    const n = Math.hypot(...d) || 1, nx = -d[1] / n, ny = d[0] / n;
    keyed = fam.map(l => { const m = mid(l); return { l, key: m[0] * nx + m[1] * ny }; });
  } else {
    const vx = v[0] / v[2], vy = v[1] / v[2];
    keyed = fam.map(l => { const m = mid(l); return { l, key: Math.atan2(m[1] - vy, m[0] - vx) }; });
    // Cut the circle at the largest gap so the order is monotonic
    keyed.sort((a, b) => a.key - b.key);
    let gap = -1, at = 0;
    for (let k = 0; k < keyed.length; k++) {
      const g = (k + 1 < keyed.length ? keyed[k + 1].key : keyed[0].key + 2 * Math.PI) - keyed[k].key;
      if (g > gap) { gap = g; at = (k + 1) % keyed.length; }
    }
    keyed = keyed.slice(at).concat(keyed.slice(0, at).map(o => ({ ...o, key: o.key + 2 * Math.PI })));
  }
  return keyed.sort((a, b) => a.key - b.key).map(o => o.l);
}
function vpFamilies(lines, w, h) {
  const scale = Math.hypot(w, h);
  const top = lines.slice().sort((a, b) => b.votes - a.votes).slice(0, 18);
  const A = bestVP(top, scale);
  if (!A) return null;
  const B = bestVP(top.filter(l => !A.members.includes(l)), scale);
  if (!B) return null;
  const pick = F => orderFamily(F.members.slice().sort((a, b) => b.votes - a.votes).slice(0, 8), F.v, scale);
  return [pick(A), pick(B)];
}

// How far a homography is from a camera pose with focal length f: with the right intrinsics the
// first two rotation columns are orthogonal and of equal length.
function poseError(H, f, cx, cy) {
  const a1 = (H[0] - cx * H[6]) / f, a2 = (H[3] - cy * H[6]) / f, a3 = H[6];
  const b1 = (H[1] - cx * H[7]) / f, b2 = (H[4] - cy * H[7]) / f, b3 = H[7];
  const n1 = Math.hypot(a1, a2, a3), n2 = Math.hypot(b1, b2, b3);
  if (!n1 || !n2) return Infinity;
  const cos = (a1 * b1 + a2 * b2 + a3 * b3) / (n1 * n2), lr = Math.log(n1 / n2);
  return cos * cos + lr * lr;
}
// The focal length a court homography implies (principal point at the image centre). The preset is
// only a starting point: phone video is cropped for stabilisation (an iPhone "26 mm" main camera
// records 1080p like a ~31 mm lens), the browser may crop too, and the lens in use may not be the
// one selected. range: [lo, hi] in pixels. Returns { f, e, sharp }: e = remaining inconsistency,
// sharp = how much worse 10 % either side fits. A flat valley (court lines parallel to the picture)
// does not tell the focal length: the preset intr.f is returned with sharp = 0.
const SHARP = 0.002;
function sharpness(H, f, intr) {
  const e = poseError(H, f, intr.cx, intr.cy);
  return { f, e, sharp: Math.min(poseError(H, f * 1.1, intr.cx, intr.cy), poseError(H, f / 1.1, intr.cx, intr.cy)) - e };
}
// Fast version for hypotheses: Zhang's two constraints solved in closed form for 1/f^2.
function quickFocal(H, intr, range) {
  const f0 = intr.f, cx = intr.cx, cy = intr.cy;
  const g11 = (H[0] - cx * H[6]) / f0, g21 = (H[3] - cy * H[6]) / f0, g31 = H[6];
  const g12 = (H[1] - cx * H[7]) / f0, g22 = (H[4] - cy * H[7]) / f0, g32 = H[7];
  const a1 = g11 * g12 + g21 * g22, b1 = g31 * g32;
  const a2 = g11 * g11 + g21 * g21 - g12 * g12 - g22 * g22, b2 = g31 * g31 - g32 * g32;
  const den = a1 * a1 + a2 * a2;
  if (den > 0) {
    const x = -(a1 * b1 + a2 * b2) / den; // = (f0 / f)^2
    if (x > 0) {
      const f = f0 / Math.sqrt(x);
      if (f >= range[0] && f <= range[1]) {
        const r = sharpness(H, f, intr);
        if (r.sharp > SHARP) return r;
      }
    }
  }
  return { f: f0, e: poseError(H, f0, cx, cy), sharp: 0 };
}
// Precise version (refined homographies): log grid over the range, then golden-section search.
export function focalFromH(H, intr, range = [0.5 * intr.f, 2 * intr.f]) {
  const n = Math.max(8, Math.ceil(Math.log(range[1] / range[0]) / 0.03));
  const E = x => poseError(H, Math.exp(x), intr.cx, intr.cy);
  const x0 = Math.log(range[0]), dx = Math.log(range[1] / range[0]) / n;
  let bi = 0, be = Infinity;
  for (let i = 0; i <= n; i++) { const e = E(x0 + i * dx); if (e < be) { be = e; bi = i; } }
  if (bi > 0 && bi < n) {
    let lo = x0 + (bi - 1) * dx, hi = x0 + (bi + 1) * dx;
    const g = (Math.sqrt(5) - 1) / 2;
    let c = hi - g * (hi - lo), d = lo + g * (hi - lo), ec = E(c), ed = E(d);
    for (let it = 0; it < 24; it++) {
      if (ec < ed) { hi = d; d = c; ed = ec; c = hi - g * (hi - lo); ec = E(c); }
      else { lo = c; c = d; ec = ed; d = lo + g * (hi - lo); ed = E(d); }
    }
    const r = sharpness(H, Math.exp((lo + hi) / 2), intr);
    if (r.sharp > SHARP / 4) return r;
  }
  return { f: intr.f, e: poseError(H, intr.f, intr.cx, intr.cy), sharp: 0 };
}

// Pose sanity check for a hypothesis: some focal length in the range makes it a real camera pose,
// with the camera above the ground within a sensible distance of the court. Returns that focal
// length or 0.
function plausiblePose(H, intr, range) {
  const { f, e } = quickFocal(H, intr, range);
  if (e > 0.06) return 0;
  const cx = intr.cx, cy = intr.cy;
  const m = [(H[0] - cx * H[6]) / f, (H[1] - cx * H[7]) / f, (H[2] - cx * H[8]) / f,
             (H[3] - cy * H[6]) / f, (H[4] - cy * H[7]) / f, (H[5] - cy * H[8]) / f, H[6], H[7], H[8]];
  const r1 = [m[0], m[3], m[6]], r2 = [m[1], m[4], m[7]], t = [m[2], m[5], m[8]];
  const n1 = Math.hypot(...r1), n2 = Math.hypot(...r2);
  let lam = 2 / (n1 + n2);
  if (t[2] * lam < 0) lam = -lam;
  const a = r1.map(v => v * lam), b = r2.map(v => v * lam), tt = t.map(v => v * lam);
  const c3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const Cx = -(a[0] * tt[0] + a[1] * tt[1] + a[2] * tt[2]);
  const Cy = -(b[0] * tt[0] + b[1] * tt[1] + b[2] * tt[2]);
  const Cz = -(c3[0] * tt[0] + c3[1] * tt[1] + c3[2] * tt[2]);
  return Cz > 0.4 && Cz < 30 && Math.abs(Cx) < 45 && Math.abs(Cy) < 55 ? f : 0;
}

// Find the court in a processing image. intr: intrinsics scaled to this image; range: the focal
// lengths (px) to consider. Returns { H, score, hyps, lines, mask } (H: court -> processing pixels).
export function findCourt(img, intr, { range = [0.5 * intr.f, 2 * intr.f] } = {}) {
  const lc = luminance(img);
  const { w, h } = lc;
  const ev = lineEvidence(lc);
  const mask = ev.mask;
  const lines = houghLines(ev, w, h);
  if (lines.length < 4) return { fail: 'lines', lines, mask };
  // Hypotheses are scored on the pixels of the straight strokes found, not on all ridge pixels
  // (texture would reward courts placed over it)
  const strokes = new Uint8Array(w * h);
  for (const l of lines) for (const i of l.px || []) strokes[i] = 1;
  const dm = dilate(strokes, w, h);
  const fams = vpFamilies(lines, w, h);
  if (!fams) return { fail: 'families', lines, mask };
  const [A, B] = fams;
  const cands = [];
  for (const [Tf, Lf] of [[A, B], [B, A]]) {
    const X = Tf.map(t => Lf.map(l => intersectLines(t.L, l.L)));
    for (let i = 0; i < Tf.length; i++) for (let j = i + 1; j < Tf.length; j++) {
      for (let k = 0; k < Lf.length; k++) for (let l = k + 1; l < Lf.length; l++) {
        const q = [X[i][k], X[i][l], X[j][l], X[j][k]];
        if (q.some(p => !p || Math.abs(p[0]) > 4 * w || Math.abs(p[1]) > 4 * h)) continue;
        for (let m = 0; m < 4; m++) for (let nn = m + 1; nn < 4; nn++) {
          for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) {
            for (const [ym, yn] of [[T_Y[m], T_Y[nn]], [T_Y[nn], T_Y[m]]]) {
              for (const [xa, xb] of [[L_X[a], L_X[b]], [L_X[b], L_X[a]]]) {
                const src = [[xa, ym], [xb, ym], [xb, yn], [xa, yn]];
                const H = homography4(src, q);
                if (!H) continue;
                const f = plausiblePose(H, intr, range);
                if (!f) continue;
                const s = scoreH(H, dm, w, h, COARSE);
                if (s > 6) cands.push({ H, s, f });
              }
            }
          }
        }
      }
    }
  }
  if (!cands.length) return { fail: 'model', lines, mask };
  cands.sort((a, b) => b.s - a.s);
  const fine = cands.slice(0, 300).map(c => ({ H: c.H, f: c.f, score: scoreH(c.H, dm, w, h, FINE) })).sort((a, b) => b.score - a.score);
  // Distinct hypotheses (different court placements), best first. The court looks the same turned
  // by 180°, so a hypothesis and its rotation are one placement.
  const corners = H => [[-5.485, -11.885], [5.485, -11.885], [5.485, 11.885], [-5.485, 11.885]].map(([x, y]) => applyH(H, x, y));
  const near = (k, m) => k.every((p, i) => Math.hypot(p[0] - m[i][0], p[1] - m[i][1]) < 8);
  const distinct = [];
  for (const c of fine) {
    const k = corners(c.H), kr = [k[2], k[3], k[0], k[1]];
    if (distinct.some(d => near(d.k, k) || near(d.k, kr))) continue;
    distinct.push({ ...c, k });
    if (distinct.length >= 8) break;
  }
  return { H: distinct[0].H, score: distinct[0].score, hyps: distinct, lines, mask, ev, lc, w, h };
}

// ---------- 4. refinement ----------
// Pixels near the white net cord (projected from the current pose): line samples there would latch
// on to the tape instead of the court line behind or in front of it.
function netMask(cam, w, h) {
  const m = new Uint8Array(w * h);
  if (!cam) return m;
  const pts = [];
  for (let k = 0; k <= 64; k++) {
    const x = -6.4 + 12.8 * k / 64;
    const top = netHeightAt(x), a = cam.project([x, 0, top]), b = cam.project([x, 0, top - 0.07]);
    if (a[2] > 0.2 && b[2] > 0.2) pts.push([a, b]);
  }
  for (let k = 1; k < pts.length; k++) {
    const [a0, b0] = pts[k - 1], [a1] = pts[k];
    const rad = Math.max(3, Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) + 3);
    const len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), steps = Math.max(1, Math.ceil(len * 2));
    for (let s = 0; s <= steps; s++) {
      const cx = a0[0] + (a1[0] - a0[0]) * s / steps - 0.5, cy = a0[1] + (a1[1] - a0[1]) * s / steps - 0.5 + rad / 2;
      const r = Math.ceil(rad);
      for (let dy = -r; dy <= r; dy++) {
        const y = Math.round(cy + dy); if (y < 0 || y >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.round(cx + dx); if (x < 0 || x >= w) continue;
          if (dx * dx + dy * dy <= rad * rad) m[y * w + x] = 1;
        }
      }
    }
  }
  return m;
}

// Search for the line ridge along the normal of each projected court line; returns observations
// { P: court point, q: image point, li: line index }.
function collectLinePoints(H, lum, w, h, radius, nm, ok) {
  const obs = [];
  LINES.forEach(([x1, y1, x2, y2, , lw], li) => {
    const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(4, Math.round(len / 0.12));
    for (let k = 1; k < n; k++) {
      const P = [x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n];
      const p = applyH(H, P[0], P[1]);
      if (!(p[0] > radius + 12 && p[1] > radius + 12 && p[0] < w - radius - 12 && p[1] < h - radius - 12)) continue;
      const P2 = [P[0] + (x2 - x1) / len * 0.05, P[1] + (y2 - y1) / len * 0.05];
      const q = applyH(H, P2[0], P2[1]);
      let dx = q[0] - p[0], dy = q[1] - p[1]; const dl = Math.hypot(dx, dy); if (!dl) continue;
      const nx = -dy / dl, ny = dx / dl;
      // Projected line width (px) to set the ridge test distance
      const pw = applyH(H, P[0] + (x2 === x1 ? lw : 0), P[1] + (y2 === y1 ? lw : 0));
      const wpx = Math.hypot(pw[0] - p[0], pw[1] - p[1]);
      const tau = Math.min(12, Math.max(2, Math.round(wpx * 0.8 + 2)));
      let best = 0, bs = 0, nearNet = false;
      const prof = [];
      const px = p[0] - 0.5, py = p[1] - 0.5; // sampling in pixel-index coordinates
      for (let s = -radius; s <= radius; s++) {
        const x = Math.round(px + nx * s), y = Math.round(py + ny * s);
        const i = y * w + x;
        if (nm && nm[i]) { nearNet = true; break; }
        const g = lum[i];
        const a = lum[Math.round(y + ny * tau) * w + Math.round(x + nx * tau)], b = lum[Math.round(y - ny * tau) * w + Math.round(x - nx * tau)];
        const r = g - Math.max(a, b);
        prof.push(r);
        if (r > best) { best = r; bs = s; }
      }
      if (nearNet) continue;
      obs.tried = (obs.tried || 0) + 1;
      const at = Math.round(py + ny * bs) * w + Math.round(px + nx * bs);
      if (best < Math.max(10, 0.08 * lum[at])) continue;
      // The ridge must be a line pixel (stands out from the texture around it), or a clay brush mark
      // next to a faint line would do
      if (ok && !ok[at]) continue;
      // Sub-pixel: centroid of the ridge above half its height
      let sw = 0, ss = 0;
      for (let s = -radius; s <= radius; s++) { const r = prof[s + radius]; if (r > best * 0.5 && Math.abs(s - bs) <= tau) { sw += r; ss += r * s; } }
      const off = sw ? ss / sw : bs;
      obs.push({ P, q: [p[0] + nx * off, p[1] + ny * off], li });
    }
  });
  return obs;
}

// Observations from the straight strokes found by the Hough stage: a stroke that runs along a projected
// court line (same direction, within tol px over its whole length) belongs to it. Strokes are clean
// (texture does not make them), so they pull a line back that the ridge search has lost — under a
// player, at the picture edge, or a few pixels further than the search radius.
function strokeObs(H, strokes, tol, nm, w) {
  const Hi = inv33(H);
  if (!Hi) return [];
  const model = LINES.map(([x1, y1, x2, y2]) => {
    const a = applyH(H, x1, y1), b = applyH(H, x2, y2);
    // both ends in front of the camera (homogeneous w > 0)
    if (!(H[6] * x1 + H[7] * y1 + H[8] > 0 && H[6] * x2 + H[7] * y2 + H[8] > 0)) return null;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1) return null;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    return { a, u, len };
  });
  const out = [];
  for (const st of strokes) {
    const sd = [st.b[0] - st.a[0], st.b[1] - st.a[1]], sl = Math.hypot(...sd);
    if (sl < 1) continue;
    // Nearest court line (mean distance of the stroke's ends and middle); skipped when two court
    // lines are about as near (far, thin lines close together)
    let best = null, second = Infinity;
    model.forEach((m, li) => {
      if (!m) return;
      if (Math.abs(sd[0] * m.u[0] + sd[1] * m.u[1]) / sl < Math.cos(4 * Math.PI / 180)) return;
      let sum = 0, overlap = 0;
      for (const p of [st.a, st.b, [(st.a[0] + st.b[0]) / 2, (st.a[1] + st.b[1]) / 2]]) {
        const dx = p[0] - m.a[0], dy = p[1] - m.a[1];
        sum += Math.abs(dx * m.u[1] - dy * m.u[0]) / 3;
        const t = dx * m.u[0] + dy * m.u[1];
        if (t > -0.05 * m.len && t < 1.05 * m.len) overlap++;
      }
      if (overlap < 2) return;
      if (!best || sum < best.d) { if (best) second = best.d; best = { li, d: sum }; }
      else second = Math.min(second, sum);
    });
    if (!best || best.d > tol || second < 2 * best.d + 2) continue;
    // One observation per 4 px along the stroke: centroid of its pixels there
    const [x1, y1, x2, y2] = LINES[best.li];
    const u = [sd[0] / sl, sd[1] / sl], bins = new Map();
    for (const i of st.px) {
      if (nm && nm[i]) continue;
      const x = i % w + 0.5, y = ((i / w) | 0) + 0.5, k = Math.round(((x - st.a[0]) * u[0] + (y - st.a[1]) * u[1]) / 4);
      const g = bins.get(k) || [0, 0, 0];
      g[0] += x; g[1] += y; g[2]++;
      bins.set(k, g);
    }
    for (const [x, y, n] of bins.values()) {
      if (n < 2) continue;
      const q = [x / n, y / n], G = applyH(Hi, q[0], q[1]);
      const P = x1 === x2 ? [x1, Math.max(Math.min(y1, y2), Math.min(Math.max(y1, y2), G[1]))] : [Math.max(Math.min(x1, x2), Math.min(Math.max(x1, x2), G[0])), y1];
      out.push({ P, q, li: best.li, stroke: true });
    }
  }
  return out;
}

function lineFitH(H, obs) {
  // Robust line per court line, then homography from all intersections of the refitted lines
  const fitted = LINES.map((_, li) => {
    let pts = obs.filter(o => o.li === li).map(o => o.q);
    if (pts.length < 6) return null;
    let L = fitLine(pts);
    for (let it = 0; it < 2 && L; it++) {
      const r = pts.map(p => Math.abs(L[0] * p[0] + L[1] * p[1] + L[2]));
      const sorted = r.slice().sort((a, b) => a - b), lim = Math.max(1.5, 3 * sorted[sorted.length >> 1]);
      pts = pts.filter((_, i) => r[i] <= lim);
      if (pts.length < 6) return null;
      L = fitLine(pts);
    }
    return L;
  });
  const src = [], dst = [];
  LINES.forEach((a, i) => {
    if (a[4] !== 't' || !fitted[i]) return;
    LINES.forEach((b, j) => {
      if (b[4] !== 'l' || !fitted[j]) return;
      const p = intersectLines(fitted[i], fitted[j]);
      if (!p) return;
      src.push([b[0], a[1]]); dst.push(p);
    });
  });
  if (src.length < 4) return H;
  return homographyDLT(src, dst) || H;
}

// Pose (and optionally focal length) by Levenberg–Marquardt on point-to-projected-line distances,
// with Huber-style reweighting against stray line pixels.
function refinePose(cam, obs, { freeFocal = false } = {}) {
  if (obs.length < 8) return null;
  const p0 = [...vecFromRot(cam.R), ...cam.t, ...(freeFocal ? [Math.log(cam.f)] : [])];
  const make = p => new CameraModel({ ...cam.intrinsics(), f: freeFocal ? Math.exp(p[6]) : cam.f, R: rotFromVec([p[0], p[1], p[2]]), t: [p[3], p[4], p[5]] });
  const dirs = LINES.map(([x1, y1, x2, y2]) => { const l = Math.hypot(x2 - x1, y2 - y1); return [(x2 - x1) / l * 0.3, (y2 - y1) / l * 0.3]; });
  const dists = p => {
    const c = make(p), r = new Float64Array(obs.length);
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i], d = dirs[o.li];
      const a = c.project([o.P[0] - d[0], o.P[1] - d[1], 0]), b = c.project([o.P[0] + d[0], o.P[1] + d[1], 0]);
      if (a[2] <= 0 || b[2] <= 0) return null;
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      r[i] = ((o.q[0] - a[0]) * dy - (o.q[1] - a[1]) * dx) / l;
    }
    return r;
  };
  let weights = new Float64Array(obs.length).fill(1);
  const resid = p => { const r = dists(p); if (r) for (let i = 0; i < r.length; i++) r[i] *= weights[i]; return r; };
  const steps = [1e-5, 1e-5, 1e-5, 1e-4, 1e-4, 1e-4, 1e-5].slice(0, p0.length);
  let res = null, p = p0;
  for (let pass = 0; pass < 3; pass++) {
    res = levenbergMarquardt(resid, p, steps, { maxIter: 30 });
    if (!res) return null;
    p = Array.from(res.p);
    const d = dists(p);
    weights = Float64Array.from(d, e => Math.abs(e) <= 1.5 ? 1 : Math.sqrt(1.5 / Math.abs(e)));
    // A whole line that sits off the model (a faint far line pulled by a nearby colour edge) is
    // down-weighted as a unit; per-point weights cannot see a consistent offset.
    const sum = new Float64Array(LINES.length), cnt = new Float64Array(LINES.length);
    obs.forEach((o, i) => { if (Math.abs(d[i]) < 4) { sum[o.li] += d[i]; cnt[o.li]++; } });
    obs.forEach((o, i) => { const m = cnt[o.li] ? Math.abs(sum[o.li] / cnt[o.li]) : 0; if (m > 0.6) weights[i] *= 0.6 / m; });
  }
  const raw = dists(p);
  let ss = 0, cnt = 0; for (const e of raw) if (Math.abs(e) < 4) { ss += e * e; cnt++; }
  const out = { cam: make(p), rms: Math.sqrt(ss / Math.max(1, cnt)), inliers: cnt, n: obs.length };
  if (freeFocal && res.JtJ) {
    const cov = spdInverse(res.JtJ, 7);
    const s2 = Math.max(1, res.cost / Math.max(1, obs.length - 7));
    if (cov) out.fSigma = Math.exp(p[6]) * Math.sqrt(Math.max(0, cov[48]) * s2);
  }
  return out;
}

// Rotate the court by 180° if needed so the camera sits on the near half (y <= 0).
// The court looks the same turned by 180°, so the frame is a convention: the camera on the near half
// (y <= 0) — or, for a camera level with the net, on the +x side.
export function canonical(cam) {
  const [x, y] = cam.C;
  const flip = Math.abs(y) > 1 ? y > 0 : x < 0;
  if (!flip) return cam;
  const R = cam.R, Rz = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
  return cam.withPose(mul33(R, Rz), cam.t);
}

// Refine a rough calibration against the image. cam: CameraModel in processing-image pixels; lc: the
// luminance planes (luminance(img)). The focal length is measured along with the pose when the view
// pins it down (focal: { f, sigma }); otherwise the given one is kept.
export function refineCourt(cam, lc, { estimateFocal = true, ev = null, strokes = null, presetF = cam.f, range = [0.5 * presetF, 2 * presetF] } = {}) {
  const { lum, w, h } = lc;
  ev = ev || lineEvidence(lc);
  strokes = strokes || houghLines(ev, w, h);
  const ok = dilate(ev.strong, w, h);
  let H = cam.groundH();
  let obs = [];
  const keyPx = H => KEYPOINTS.map(([x, y]) => applyH(H, x, y));
  const camOf = H => { const ps = poseFromHomography(H, cam.f, cam.cx, cam.cy); return ps ? cam.withPose(ps.R, ps.t) : null; };
  for (const radius of [14, 8, 5, 4]) {
    const nm = netMask(camOf(H), w, h);
    obs = collectLinePoints(H, lum, w, h, radius, nm, ok).concat(strokeObs(H, strokes, radius + 6, nm, w));
    if (obs.length < 12) return null;
    const H2 = lineFitH(H, obs);
    // Refuse jumps larger than the search radius (a wrong line was latched on to)
    const a = keyPx(H), b = keyPx(H2);
    let jump = 0;
    a.forEach((p, i) => { if (p[0] > 0 && p[1] > 0 && p[0] < w && p[1] < h) jump = Math.max(jump, Math.hypot(p[0] - b[i][0], p[1] - b[i][1])); });
    if (!(jump <= radius * 1.5 + 2)) continue;
    H = H2;
  }
  // Focal length from the refined homography (many line points, so its own minimum is trusted when
  // it is clear-cut)
  let f0 = cam.f;
  if (estimateFocal) {
    const fh = focalFromH(H, cam.withIntrinsics({ f: presetF }), range);
    f0 = fh.f;
  }
  const pose = poseFromHomography(H, f0, cam.cx, cam.cy);
  if (!pose) return null;
  const settle = (c, freeFocal) => {
    // Alternate: collect line points around the current pose, optimise the pose, until it settles
    let fixed = null;
    for (let it = 0; it < 8; it++) {
      const G = c.groundH(), nm = netMask(c, w, h), radius = [6, 5, 4][it] || 3;
      // Strokes bring lost lines back; the last iterations use the sub-pixel ridge centres only
      obs = collectLinePoints(G, lum, w, h, radius, nm, ok);
      if (it < 3) obs = obs.concat(strokeObs(G, strokes, 12, nm, w));
      // The focal length stays at the homography's value while lines are still being matched (a free
      // focal length can follow a wrong match), and is freed once the matches have settled
      const next = refinePose(c, obs, { freeFocal: freeFocal && it >= 3 });
      if (!next || next.cam.C[2] < 0.3) break;
      const moved = Math.hypot(next.cam.C[0] - c.C[0], next.cam.C[1] - c.C[1], next.cam.C[2] - c.C[2]) + Math.abs(Math.log(next.cam.f / c.f)) * 10;
      fixed = next; c = next.cam;
      if (moved < 0.002 && it >= 3) break;
    }
    return fixed;
  };
  let fixed = settle(new CameraModel({ ...cam.intrinsics(), f: f0, R: pose.R, t: pose.t }), estimateFocal);
  if (!fixed) return null;
  let focal = null;
  if (estimateFocal) {
    // Measured focal length and its uncertainty; when the view does not determine it, go back to the
    // given one (a free focal length would only soak up noise)
    if (fixed.fSigma != null && isFinite(fixed.fSigma) && fixed.fSigma < 0.03 * fixed.cam.f) focal = { f: fixed.cam.f, sigma: fixed.fSigma, rms: fixed.rms };
    // A measured focal length that agrees with the given one: the given one is exact, the measurement
    // only as good as the lines (its error grows the farther the point is from the court plane)
    if (!focal || Math.abs(focal.f - presetF) < Math.max(3 * focal.sigma, 0.02 * presetF)) {
      const back = settle(fixed.cam.withIntrinsics({ f: presetF }), false);
      if (back) fixed = back;
    }
  }
  // Coverage: of the line samples this placement predicts inside the picture, the share that sit on a
  // painted line. A court shifted onto the wrong lines predicts lines where there are none.
  const fin = collectLinePoints(fixed.cam.groundH(), lum, w, h, 2, netMask(fixed.cam, w, h), ok);
  const best = canonical(fixed.cam);
  const out = { cam: best, rms: fixed.rms, inliers: fixed.inliers, coverage: fin.length / Math.max(1, fin.tried || 0), lines: new Set(obs.map(o => o.li)).size, focal };
  if (focal) out.camFree = best;
  return out;
}

// Full automatic calibration on a processing image. intr: intrinsics of the selected lens for this
// image size; focals: the focal lengths (px) of all the phone's lenses, so the court is found
// whichever lens is in use. The best few model hypotheses are refined; the one whose lines fit best
// wins.
export function autoCalibrate(img, intr, { focals = [] } = {}) {
  const all = [intr.f, ...focals];
  const range = [0.5 * Math.min(...all), 2 * Math.max(...all)];
  const found = findCourt(img, intr, { range });
  if (!found || !found.H) return { ok: false, reason: found?.fail || 'none', debug: found };
  let best = null;
  for (const hyp of found.hyps) {
    const pose = poseFromHomography(hyp.H, hyp.f || intr.f, intr.cx, intr.cy);
    if (!pose) continue;
    const cam0 = new CameraModel({ ...intr, f: hyp.f || intr.f, R: pose.R, t: pose.t });
    const ref = refineCourt(cam0, found.lc, { ev: found.ev, strokes: found.lines, presetF: intr.f, range });
    if (!ref) continue;
    const q = ref.inliers * ref.coverage * ref.coverage * Math.min(1, 1.5 / Math.max(ref.rms, 0.1));
    if (!best || q > best.q) best = { ...ref, q, score: hyp.score };
  }
  if (!best) return { ok: false, reason: 'refine', debug: found };
  return { ok: true, ...best, debug: found };
}
