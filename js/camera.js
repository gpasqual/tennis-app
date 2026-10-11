// Pinhole camera with radial distortion, posed in court coordinates.
// Court frame: origin at the centre of the court on the ground (under the net), X along the net,
// Y along the court length (near baseline y = -11.885, far baseline y = +11.885), Z up. Metres.
// Camera frame: x right, y down, z forward (image u right, v down).
import { mulVec33, transpose33, cross3, unit3, orthonormalize, inv33, mul33, det33, sub3, norm3 } from './linalg.js';

export class CameraModel {
  constructor({ width, height, f, cx, cy, k1 = 0, k2 = 0, R, t }) {
    Object.assign(this, { width, height, f, cx, cy, k1, k2 });
    this.R = R.slice(); this.t = t.slice();
    this.Rt = transpose33(this.R);
    const c = mulVec33(this.Rt, this.t);
    this.C = [-c[0], -c[1], -c[2]];
  }
  // World point -> [u, v, depth]. depth <= 0 means behind the camera.
  project(P) {
    const R = this.R, t = this.t;
    const X = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0];
    const Y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1];
    const Z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2];
    const x = X / Z, y = Y / Z;
    let d = 1;
    if (this.k1 || this.k2) { const r2 = x * x + y * y; d = 1 + this.k1 * r2 + this.k2 * r2 * r2; }
    return [this.f * x * d + this.cx, this.f * y * d + this.cy, Z];
  }
  // Pixel -> undistorted normalised image coordinates.
  normalize(u, v) {
    const xd = (u - this.cx) / this.f, yd = (v - this.cy) / this.f;
    if (!this.k1 && !this.k2) return [xd, yd];
    let x = xd, y = yd;
    for (let i = 0; i < 8; i++) {
      const r2 = x * x + y * y, d = 1 + this.k1 * r2 + this.k2 * r2 * r2;
      x = xd / d; y = yd / d;
    }
    return [x, y];
  }
  // Pixel -> unit ray direction in world coordinates (origin this.C).
  ray(u, v) {
    const [x, y] = this.normalize(u, v);
    return unit3(mulVec33(this.Rt, [x, y, 1]));
  }
  // Intersection of the pixel's ray with the horizontal plane Z = z (null if parallel / behind).
  rayToPlaneZ(u, v, z = 0) {
    const d = this.ray(u, v);
    if (Math.abs(d[2]) < 1e-9) return null;
    const s = (z - this.C[2]) / d[2];
    if (s <= 0) return null;
    return [this.C[0] + s * d[0], this.C[1] + s * d[1], z];
  }
  // Ground-plane homography court(x, y) -> undistorted pixel.
  groundH() {
    const K = [this.f, 0, this.cx, 0, this.f, this.cy, 0, 0, 1], R = this.R, t = this.t;
    return mul33(K, [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]]);
  }
  distanceTo(P) { return norm3(sub3(P, this.C)); }
  scaled(width, height) {
    const s = width / this.width;
    return new CameraModel({ width, height, f: this.f * s, cx: this.cx * s, cy: this.cy * s, k1: this.k1, k2: this.k2, R: this.R, t: this.t });
  }
  withPose(R, t) { return new CameraModel({ ...this.intrinsics(), R, t }); }
  intrinsics() { return { width: this.width, height: this.height, f: this.f, cx: this.cx, cy: this.cy, k1: this.k1, k2: this.k2 }; }
  toJSON() { return { ...this.intrinsics(), R: this.R, t: this.t }; }
  static fromJSON(o) { return new CameraModel(o); }

  // Camera at `eye` looking at `target` (world up = +Z), for the simulator and the default overlay.
  static lookAt(intr, eye, target, roll = 0) {
    const fwd = unit3(sub3(target, eye));
    let right = unit3(cross3(fwd, [0, 0, 1]));
    let down = cross3(fwd, right);
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = [right[0] * c + down[0] * s, right[1] * c + down[1] * s, right[2] * c + down[2] * s];
      down = [down[0] * c - right[0] * s, down[1] * c - right[1] * s, down[2] * c - right[2] * s];
      right = r2;
    }
    const R = [...right, ...down, ...fwd];
    const t = mulVec33(R, eye).map(v => -v);
    return new CameraModel({ ...intr, R, t });
  }
}

// Pose from a ground homography (court plane -> undistorted pixels) and known intrinsics.
// Returns { R, t } with the court in front of the camera, or null. The camera can come out below
// the ground when the homography maps a mirrored court; callers reject that.
export function poseFromHomography(H, f, cx, cy) {
  const Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const M = mul33(Ki, H);
  const m1 = [M[0], M[3], M[6]], m2 = [M[1], M[4], M[7]], m3 = [M[2], M[5], M[8]];
  const n1 = norm3(m1), n2 = norm3(m2);
  if (!n1 || !n2) return null;
  let lam = 2 / (n1 + n2);
  if (m3[2] * lam < 0) lam = -lam;
  const r1 = m1.map(v => v * lam), r2 = m2.map(v => v * lam), r3 = cross3(r1, r2);
  let R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  if (det33(R) <= 0) return null;
  R = orthonormalize(R);
  const t = m3.map(v => v * lam);
  return { R, t };
}

// Focal length implied by a ground homography, assuming square pixels and the principal point at
// (cx, cy). Degenerate when a family of court lines is parallel to the image plane (e.g. a camera
// centred behind the baseline): then ok = false and the preset focal length has to be trusted.
export function focalFromHomography(H, cx, cy) {
  const T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
  const G = mul33(T, H);
  // Scale columns so the two constraints are comparable
  const h1 = [G[0], G[3], G[6]], h2 = [G[1], G[4], G[7]];
  const s = 1 / Math.max(norm3(h1), norm3(h2));
  const a1 = (h1[0] * h2[0] + h1[1] * h2[1]) * s * s, b1 = h1[2] * h2[2] * s * s;
  const a2 = (h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2) * s * s, b2 = (h1[2] ** 2 - h2[2] ** 2) * s * s;
  // a_i / f^2 + b_i = 0 -> least squares in w = 1/f^2, weighted by |b| (its sensitivity)
  const den = b1 * b1 + b2 * b2;
  if (den < 1e-20) return { ok: false };
  // Solve sum (a_i w + b_i)^2 min over w: w = -sum a_i b_i / sum a_i^2
  const aa = a1 * a1 + a2 * a2;
  if (aa < 1e-30) return { ok: false };
  const w = -(a1 * b1 + a2 * b2) / aa;
  if (!(w > 0)) return { ok: false };
  const f = 1 / Math.sqrt(w);
  const f1 = -a1 / b1 > 0 ? Math.sqrt(-a1 / b1) : NaN;
  const f2 = -a2 / b2 > 0 ? Math.sqrt(-a2 / b2) : NaN;
  return { ok: true, f, f1, f2 };
}

export { inv33 };
