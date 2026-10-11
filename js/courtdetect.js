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
import { homography4, homographyDLT, applyH, fitLine, intersectLines, levenbergMarquardt, rotFromVec, vecFromRot, mul33, spdInverse } from './linalg.js';
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

export function linePixels({ lum, chroma, w, h }) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i += 7) hist[lum[i]]++;
  let acc = 0, med = 0; const half = Math.ceil(lum.length / 7) / 2;
  for (; med < 255; med++) { acc += hist[med]; if (acc >= half) break; }
  const minL = Math.max(70, med + 8);
  const mask = new Uint8Array(w * h);
  const taus = [2, 4, 7, 11];
  for (let y = 11; y < h - 11; y++) {
    for (let x = 11; x < w - 11; x++) {
      const i = y * w + x, g = lum[i];
      if (g < minL || chroma[i] > 0.45 * g + 12) continue;
      const d = Math.max(10, 0.1 * g);
      for (const t of taus) {
        if ((g - lum[i - t] > d && g - lum[i + t] > d) || (g - lum[i - t * w] > d && g - lum[i + t * w] > d)) { mask[i] = 1; break; }
      }
    }
  }
  // Texture rejection (foliage, crowds, nets): keep pixels whose local gradients share one axis
  // (structure-tensor coherence), as they do across a painted line.
  const gx = new Int16Array(w * h), gy = new Int16Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - 1] + lum[i + w - 1]);
    gy[i] = (lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1]);
  }
  const out = new Uint8Array(w * h);
  const r = 3;
  for (let y = 11; y < h - 11; y++) for (let x = 11; x < w - 11; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    let jxx = 0, jxy = 0, jyy = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = i + dy * w + dx, a = gx[k], b = gy[k];
      jxx += a * a; jxy += a * b; jyy += b * b;
    }
    const tr = jxx + jyy;
    if (!tr) continue;
    const coh = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / tr;
    if (coh > 0.5) out[i] = 1;
  }
  return out;
}

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

export function houghLines(mask, w, h, { maxLines = 24, minVotes = 30 } = {}) {
  let pts = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) pts.push(i);
  if (pts.length > 60000) { const keep = 60000 / pts.length; pts = pts.filter(() => Math.random() < keep); }
  const n = pts.length;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  // Pixel centres in continuous image coordinates (pixel i spans [i, i+1))
  for (let k = 0; k < n; k++) { xs[k] = pts[k] % w + 0.5; ys[k] = ((pts[k] / w) | 0) + 0.5; }
  const D = Math.ceil(Math.hypot(w, h)), NR = 2 * D + 1;
  const acc = new Int32Array(NT * NR);
  const vote = (k, s) => { const x = xs[k], y = ys[k]; for (let t = 0; t < NT; t++) acc[t * NR + Math.round(x * COS[t] + y * SIN[t]) + D] += s; };
  for (let k = 0; k < n; k++) vote(k, 1);
  const used = new Uint8Array(n);
  const lines = [];
  for (let it = 0; it < maxLines; it++) {
    let best = 0, bi = -1;
    for (let i = 0; i < acc.length; i++) if (acc[i] > best) { best = acc[i]; bi = i; }
    if (best < minVotes) break;
    const t = Math.floor(bi / NR), rho = bi % NR - D;
    let L = [COS[t], SIN[t], -rho];
    let sup = [];
    for (let pass = 0; pass < 2; pass++) {
      sup = [];
      for (let k = 0; k < n; k++) if (!used[k] && Math.abs(L[0] * xs[k] + L[1] * ys[k] + L[2]) <= 1.5) sup.push(k);
      if (sup.length < 3) break;
      const f = fitLine(sup.map(k => [xs[k], ys[k]]));
      if (f) L = f;
    }
    for (const k of sup) { used[k] = 1; vote(k, -1); }
    if (sup.length < minVotes) { acc[bi] = 0; continue; }
    // Extent: longest run of support along the line with gaps < 25 px
    const dir = [-L[1], L[0]];
    const proj = sup.map(k => xs[k] * dir[0] + ys[k] * dir[1]).sort((a, b) => a - b);
    let bs = 0, be = 0, s = 0;
    for (let k = 1; k <= proj.length; k++) {
      if (k === proj.length || proj[k] - proj[k - 1] > 25) {
        if (k - s > be - bs) { bs = s; be = k; }
        s = k;
      }
    }
    if (be - bs < minVotes) continue;
    const p0 = proj[bs], p1 = proj[be - 1], foot = [-L[0] * L[2], -L[1] * L[2]];
    lines.push({ L, votes: be - bs, a: [foot[0] + dir[0] * p0, foot[1] + dir[1] * p0], b: [foot[0] + dir[0] * p1, foot[1] + dir[1] * p1] });
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

// Cheap pose sanity check for a hypothesis (no orthonormalisation): with the right intrinsics the
// first two rotation columns must be orthogonal and of equal length, and the camera must sit above
// the ground within a sensible distance of the court.
function plausiblePose(H, intr) {
  const f = intr.f, cx = intr.cx, cy = intr.cy;
  const m = [(H[0] - cx * H[6]) / f, (H[1] - cx * H[7]) / f, (H[2] - cx * H[8]) / f,
             (H[3] - cy * H[6]) / f, (H[4] - cy * H[7]) / f, (H[5] - cy * H[8]) / f, H[6], H[7], H[8]];
  const r1 = [m[0], m[3], m[6]], r2 = [m[1], m[4], m[7]], t = [m[2], m[5], m[8]];
  const n1 = Math.hypot(...r1), n2 = Math.hypot(...r2);
  if (!n1 || !n2) return false;
  const ratio = n1 / n2, cos = (r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / (n1 * n2);
  if (ratio < 0.7 || ratio > 1.43 || Math.abs(cos) > 0.3) return false;
  let lam = 2 / (n1 + n2);
  if (t[2] * lam < 0) lam = -lam;
  const a = r1.map(v => v * lam), b = r2.map(v => v * lam), tt = t.map(v => v * lam);
  const c3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const Cx = -(a[0] * tt[0] + a[1] * tt[1] + a[2] * tt[2]);
  const Cy = -(b[0] * tt[0] + b[1] * tt[1] + b[2] * tt[2]);
  const Cz = -(c3[0] * tt[0] + c3[1] * tt[1] + c3[2] * tt[2]);
  return Cz > 0.4 && Cz < 30 && Math.abs(Cx) < 45 && Math.abs(Cy) < 55;
}

// Find the court in a processing image. intr: intrinsics scaled to this image. Returns
// { H, score, lines, mask } (H: court -> processing pixels) or null.
export function findCourt(img, intr, { onProgress } = {}) {
  const lc = luminance(img);
  const { w, h } = lc;
  const mask = linePixels(lc);
  const dm = dilate(mask, w, h);
  const lines = houghLines(mask, w, h);
  if (lines.length < 4) return { fail: 'lines', lines, mask };
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
                if (!H || !plausiblePose(H, intr)) continue;
                const s = scoreH(H, dm, w, h, COARSE);
                if (s > 6) cands.push({ H, s });
              }
            }
          }
        }
      }
    }
  }
  if (!cands.length) return { fail: 'model', lines, mask };
  cands.sort((a, b) => b.s - a.s);
  const fine = cands.slice(0, 300).map(c => ({ H: c.H, score: scoreH(c.H, dm, w, h, FINE) })).sort((a, b) => b.score - a.score);
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
  return { H: distinct[0].H, score: distinct[0].score, hyps: distinct, lines, mask, lum: lc.lum, w, h };
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
function collectLinePoints(H, lum, w, h, radius, nm) {
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
      if (best < Math.max(10, 0.08 * lum[Math.round(py + ny * bs) * w + Math.round(px + nx * bs)])) continue;
      // Sub-pixel: centroid of the ridge above half its height
      let sw = 0, ss = 0;
      for (let s = -radius; s <= radius; s++) { const r = prof[s + radius]; if (r > best * 0.5 && Math.abs(s - bs) <= tau) { sw += r; ss += r * s; } }
      const off = sw ? ss / sw : bs;
      obs.push({ P, q: [p[0] + nx * off, p[1] + ny * off], li });
    }
  });
  return obs;
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
export function canonical(cam) {
  if (cam.C[1] <= 0) return cam;
  const R = cam.R, Rz = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
  return cam.withPose(mul33(R, Rz), cam.t);
}

// Refine a rough calibration against the image. cam: CameraModel in processing-image pixels.
export function refineCourt(cam, lum, w, h, { estimateFocal = true } = {}) {
  let H = cam.groundH();
  let obs = [];
  const keyPx = H => KEYPOINTS.map(([x, y]) => applyH(H, x, y));
  const camOf = H => { const ps = poseFromHomography(H, cam.f, cam.cx, cam.cy); return ps ? cam.withPose(ps.R, ps.t) : null; };
  for (const radius of [14, 8, 5, 4]) {
    obs = collectLinePoints(H, lum, w, h, radius, netMask(camOf(H), w, h));
    if (obs.length < 12) return null;
    const H2 = lineFitH(H, obs);
    // Refuse jumps larger than the search radius (a wrong line was latched on to)
    const a = keyPx(H), b = keyPx(H2);
    let jump = 0;
    a.forEach((p, i) => { if (p[0] > 0 && p[1] > 0 && p[0] < w && p[1] < h) jump = Math.max(jump, Math.hypot(p[0] - b[i][0], p[1] - b[i][1])); });
    if (!(jump <= radius * 1.5 + 2)) continue;
    H = H2;
  }
  const pose = poseFromHomography(H, cam.f, cam.cx, cam.cy);
  if (!pose) return null;
  let c = cam.withPose(pose.R, pose.t);
  // Alternate: collect line points around the current pose, optimise the pose, until it settles
  let fixed = null;
  for (let it = 0; it < 7; it++) {
    obs = collectLinePoints(c.groundH(), lum, w, h, it === 0 ? 5 : 3, netMask(c, w, h));
    const next = refinePose(c, obs);
    if (!next) break;
    const moved = Math.hypot(next.cam.C[0] - c.C[0], next.cam.C[1] - c.C[1], next.cam.C[2] - c.C[2]);
    fixed = next; c = next.cam;
    if (moved < 0.002) break;
  }
  if (!fixed) return null;
  // Coverage: of the line samples this placement predicts inside the picture, the share that sit on a
  // painted line. A court shifted onto the wrong lines predicts lines where there are none.
  const out = { cam: canonical(fixed.cam), rms: fixed.rms, inliers: fixed.inliers, coverage: fixed.inliers / Math.max(1, obs.tried || obs.length), lines: new Set(obs.map(o => o.li)).size };
  if (estimateFocal) {
    const free = refinePose(fixed.cam, obs, { freeFocal: true });
    if (free && free.fSigma != null && isFinite(free.fSigma)) out.focal = { f: free.cam.f, sigma: free.fSigma, rms: free.rms };
  }
  return out;
}

// Full automatic calibration on a processing image. intr: intrinsics for this image size.
// The best few model hypotheses are refined; the one whose lines fit best wins. A focal length that
// disagrees with the preset (when the view makes it measurable) marks a wrong correspondence.
export function autoCalibrate(img, intr) {
  const found = findCourt(img, intr);
  if (!found || !found.H) return { ok: false, reason: found?.fail || 'none', debug: found };
  let best = null;
  for (const hyp of found.hyps) {
    const pose = poseFromHomography(hyp.H, intr.f, intr.cx, intr.cy);
    if (!pose) continue;
    const cam0 = new CameraModel({ ...intr, R: pose.R, t: pose.t });
    const ref = refineCourt(cam0, found.lum, found.w, found.h);
    if (!ref) continue;
    let q = ref.inliers * ref.coverage * ref.coverage * Math.min(1, 1.5 / Math.max(ref.rms, 0.1));
    if (ref.focal && ref.focal.sigma < 0.03 * ref.focal.f && Math.abs(ref.focal.f / intr.f - 1) > 0.12) q *= 0.6;
    if (!best || q > best.q) best = { ...ref, q, score: hyp.score };
  }
  if (!best) return { ok: false, reason: 'refine', debug: found };
  return { ok: true, ...best, debug: found };
}
