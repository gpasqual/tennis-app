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

const q = new URLSearchParams(location.search);
const DIR = q.get('dir') || 'out/real', FPS = Number(q.get('fps') || 29.97), N = Number(q.get('n') || 295), FEQ = Number(q.get('feq') || 26), PROCW = Number(q.get('procw') || 960);
const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };
out.textContent = '';
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
for (let k = 0; k < N; k++) {
  const im = await load(k);
  const d = det.process(im, k / FPS);
  if (d) { allDets.push(d); if (!d.noisy) tracker.push(d); }
  if (k % 30 === 0) { out.textContent = out.textContent.replace(/frame \d+\n?$/, '') + `frame ${k}\n`; await new Promise(r => setTimeout(r, 0)); }
}
tracker.flush();
out.textContent = out.textContent.replace(/frame \d+\n?$/, '');
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
window.__real = { cam: cam.toJSON(), tracks: tracks.map(tr => tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v }))) };
log('DONE');
