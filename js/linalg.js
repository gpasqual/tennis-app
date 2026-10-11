// Small dense linear algebra for the camera / trajectory maths. 3x3 matrices are flat row-major arrays of 9.

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm3 = a => Math.hypot(a[0], a[1], a[2]);
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export function unit3(a) { const n = norm3(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }

export function mul33(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
}
export const mulVec33 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
export const transpose33 = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
export const det33 = A => A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
export function inv33(A) {
  const d = det33(A);
  if (!d) return null;
  const i = 1 / d;
  return [
    (A[4] * A[8] - A[5] * A[7]) * i, (A[2] * A[7] - A[1] * A[8]) * i, (A[1] * A[5] - A[2] * A[4]) * i,
    (A[5] * A[6] - A[3] * A[8]) * i, (A[0] * A[8] - A[2] * A[6]) * i, (A[2] * A[3] - A[0] * A[5]) * i,
    (A[3] * A[7] - A[4] * A[6]) * i, (A[1] * A[6] - A[0] * A[7]) * i, (A[0] * A[4] - A[1] * A[3]) * i,
  ];
}

// Nearest rotation (polar decomposition by Newton iteration R <- (R + R^-T) / 2). Input must have det > 0.
export function orthonormalize(M) {
  let R = M.slice();
  for (let k = 0; k < 30; k++) {
    const Ri = inv33(R); if (!Ri) break;
    const RiT = transpose33(Ri);
    const N = R.map((v, i) => 0.5 * (v + RiT[i]));
    let diff = 0; for (let i = 0; i < 9; i++) diff = Math.max(diff, Math.abs(N[i] - R[i]));
    R = N;
    if (diff < 1e-13) break;
  }
  return R;
}

// Rodrigues: rotation vector <-> matrix.
export function rotFromVec(w) {
  const th = norm3(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}
export function vecFromRot(R) {
  const c = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-6) {
    // 180°: axis from the largest diagonal entry of (R + I) / 2
    const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2;
    let ax;
    if (xx >= yy && xx >= zz) { const x = Math.sqrt(xx); ax = [x, R[1] / (2 * x), R[2] / (2 * x)]; }
    else if (yy >= zz) { const y = Math.sqrt(yy); ax = [R[1] / (2 * y), y, R[5] / (2 * y)]; }
    else { const z = Math.sqrt(zz); ax = [R[2] / (2 * z), R[5] / (2 * z), z]; }
    return scale3(unit3(ax), th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

// Solve the symmetric positive-definite system A x = b (A is n*n flat). Returns null if not SPD.
export function cholSolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}

// Inverse of an SPD matrix (for covariances). Returns null if singular.
export function spdInverse(A, n) {
  const inv = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n); e[j] = 1;
    const col = cholSolve(A, e, n); if (!col) return null;
    for (let i = 0; i < n; i++) inv[i * n + j] = col[i];
  }
  return inv;
}

// Weighted linear least squares via Householder QR. rows: array of length-n arrays, rhs: numbers.
export function lstsq(rows, rhs, n) {
  const m = rows.length;
  if (m < n) return null;
  const A = rows.map(r => Float64Array.from(r));
  const b = Float64Array.from(rhs);
  for (let k = 0; k < n; k++) {
    let s = 0; for (let i = k; i < m; i++) s += A[i][k] * A[i][k];
    let nrm = Math.sqrt(s); if (nrm < 1e-300) return null;
    if (A[k][k] > 0) nrm = -nrm;
    const v = new Float64Array(m); for (let i = k; i < m; i++) v[i] = A[i][k];
    v[k] -= nrm;
    let vv = 0; for (let i = k; i < m; i++) vv += v[i] * v[i];
    if (vv < 1e-300) continue;
    for (let j = k; j < n; j++) {
      let d = 0; for (let i = k; i < m; i++) d += v[i] * A[i][j];
      const f = 2 * d / vv; for (let i = k; i < m; i++) A[i][j] -= f * v[i];
    }
    let d = 0; for (let i = k; i < m; i++) d += v[i] * b[i];
    const f = 2 * d / vv; for (let i = k; i < m; i++) b[i] -= f * v[i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    if (Math.abs(A[i][i]) < 1e-14) return null;
    x[i] = s / A[i][i];
  }
  return x;
}

// ---------- Homographies (map [x, y, 1] -> H [x, y, 1]) ----------
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Unit square (0,0),(1,0),(1,1),(0,1) -> quad p0..p3.
function squareToQuad(p) {
  const [x0, y0] = p[0], [x1, y1] = p[1], [x2, y2] = p[2], [x3, y3] = p[3];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
// Exact homography from 4 point pairs.
export function homography4(src, dst) {
  const A = squareToQuad(src), B = squareToQuad(dst);
  if (!A || !B) return null;
  const Ai = inv33(A); if (!Ai) return null;
  return mul33(B, Ai);
}

// Normalised DLT (h33 = 1) for n >= 4 pairs, optional per-pair weights.
export function homographyDLT(src, dst, weights) {
  const n = src.length;
  if (n < 4) return null;
  const norm = pts => {
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let d = 0; for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my); d /= pts.length;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  };
  const Ts = norm(src), Td = norm(dst);
  const rows = [], rhs = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = applyH(Ts, src[i][0], src[i][1]);
    const [u, v] = applyH(Td, dst[i][0], dst[i][1]);
    const w = weights ? weights[i] : 1;
    rows.push([x * w, y * w, w, 0, 0, 0, -u * x * w, -u * y * w]); rhs.push(u * w);
    rows.push([0, 0, 0, x * w, y * w, w, -v * x * w, -v * y * w]); rhs.push(v * w);
  }
  const h = lstsq(rows, rhs, 8);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const Tdi = inv33(Td); if (!Tdi) return null;
  const H = mul33(Tdi, mul33(Hn, Ts));
  const s = H[8]; return Math.abs(s) > 1e-15 ? H.map(v => v / s) : H;
}

// Line through two points as [a, b, c] with a^2 + b^2 = 1.
export function lineThrough(p, q) {
  const a = p[1] - q[1], b = q[0] - p[0], c = p[0] * q[1] - q[0] * p[1];
  const n = Math.hypot(a, b) || 1;
  return [a / n, b / n, c / n];
}
export function intersectLines(l, m) {
  const x = l[1] * m[2] - l[2] * m[1], y = l[2] * m[0] - l[0] * m[2], w = l[0] * m[1] - l[1] * m[0];
  if (Math.abs(w) < 1e-12) return null;
  return [x / w, y / w];
}
// Total-least-squares line fit through points (optionally weighted). Returns [a, b, c] (unit normal) or null.
export function fitLine(pts, w) {
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < pts.length; i++) { const wi = w ? w[i] : 1; sw += wi; mx += wi * pts[i][0]; my += wi * pts[i][1]; }
  if (sw <= 0 || pts.length < 2) return null;
  mx /= sw; my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < pts.length; i++) {
    const wi = w ? w[i] : 1, dx = pts[i][0] - mx, dy = pts[i][1] - my;
    sxx += wi * dx * dx; sxy += wi * dx * dy; syy += wi * dy * dy;
  }
  // Normal = eigenvector of the smallest eigenvalue of the scatter matrix
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the largest spread
  const a = -Math.sin(th), b = Math.cos(th);
  return [a, b, -(a * mx + b * my)];
}

// Generic Levenberg–Marquardt. fn(params) -> residual Float64Array (or null if invalid).
// steps: finite-difference step per parameter. Returns { p, cost, JtJ, iters, r }.
export function levenbergMarquardt(fn, p0, steps, { maxIter = 40, tol = 1e-9 } = {}) {
  const n = p0.length;
  let p = Float64Array.from(p0);
  let r = fn(p); if (!r) return null;
  let cost = sumSq(r);
  let lambda = 1e-3, JtJ = null, iters = 0;
  const jac = (p, r) => {
    const m = r.length, J = new Float64Array(m * n);
    for (let j = 0; j < n; j++) {
      const q = Float64Array.from(p); q[j] += steps[j];
      let rq = fn(q), h = steps[j];
      if (!rq) { q[j] = p[j] - steps[j]; rq = fn(q); h = -steps[j]; if (!rq) return null; }
      for (let i = 0; i < m; i++) J[i * n + j] = (rq[i] - r[i]) / h;
    }
    return J;
  };
  for (; iters < maxIter; iters++) {
    const J = jac(p, r); if (!J) break;
    const m = r.length;
    const A = new Float64Array(n * n), g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const ri = r[i], o = i * n;
      for (let a = 0; a < n; a++) {
        const ja = J[o + a]; if (!ja) continue;
        g[a] += ja * ri;
        for (let b = a; b < n; b++) A[a * n + b] += ja * J[o + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    JtJ = A;
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const D = Float64Array.from(A);
      for (let a = 0; a < n; a++) D[a * n + a] += lambda * (A[a * n + a] || 1e-12);
      const dp = cholSolve(D, g.map(v => -v), n);
      if (!dp) { lambda *= 10; continue; }
      const q = p.map((v, i) => v + dp[i]);
      const rq = fn(q);
      const cq = rq ? sumSq(rq) : Infinity;
      if (cq < cost) {
        const rel = (cost - cq) / Math.max(cost, 1e-30);
        p = q; r = rq; cost = cq; lambda = Math.max(lambda / 4, 1e-12); improved = true;
        if (rel < tol) iters = maxIter;
        break;
      }
      lambda *= 8;
    }
    if (!improved) break;
  }
  // J^T J at the solution (for covariances)
  const J = jac(p, r);
  if (J) {
    const m = r.length; JtJ = new Float64Array(n * n);
    for (let i = 0; i < m; i++) for (let a = 0; a < n; a++) { const ja = J[i * n + a]; if (ja) for (let b = 0; b < n; b++) JtJ[a * n + b] += ja * J[i * n + b]; }
  }
  return { p, cost, JtJ, iters, r };
}
export function sumSq(r) { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }
