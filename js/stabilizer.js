// Camera rotation tracking for a phone that is not perfectly still (hand-held, a wobbly fence).
// Such a phone turns about its own lens; it hardly moves (a few cm are nothing at court distances),
// so one rotation maps every point of a frame — near or far — onto the calibration frame. Each frame
// is registered against the calibration frame with that 3-parameter model (Lucas–Kanade, coarse to
// fine on a small grey copy, with brightness gain/offset and robust weights so that players, the ball
// and moving shadows do not pull). The ball detector then resamples every frame into the calibrated
// view, and the court calibration holds for the whole recording.
import { mul33, rotFromVec, cholSolve } from './linalg.js';

const mkCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MAX_PTS = 5000;
const transpose = R => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];

function grey(d, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return g;
}
function blur(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i;
    tmp[i] = 0.25 * src[l] + 0.5 * src[i] + 0.25 * src[r];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, u = y > 0 ? i - w : i, d = y < h - 1 ? i + w : i;
    out[i] = 0.25 * tmp[u] + 0.5 * tmp[i] + 0.25 * tmp[d];
  }
  return out;
}
function half(src, w, h) {
  const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    out[y * W + x] = 0.25 * (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]);
  }
  return { I: out, w: W, h: H };
}
function grads(I, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = 0.5 * (I[i + 1] - I[i - 1]); gy[i] = 0.5 * (I[i + w] - I[i - w]);
  }
  return { gx, gy };
}

export class Stabilizer {
  // width: size of the grey copy the registration runs on; levels: pyramid depth
  constructor({ width = 320, levels = 3 } = {}) {
    this.W0 = width; this.levels = levels; this.ref = null;
  }

  get ready() { return !!this.ref; }

  // source: the frame the calibration was made on (or one taken from the same view); cam: the
  // calibration (CameraModel, native pixels).
  setReference(source, cam) {
    const w = this.W0, h = Math.max(16, Math.round(cam.height * w / cam.width));
    this.native = { w: cam.width, h: cam.height, f: cam.f, cx: cam.cx, cy: cam.cy };
    this.s = w / cam.width; this.w = w; this.h = h;
    this.canvas = mkCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ref = this.pyramid(source);
    // Pixels used for the registration: where the reference has texture (flat sky and clay say nothing)
    this.sel = this.ref.map(L => {
      const { gx, gy } = L, mags = [];
      for (let y = 2; y < L.h - 2; y++) for (let x = 2; x < L.w - 2; x++) { const i = y * L.w + x; mags.push(Math.abs(gx[i]) + Math.abs(gy[i])); }
      const sorted = mags.slice().sort((a, b) => a - b), thr = Math.max(1.5, sorted[Math.floor(sorted.length * 0.6)]);
      let idx = [];
      for (let y = 2; y < L.h - 2; y++) for (let x = 2; x < L.w - 2; x++) { const i = y * L.w + x; if (Math.abs(gx[i]) + Math.abs(gy[i]) >= thr) idx.push(i); }
      // A few thousand well-spread pixels pin three angles down; more only cost time
      if (idx.length > MAX_PTS) { const step = idx.length / MAX_PTS; idx = Array.from({ length: MAX_PTS }, (_, k) => idx[Math.floor(k * step)]); }
      return Int32Array.from(idx);
    });
    this.R = I3.slice(); this.gain = 1; this.bias = 0;
    this.last = { ok: true, R: this.R, inliers: 1, rms: 0 };
  }

  pyramid(source) {
    this.ctx.drawImage(source, 0, 0, this.w, this.h);
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    let L = { I: blur(grey(d, this.w * this.h), this.w, this.h), w: this.w, h: this.h };
    const out = [];
    for (let l = 0; l < this.levels; l++) {
      if (l) L = half(L.I, L.w, L.h);
      out.push({ ...L, ...grads(L.I, L.w, L.h), scale: L.w / this.native.w });
    }
    return out;
  }

  // Register a frame. Returns { ok, R, inliers, rms }: R rotates the calibration camera into this
  // frame's camera. A frame that does not register (a hand over the lens, a big jump) keeps the last
  // good rotation and is reported not ok.
  track(source) {
    if (!this.ref) return null;
    const cur = this.pyramid(source);
    // From the last rotation first; if that does not register (a jump: scrubbing a video, a knock),
    // from the calibration pose
    let res = this.register(cur, this.R, this.gain, this.bias);
    if (!res.ok) {
      const again = this.register(cur, I3, 1, 0);
      if (again.ok || (again.inliers ?? 0) > (res.inliers ?? 0)) res = again;
    }
    if (!res.ok) return this.fail(res);
    this.R = res.R; this.gain = res.gain; this.bias = res.bias;
    this.last = { ok: true, R: res.R, inliers: res.inliers, rms: res.rms };
    return this.last;
  }

  register(cur, R0, gain, bias) {
    let R = R0.slice();
    for (let l = this.levels - 1; l >= 0; l--) {
      const L = cur[l], F = this.ref[l], sel = this.sel[l];
      const f = this.native.f * L.scale, cx = this.native.cx * L.scale, cy = this.native.cy * L.scale;
      for (let it = 0; it < 8; it++) {
        const r = this.step(L, F, sel, R, gain, bias, f, cx, cy, it === 0 ? 30 : null);
        if (!r) return { ok: false };
        R = mul33(rotFromVec([r.dx, r.dy, r.dz]), R);
        gain += r.dg; bias += r.db;
        if (Math.hypot(r.dx, r.dy, r.dz) * f < 0.005) break;
      }
    }
    // Judged with a fixed tolerance (grey levels on the small blurred copy): a scale taken from the
    // residuals themselves would call a uniformly bad match good
    const fin = this.step(cur[0], this.ref[0], this.sel[0], R, gain, bias, this.native.f * cur[0].scale, this.native.cx * cur[0].scale, this.native.cy * cur[0].scale, 12, true);
    if (!fin) return { ok: false };
    return { ok: fin.inliers >= 0.6, R, gain, bias, inliers: fin.inliers, rms: fin.rms };
  }

  fail(fin) {
    this.last = { ok: false, R: this.R, inliers: fin ? fin.inliers : 0, rms: fin ? fin.rms : Infinity };
    return this.last;
  }

  // One Gauss–Newton step: the frame sampled where the rotation sends each reference pixel, compared
  // with gain * reference + bias. Robust (Huber) weights, with the scale from the residuals.
  step(L, F, sel, R, gain, bias, f, cx, cy, kFixed, statsOnly = false) {
    const w = L.w, h = L.h, I = L.I, gx = L.gx, gy = L.gy, Iref = F.I;
    const A = new Float64Array(25), g = new Float64Array(5);
    // Residual scale: median absolute residual from a first pass over a subsample
    let k = kFixed;
    const sample = (i, out) => {
      const x = i % F.w + 0.5, y = ((i / F.w) | 0) + 0.5;
      const rx = (x - cx) / f, ry = (y - cy) / f;
      const px = R[0] * rx + R[1] * ry + R[2], py = R[3] * rx + R[4] * ry + R[5], pz = R[6] * rx + R[7] * ry + R[8];
      if (pz <= 0) return false;
      const X = px / pz, Y = py / pz, u = f * X + cx - 0.5, v = f * Y + cy - 0.5;
      if (u < 1 || v < 1 || u > w - 2 || v > h - 2) return false;
      const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0, j = y0 * w + x0;
      const b00 = (1 - ax) * (1 - ay), b10 = ax * (1 - ay), b01 = (1 - ax) * ay, b11 = ax * ay;
      out.e = b00 * I[j] + b10 * I[j + 1] + b01 * I[j + w] + b11 * I[j + w + 1] - (gain * Iref[i] + bias);
      out.gx = b00 * gx[j] + b10 * gx[j + 1] + b01 * gx[j + w] + b11 * gx[j + w + 1];
      out.gy = b00 * gy[j] + b10 * gy[j + 1] + b01 * gy[j + w] + b11 * gy[j + w + 1];
      out.X = X; out.Y = Y; out.ref = Iref[i];
      return true;
    };
    const o = {};
    if (k == null) {
      const res = [];
      for (let n = 0; n < sel.length; n += 7) if (sample(sel[n], o)) res.push(Math.abs(o.e));
      if (res.length < 20) return null;
      res.sort((a, b) => a - b);
      k = Math.max(3, 2.5 * 1.4826 * res[res.length >> 1]);
    }
    let used = 0, inl = 0, ss = 0;
    for (let n = 0; n < sel.length; n++) {
      if (!sample(sel[n], o)) continue;
      used++;
      const ae = Math.abs(o.e);
      if (ae < k) { inl++; ss += o.e * o.e; }
      if (statsOnly) continue;
      const wt = ae <= k ? 1 : k / ae;
      // Image motion of a small extra rotation d (R <- exp([d]x) R) at normalised point (X, Y):
      // du = f (-XY dx + (1 + X^2) dy - Y dz), dv = f (-(1 + Y^2) dx + XY dy + X dz)
      const X = o.X, Y = o.Y;
      const j0 = f * (o.gx * -X * Y + o.gy * -(1 + Y * Y));
      const j1 = f * (o.gx * (1 + X * X) + o.gy * X * Y);
      const j2 = f * (o.gx * -Y + o.gy * X);
      const J = [j0, j1, j2, -o.ref, -1];
      for (let a = 0; a < 5; a++) { g[a] += wt * J[a] * o.e; for (let b = 0; b <= a; b++) A[a * 5 + b] += wt * J[a] * J[b]; }
    }
    if (used < Math.max(20, sel.length * 0.2)) return null;
    const stats = { inliers: inl / used, rms: Math.sqrt(ss / Math.max(1, inl)) };
    if (statsOnly) return stats;
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) A[a * 5 + b] = A[b * 5 + a];
    for (let a = 0; a < 5; a++) A[a * 5 + a] *= 1.0001;
    const x = cholSolve(A, g.map(v => -v), 5);
    if (!x) return null;
    return { dx: x[0], dy: x[1], dz: x[2], dg: x[3], db: x[4], ...stats };
  }

  // Homographies in native pixels: calibration view -> this frame, and back.
  refToCur(R = this.R) { return this.H(R); }
  curToRef(R = this.R) { return this.H(transpose(R)); }
  H(R) {
    const { f, cx, cy } = this.native;
    const K = [f, 0, cx, 0, f, cy, 0, 0, 1], Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
    return mul33(K, mul33(R, Ki));
  }
  // The calibration camera turned with the phone (for drawing the court on the live picture)
  camera(cam, R = this.R) {
    const t = cam.t;
    return cam.withPose(mul33(R, cam.R), [R[0] * t[0] + R[1] * t[1] + R[2] * t[2], R[3] * t[0] + R[4] * t[1] + R[5] * t[2], R[6] * t[0] + R[7] * t[1] + R[8] * t[2]]);
  }
}
