// node tests/trajectory.test.js — Monte Carlo check of the monocular speed estimate.
import { CameraModel, poseFromHomography, focalFromHomography } from '../js/camera.js';
import { focalPx } from '../js/lenses.js';
import { ballModel } from '../js/physics.js';
import { analyzeTrack } from '../js/trajectory.js';
import { makeServe, mulberry32, gauss } from '../js/sim.js';
import { homographyDLT, applyH } from '../js/linalg.js';
import { KEYPOINTS } from '../js/court.js';

const W = 1280, H = 720;
const intr = { width: W, height: H, f: focalPx(26, W, H), cx: W / 2, cy: H / 2 };

function check(name, cond, info = '') { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!cond) process.exitCode = 1; }

// ---- pose from homography round trip ----
{
  const cam = CameraModel.lookAt(intr, [3.2, -18, 2.4], [0, 2, 0], 0.03);
  const src = KEYPOINTS, dst = src.map(([x, y]) => cam.project([x, y, 0]));
  const Hm = homographyDLT(src, dst);
  const pose = poseFromHomography(Hm, intr.f, intr.cx, intr.cy);
  const c2 = cam.withPose(pose.R, pose.t);
  const err = Math.hypot(c2.C[0] - cam.C[0], c2.C[1] - cam.C[1], c2.C[2] - cam.C[2]);
  check('pose from homography', err < 1e-6, `camera centre error ${err.toExponential(2)} m`);
  const fe = focalFromHomography(Hm, intr.cx, intr.cy);
  check('focal from homography (oblique view)', fe.ok && Math.abs(fe.f / intr.f - 1) < 1e-3, `f=${fe.f?.toFixed(1)} true=${intr.f.toFixed(1)}`);
  const [u, v] = applyH(Hm, 0, 0), [u2, v2] = cam.project([0, 0, 0]);
  check('homography maps court centre', Math.hypot(u - u2, v - v2) < 1e-6);
}

// ---- Monte Carlo: serves seen from several camera positions ----
const setups = [
  { name: 'behind server, centred, 2.0 m', eye: [0.5, -17.5, 2.0], look: [0, 1, 0], end: 'near', weak: true },
  { name: 'behind server, 6.5 m offset, 2.5 m', eye: [6.5, -17.0, 2.5], look: [0, 0, 0], end: 'near' },
  { name: 'behind server, 4 m offset, 3.0 m', eye: [4.0, -16.0, 3.0], look: [0, 0, 0], end: 'near' },
  { name: 'side, at net post, 1.5 m (0.5x)', eye: [10.5, -1, 1.5], look: [0, 0, 0], end: 'near', wide: true },
  { name: 'side, 8 m out, 1.0 m (0.5x)', eye: [13.5, -2, 1.0], look: [0, 0, 0], end: 'near', wide: true },
  { name: 'behind receiver, 4 m offset, 2.5 m', eye: [-4.0, -16.5, 2.5], look: [0, 0, 0], end: 'far', weak: true },
  { name: 'behind receiver, centred, 2.2 m', eye: [-1.0, -17.5, 2.2], look: [0, 1, 0], end: 'far', weak: true },
];
const TRIALS = Number(process.env.TRIALS || 40);
for (const fps of [60, 30]) {
  for (const su of setups) {
    const rng = mulberry32(1234 + fps);
    const errs = [], sig = [], goodErr = [];
    let found = 0, total = 0, covered = 0, nGood = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const M = ballModel({ cd: 0.55 });
      const Mtrue = ballModel({ cd: 0.52 + rng() * 0.08 });
      const speed = (120 + rng() * 90) / 3.6;
      const cam = CameraModel.lookAt({ ...intr, f: focalPx(su.wide ? 13 : 26, W, H) }, su.eye, su.look);
      const serve = makeServe({ M: Mtrue, speed, side: rng() < 0.5 ? 'deuce' : 'ad', end: su.end, CLv: -0.2 + rng() * 0.25, CLs: (rng() - 0.5) * 0.3, height: 2.5 + rng() * 0.4, rng });
      const dt = 1 / fps, phase = rng() * dt;
      const skip = Math.round((2 + Math.floor(rng() * 3)) * fps / 60); // ball hidden by the server just after impact
      const obs = [];
      for (let k = 0; ; k++) {
        const t = phase + k * dt;
        if (t > serve.bounceT + 0.15) break;
        if (k < skip) continue;
        const P = serve.at(t); if (!P) continue;
        const [u, v, z] = cam.project(P);
        if (z <= 0 || u < 0 || u >= W || v < 0 || v >= H) continue;
        if (rng() < 0.08) continue; // missed detection
        let du = gauss(rng) * 0.8, dv = gauss(rng) * 0.8;
        if (rng() < 0.04) { du += (rng() - 0.5) * 50; dv += (rng() - 0.5) * 50; } // false match
        obs.push({ t, u: u + du, v: v + dv });
      }
      total++;
      const dg = {};
      const res = analyzeTrack(obs, cam, M, { pxNoise: 1, diag: dg, serveOnly: true });
      if (process.env.GRID) console.log('grid', dg.gridRms?.toFixed(2), res?.plausible ? res.quality : 'rejected');
      if (process.env.SCREEN && !res) console.log('screened-out', su.name, fps, JSON.stringify(dg.grids?.map(g => g && `rms ${g.rms.toFixed(1)} v ${g.kmh.toFixed(0)} y ${g.y.toFixed(1)} z ${g.z.toFixed(1)} vy ${g.vy.toFixed(0)}`)));
      if (!res || !res.plausible) continue;
      found++;
      const e = (res.speed - speed) / speed * 100;
      errs.push(e); sig.push(res.sigma / speed * 100);
      if (Math.abs(res.speed - speed) < 2 * res.sigma) covered++;
      if (res.quality !== 'poor') { nGood++; goodErr.push(e); }
      if (process.env.VERBOSE && res.quality !== 'poor' && Math.abs(e) > 6) console.log(`   outlier: ${su.name} ${fps}fps true ${(speed * 3.6).toFixed(0)} got ${(res.speed * 3.6).toFixed(0)} ±${(res.sigma * 3.6).toFixed(0)} ${res.quality} n=${res.n} impact z=${res.impact[2].toFixed(2)} y=${res.impact[1].toFixed(2)} land ${res.landing?.map(v => v.toFixed(2))} true ${serve.bounce.slice(0, 2).map(v => v.toFixed(2))} obs ${obs.length}`);
    }
    const stats = a => {
      if (!a.length) return 'n/a';
      const mean = a.reduce((x, y) => x + y, 0) / a.length;
      const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
      const p90 = a.map(Math.abs).sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
      return `bias ${mean.toFixed(1)}% sd ${sd.toFixed(1)}% |e|90 ${p90.toFixed(1)}%`;
    };
    const msig = sig.slice().sort((a, b) => a - b)[sig.length >> 1];
    console.log(`${fps}fps | ${su.name.padEnd(36)} | fit ${found}/${total} | all: ${stats(errs)} | med.sigma ${msig?.toFixed(1)}% | 2σ-cover ${(covered / Math.max(1, found) * 100).toFixed(0)}% | good/ok ${nGood}: ${stats(goodErr)}`);
    if (!su.weak) check(`${fps}fps ${su.name}`, found >= total * (fps >= 60 ? 0.9 : 0.8) && (goodErr.length < 5 || goodErr.map(Math.abs).sort((x, y) => x - y)[Math.floor(goodErr.length * 0.9)] < 6));
  }
}
