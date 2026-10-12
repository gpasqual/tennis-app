// Heavy maths off the UI thread: shot analysis, court calibration, placement accuracy estimate.
import { CameraModel } from './camera.js';
import { analyzeTrack } from './trajectory.js';
import { autoCalibrate, refineCourt, luminance } from './courtdetect.js';
import { ballModel } from './physics.js';
import { makeServe, mulberry32, gauss } from './sim.js';

const camJSON = c => (c ? c.toJSON() : null);
function plainResult(r) {
  if (!r) return null;
  const { params, ...rest } = r;
  return { ...rest, params: Array.from(params) };
}

const handlers = {
  analyze({ obs, cam, physics, pxNoise, serveOnly }) {
    return plainResult(analyzeTrack(obs, CameraModel.fromJSON(cam), ballModel(physics), { pxNoise, serveOnly }));
  },
  calibrate({ img, intr, focals }) {
    const r = autoCalibrate(img, intr, { focals: focals || [] });
    return { ok: r.ok, reason: r.reason, cam: camJSON(r.cam), camFree: camJSON(r.camFree), rms: r.rms, inliers: r.inliers, coverage: r.coverage, lines: r.lines, focal: r.focal || null };
  },
  refine({ img, cam }) {
    const c = CameraModel.fromJSON(cam);
    const r = refineCourt(c, luminance(img));
    return r ? { ok: true, cam: camJSON(r.cam), camFree: camJSON(r.camFree), rms: r.rms, inliers: r.inliers, coverage: r.coverage, lines: r.lines, focal: r.focal || null } : { ok: false };
  },
  // Simulated serves through this camera (both ends of the court) -> expected accuracy.
  placement({ cam, fps, pxNoise, physics, roi }) {
    const c = CameraModel.fromJSON(cam);
    const M = ballModel(physics);
    const rng = mulberry32(11);
    const inRoi = (u, v) => u >= roi[0] && v >= roi[1] && u < roi[2] && v < roi[3];
    const out = {};
    for (const end of ['near', 'far']) {
      const errs = [], sig = [];
      let fitted = 0, total = 0, bounceSeen = 0;
      for (let i = 0; i < 8; i++) {
        const speed = (145 + rng() * 50) / 3.6;
        const s = makeServe({ M, speed, side: i % 2 ? 'ad' : 'deuce', end, CLv: -0.12, CLs: (rng() - 0.5) * 0.2, rng });
        const obs = [];
        const dt = 1 / fps, phase = rng() * dt;
        for (let k = Math.round(0.05 * fps); ; k++) {
          const t = phase + k * dt;
          if (t > s.bounceT + 0.15) break;
          const P = s.at(t); if (!P) continue;
          const [u, v, z] = c.project(P);
          if (z <= 0.3 || !inRoi(u, v)) continue;
          if (rng() < 0.06) continue;
          // Detection centroids are typically better than the noise level the analysis assumes
          obs.push({ t, u: u + gauss(rng) * 0.6 * pxNoise, v: v + gauss(rng) * 0.6 * pxNoise });
        }
        total++;
        if (obs.some(o => o.t > s.bounceT)) bounceSeen++;
        if (obs.length < 6) continue;
        const r = analyzeTrack(obs, c, M, { pxNoise, serveOnly: true });
        if (!r || !r.plausible) continue;
        fitted++;
        errs.push(Math.abs(r.speed - speed) / speed);
        sig.push(r.sigma / speed);
      }
      const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null);
      out[end] = { fitted, total, bounceSeen, err75: pct(errs, 0.75), medSigma: pct(sig, 0.5) };
    }
    return out;
  },
};

self.onmessage = e => {
  const { id, type, payload } = e.data;
  try {
    const result = handlers[type](payload);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
