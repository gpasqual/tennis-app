// The real pipeline on a recorded clip, frame by frame (no playback timing): frames extracted with
//   ffmpeg -i clip.mp4 -q:v 3 tests/out/real/f_%04d.jpg
// then open tests/realclip.html?dir=out/real&fps=29.97&n=295 on the dev server. Calibrates on the first
// frame, tracks the ball, and lists every track with its analysis.
import { autoCalibrate } from '../js/courtdetect.js';
import { BallDetector } from '../js/detector.js';
import { Tracker } from '../js/tracker.js';
import { analyzeTrack } from '../js/trajectory.js';
import { ballModel } from '../js/physics.js';
import { focalPx } from '../js/lenses.js';
import { Stabilizer } from '../js/stabilizer.js';

const q = new URLSearchParams(location.search);
const STAB = q.get('stab') !== '0';
const DIR = q.get('dir') || 'out/real', FPS = Number(q.get('fps') || 29.97), N = Number(q.get('n') || 295), FEQ = Number(q.get('feq') || 26), PROCW = Number(q.get('procw') || 960);
const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };
out.textContent = '';
// Yield to the page without timers (timers are throttled to 1/s in a background tab)
const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
const load = k => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = `${DIR}/f_${String(k + 1).padStart(4, '0')}.jpg`; });

const first = await load(0);
const W = first.naturalWidth, H = first.naturalHeight;
const view = document.getElementById('view');
view.width = W; view.height = H;
const vctx = view.getContext('2d');
vctx.drawImage(first, 0, 0);

// 1. calibration on the first frame (processing width 1280 as in the app)
const s = Math.min(1, 1280 / W), pw = Math.round(W * s), ph = Math.round(H * s);
const pc = Object.assign(document.createElement('canvas'), { width: pw, height: ph });
const px = pc.getContext('2d', { willReadFrequently: true });
px.drawImage(first, 0, 0, pw, ph);
const intr = { width: pw, height: ph, f: focalPx(FEQ, pw, ph), cx: pw / 2, cy: ph / 2 };
let t0 = performance.now();
const cal = autoCalibrate(px.getImageData(0, 0, pw, ph), intr, { focals: [13, 26].map(m => focalPx(m, pw, ph)) });
if (!cal.ok) { log('CALIBRATION FAILED: ' + cal.reason); throw new Error('calibration'); }
const cam = cal.cam.scaled(W, H);
log(`calibration ${(performance.now() - t0).toFixed(0)} ms: camera (${cam.C.map(v => v.toFixed(2)).join(', ')}), f ${cam.f.toFixed(0)} px, rms ${(cal.rms / s).toFixed(2)} px, coverage ${cal.coverage.toFixed(2)}`);

// 2. frames
const det = new BallDetector();
det.setup(cam, { maxW: PROCW });
const M = ballModel({ cd: 0.55 });
const pxNoise = Math.max(0.7, 1 / det.cfg.scale);
log(`detector ${det.cfg.pw}x${det.cfg.ph} (scale ${det.cfg.scale.toFixed(2)}), pxNoise ${pxNoise.toFixed(2)}`);
const tracks = [];
const tracker = new Tracker({ width: W, onTrack: tr => tracks.push(tr) });
const allDets = [];
const MASK = q.get('mask') ? q.get('mask').split('-').map(Number) : null;
let acc = null;
const candPts = [];
const stab = new Stabilizer();
stab.setReference(first, cam);
let stabMs = 0, lost = 0;
const drift = [];
for (let k = 0; k < N; k++) {
  const im = await load(k);
  let warp = null;
  if (STAB) {
    const a = performance.now();
    const r = stab.track(im);
    stabMs += performance.now() - a;
    if (!r.ok) { lost++; det.reset(); continue; }
    warp = stab.refToCur();
    if ([20, 40, 90, 120, 150, 180, 210, 240, 270, 294].includes(k)) {
      const c2 = stab.camera(cam), P = [0, 0, 0], p0 = cam.project(P), p1 = c2.project(P), sc = 1280 / W;
      drift.push(`${k}: ${((p1[0] - p0[0]) * sc).toFixed(1)},${((p1[1] - p0[1]) * sc).toFixed(1)} (inl ${r.inliers.toFixed(2)})`);
    }
  }
  const d = det.process(im, k / FPS, warp);
  // ?mask=a-b: accumulate the detector's moving-pixel mask over frames a..b (drawn at the end)
  if (MASK && k >= MASK[0] && k <= MASK[1]) {
    acc = acc || new Uint8Array(det.cfg.pw * det.cfg.ph);
    for (let i = 0; i < acc.length; i++) if (det.m[i]) acc[i] = 255;
    if (d) for (const c of d.cands) candPts.push([c.u, c.v, k]);
  }
  if (d) { allDets.push(d); if (!d.noisy) tracker.push(d); }
  if (k % 30 === 0) { out.textContent = out.textContent.replace(/frame \d+\n?$/, '') + `frame ${k}\n`; await yieldNow(); }
}
tracker.flush();
out.textContent = out.textContent.replace(/frame \d+\n?$/, '');
if (STAB) log(`stabiliser ${(stabMs / N).toFixed(1)} ms/frame, lost ${lost}; court centre moved (1280 px): ${drift.join('  ')}`);
log(`frames ${N}, detections with candidates ${allDets.filter(d => d.cands?.length).length}, noisy ${allDets.filter(d => d.noisy).length}, tracks ${tracks.length}`);

// 3. analysis of every track
const colors = ['#ff0', '#0ff', '#f0f', '#0f0', '#f80', '#08f', '#f44', '#fff'];
tracks.forEach((tr, i) => {
  const obs = tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v }));
  const r = analyzeTrack(obs, cam, M, { pxNoise, serveOnly: false });
  const rs = analyzeTrack(obs, cam, M, { pxNoise, serveOnly: true });
  const desc = x => (x ? `${x.kind} ${(x.speed * 3.6).toFixed(1)} km/h ±${(x.sigma * 3.6).toFixed(1)} ${x.quality} plausible=${x.plausible} rms=${x.rms?.toFixed(2)} n=${x.n} impact (${x.impact?.map(v => v.toFixed(2)).join(', ')}) landing (${x.landing?.map(v => v.toFixed(2)).join(', ')})${x.landingObserved ? ' seen' : ''}` : 'no fit');
  log(`track ${i}: ${obs.length} pts t ${obs[0].t.toFixed(2)}..${obs.at(-1).t.toFixed(2)} (${obs[0].u.toFixed(0)},${obs[0].v.toFixed(0)}) -> (${obs.at(-1).u.toFixed(0)},${obs.at(-1).v.toFixed(0)})`);
  log(`   any:   ${desc(r)}`);
  log(`   serve: ${desc(rs)}`);
  vctx.fillStyle = colors[i % colors.length];
  for (const p of obs) vctx.fillRect(p.u - 3, p.v - 3, 6, 6);
  vctx.fillText(String(i), obs[0].u + 6, obs[0].v);
});
if (acc) {
  const mc = Object.assign(document.createElement('canvas'), { width: det.cfg.pw, height: det.cfg.ph });
  const mx = mc.getContext('2d'), id = mx.createImageData(det.cfg.pw, det.cfg.ph);
  for (let i = 0; i < acc.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = acc[i]; id.data[i * 4 + 3] = 255; }
  mx.putImageData(id, 0, 0);
  vctx.drawImage(first, 0, 0);
  vctx.globalAlpha = 0.75; vctx.drawImage(mc, det.cfg.bx0, det.cfg.by0, det.cfg.bw, det.cfg.bh); vctx.globalAlpha = 1;
  vctx.fillStyle = '#f0f';
  for (const [u, v, k] of candPts) { vctx.fillRect(u - 4, v - 4, 8, 8); }
}
window.__real = { cam: cam.toJSON(), tracks: tracks.map(tr => tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v }))) };
log('DONE');
