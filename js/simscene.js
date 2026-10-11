// Demo mode: renders a court seen from a virtual phone camera with players and served balls whose
// true speed is known. Frames go through exactly the same detection / tracking / analysis as camera
// frames, so the demo doubles as an end-to-end test.
import { CameraModel } from './camera.js';
import { C, LINES, MARKS, netHeightAt } from './court.js';
import { ballModel } from './physics.js';
import { makeServe, mulberry32 } from './sim.js';
import { focalPx } from './lenses.js';

const mkCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

export const DEMO_FEQ = 26;
export function demoCamera(width = 1280, height = 720, placement = 'offset') {
  const intr = { width, height, f: focalPx(DEMO_FEQ, width, height), cx: width / 2, cy: height / 2 };
  const P = {
    offset: [[4.0, -17.5, 3.0], [-0.5, 0, 0.8]],
    corner: [[6.5, -17.0, 2.5], [0, 0, 0]],
    centre: [[0.5, -17.5, 2.0], [0, 1, 0]],
  }[placement] || [[4.0, -16.5, 2.8], [0.3, 0, 0]];
  return CameraModel.lookAt(intr, P[0], P[1], 0.012);
}

export class SimScene {
  constructor(cam, { seed = 7, fps = 60, surface = 'blue' } = {}) {
    this.cam = cam; this.fps = fps;
    this.canvas = mkCanvas(cam.width, cam.height);
    this.ctx = this.canvas.getContext('2d');
    this.rng = mulberry32(seed);
    this.M = ballModel({ cd: 0.55 });
    this.bg = this.renderBackground(surface);
    this.noise = this.makeNoise();
    this.serves = [];
    this.allServes = [];
    this.nextServeAt = 1.6;
    this.count = 0;
  }

  poly(ctx, pts3, fill) {
    const cam = this.cam;
    const P = clipFront(pts3, cam, 0.3).map(p => cam.project(p));
    if (P.length < 3) return;
    ctx.beginPath(); P.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v))); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }

  renderBackground(surface) {
    const { width: W, height: H } = this.cam;
    const c = mkCanvas(W, H), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#9cc3ea'); g.addColorStop(1, '#d9e7f2');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // Distant trees: a mottled band along the horizon
    const hz = this.cam.project([0, 400, 0])[1];
    for (let i = 0; i < 900; i++) {
      const u = this.rng() * W, v = hz - this.rng() * H * 0.12;
      x.fillStyle = `rgb(${40 + this.rng() * 30 | 0},${80 + this.rng() * 50 | 0},${45 + this.rng() * 20 | 0})`;
      x.beginPath(); x.arc(u, v, 4 + this.rng() * 14, 0, Math.PI * 2); x.fill();
    }
    const colors = { blue: ['#3f7a3e', '#2d5f93'], green: ['#4b6b45', '#3c7d50'], clay: ['#a0603a', '#bf6e40'] }[surface] || ['#3f7a3e', '#2d5f93'];
    this.poly(x, [[-80, -80, 0], [80, -80, 0], [80, 120, 0], [-80, 120, 0]], colors[0]);
    this.poly(x, [[-C.HWD - 3.6, -C.HL - 6.4, 0], [C.HWD + 3.6, -C.HL - 6.4, 0], [C.HWD + 3.6, C.HL + 6.4, 0], [-C.HWD - 3.6, C.HL + 6.4, 0]], colors[1]);
    // Back fences
    for (const s of [-1, 1]) this.poly(x, [[-C.HWD - 3.6, s * (C.HL + 6.4), 0], [C.HWD + 3.6, s * (C.HL + 6.4), 0], [C.HWD + 3.6, s * (C.HL + 6.4), 3], [-C.HWD - 3.6, s * (C.HL + 6.4), 3]], 'rgba(30,50,40,0.55)');
    const white = '#eef0f2';
    for (const [x1, y1, x2, y2, , w] of LINES) {
      if (x1 === x2) this.poly(x, [[x1 - w / 2, y1, 0], [x1 + w / 2, y1, 0], [x2 + w / 2, y2, 0], [x2 - w / 2, y2, 0]], white);
      else this.poly(x, [[x1, y1 - w / 2, 0], [x2, y2 - w / 2, 0], [x2, y2 + w / 2, 0], [x1, y1 + w / 2, 0]], white);
    }
    for (const [x1, y1, x2, y2] of MARKS) this.poly(x, [[x1 - 0.025, y1, 0], [x1 + 0.025, y1, 0], [x2 + 0.025, y2, 0], [x2 - 0.025, y2, 0]], white);
    // Net: see-through mesh, white tape, posts
    const net = []; for (let k = 0; k <= 16; k++) { const xx = -C.POST_X + 2 * C.POST_X * k / 16; net.push([xx, 0, netHeightAt(xx)]); }
    this.poly(x, [[-C.POST_X, 0, 0], [C.POST_X, 0, 0], ...net.slice().reverse()], 'rgba(20,20,24,0.55)');
    this.poly(x, [...net, ...net.slice().reverse().map(p => [p[0], 0, p[2] - 0.06])], '#f4f4f4');
    for (const s of [-1, 1]) this.poly(x, [[s * C.POST_X - 0.04, 0, 0], [s * C.POST_X + 0.04, 0, 0], [s * C.POST_X + 0.04, 0, C.NET_P], [s * C.POST_X - 0.04, 0, C.NET_P]], '#1d3b2a');
    return c;
  }

  makeNoise() {
    const n = mkCanvas(256, 256), x = n.getContext('2d'), id = x.createImageData(256, 256);
    for (let i = 0; i < id.data.length; i += 4) { const v = this.rng() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 14; }
    x.putImageData(id, 0, 0);
    return n;
  }

  // Schedule serves: alternate deuce / ad from the near end, random pace and spin.
  update(t) {
    if (t >= this.nextServeAt) {
      const side = this.count % 2 ? 'ad' : 'deuce';
      const kmh = 125 + this.rng() * 85;
      const s = makeServe({ M: this.M, speed: kmh / 3.6, side, end: 'near', CLv: -0.22 + this.rng() * 0.22, CLs: (this.rng() - 0.5) * 0.3, height: 2.55 + this.rng() * 0.3, tStart: t + 1.1, rng: this.rng });
      this.serves.push(s);
      this.allServes.push(s);
      if (this.allServes.length > 60) this.allServes.shift();
      this.count++;
      this.nextServeAt = t + 4.2 + this.rng() * 1.2;
    }
    this.serves = this.serves.filter(s => t < s.tStart + 3);
  }

  person(ctx, x, y, h, lean = 0, color = '#5a2340') {
    // A simple player: legs/body box and a head
    this.poly(ctx, [[x - 0.22, y, 0], [x + 0.22, y, 0], [x + 0.22 + lean, y, h * 0.82], [x - 0.22 + lean, y, h * 0.82]], color);
    const head = this.cam.project([x + lean, y, h * 0.9]);
    if (head[2] > 0.3) { ctx.fillStyle = '#c99a7a'; ctx.beginPath(); ctx.arc(head[0], head[1], this.cam.f * 0.11 / head[2], 0, Math.PI * 2); ctx.fill(); }
  }

  ballAt(ctx, P, Pprev) {
    const a = this.cam.project(P);
    if (a[2] <= 0.3) return;
    const r = Math.max(0.7, this.cam.f * 0.0335 / a[2]);
    ctx.strokeStyle = ctx.fillStyle = '#d6ef3a';
    if (Pprev) {
      const b = this.cam.project(Pprev);
      ctx.lineCap = 'round'; ctx.lineWidth = 2 * r;
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(a[0], a[1]); ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, Math.PI * 2); ctx.fill(); }
  }

  // Draw the frame at time t onto this.canvas.
  render(t) {
    this.update(t);
    const ctx = this.ctx, exp = 1 / 500;
    ctx.drawImage(this.bg, 0, 0);
    // Receiver sways at the far baseline
    this.person(ctx, 1.2 * Math.sin(t * 0.9), C.HL + 0.6, 1.8, 0, '#2a3f6b');
    const s = this.serves[this.serves.length - 1];
    if (s) {
      const ti = s.tStart, [ix, iy, iz] = s.impact;
      const sx = ix + (ix > 0 ? 0.25 : -0.25), sy = iy - 0.35;
      // Server and racket: the racket sweeps up through the contact point around impact
      const lean = Math.max(-0.15, Math.min(0.25, (t - ti + 0.2) * 0.6));
      this.person(ctx, sx, sy, 1.85, lean);
      const ph = Math.max(-1, Math.min(1, (t - ti) / 0.12));
      const rk = [ix + 0.1 * ph, iy + 0.25 * ph, iz - 0.9 + 0.9 * Math.cos(ph * 1.2)];
      const sh = this.cam.project([sx + lean, sy, 1.5]), rp = this.cam.project(rk);
      if (sh[2] > 0.3 && rp[2] > 0.3) { ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(2, this.cam.f * 0.04 / rp[2]); ctx.beginPath(); ctx.moveTo(sh[0], sh[1]); ctx.lineTo(rp[0], rp[1]); ctx.stroke(); }
      // Toss before impact, flight after
      if (t < ti && t > ti - 1.2) {
        const u = (t - (ti - 1.2)) / 1.2; // 0..1 over the toss
        const z = 1.6 + (iz + 0.5 - 1.6) * Math.sin(Math.PI * Math.min(1, u * 0.85)) - (u > 0.85 ? (u - 0.85) * 2.5 : 0);
        this.ballAt(ctx, [ix, iy, Math.max(1.4, Math.min(iz + 0.5, z))]);
      } else if (t >= ti) {
        const P = s.at(t), Pp = s.at(t - exp);
        if (P && P[1] < C.HL + 1) this.ballAt(ctx, P, Pp);
      }
    }
    // Sensor noise
    ctx.save();
    ctx.translate(-(this.rng() * 256 | 0), -(this.rng() * 256 | 0));
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat');
    ctx.fillRect(0, 0, this.cam.width + 256, this.cam.height + 256);
    ctx.restore();
    return this.canvas;
  }

  // Ground truth for a measured serve (closest impact time)
  truthNear(tImpact) {
    let best = null;
    for (const s of this.allServes) if (!best || Math.abs(s.tStart - tImpact) < Math.abs(best.tStart - tImpact)) best = s;
    return best && Math.abs(best.tStart - tImpact) < 0.5 ? best : null;
  }
}

// Clip a 3D polygon to the half-space in front of the camera (depth >= zmin).
function clipFront(pts, cam, zmin) {
  const depth = p => cam.R[6] * p[0] + cam.R[7] * p[1] + cam.R[8] * p[2] + cam.t[2];
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], da = depth(a), db = depth(b);
    if (da >= zmin) out.push(a);
    if ((da >= zmin) !== (db >= zmin)) { const s = (zmin - da) / (db - da); out.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), a[2] + s * (b[2] - a[2])]); }
  }
  return out;
}
