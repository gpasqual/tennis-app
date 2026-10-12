// Deterministic end-to-end run of the real pipeline on rendered demo frames (no real-time pacing).
import { demoCamera, SimScene } from '../js/simscene.js';
import { autoCalibrate } from '../js/courtdetect.js';
import { BallDetector } from '../js/detector.js';
import { Tracker } from '../js/tracker.js';
import { analyzeTrack } from '../js/trajectory.js';
import { ballModel } from '../js/physics.js';
import { ResultGate } from '../js/results.js';

const q = new URLSearchParams(location.search);
const SECONDS = Number(q.get('seconds') || 45), FPS = Number(q.get('fps') || 60), PLACEMENT = q.get('placement') || 'side', PROCW = Number(q.get('procw') || 960);
const SURFACE = q.get('surface') || 'blue', LINES_ = q.get('lines') || 'clean', BALL = q.get('ball') || 'new';
const out = document.getElementById('out');
const log = s => { out.textContent += s + '\n'; };
out.textContent = '';

const truthCam = demoCamera(1280, 720, PLACEMENT);
const scene = new SimScene(truthCam, { seed: 21, fps: FPS, surface: SURFACE, lines: LINES_, ball: BALL });
const view = document.getElementById('view');
view.width = 1280; view.height = 720;
const vctx = view.getContext('2d');

// 1. calibrate on a rendered frame
const f0 = scene.render(0.2);
const c0 = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
const x0 = c0.getContext('2d', { willReadFrequently: true });
x0.drawImage(f0, 0, 0);
let t0 = performance.now();
const cal = autoCalibrate(x0.getImageData(0, 0, 1280, 720), truthCam.intrinsics());
const calMs = performance.now() - t0;
if (!cal.ok) { log('CALIBRATION FAILED: ' + cal.reason); throw new Error('calibration'); }
const cam = cal.cam;
const dC = Math.hypot(...cam.C.map((v, i) => v - truthCam.C[i]));
log(`calibration: camera error ${(dC * 100).toFixed(1)} cm, line rms ${cal.rms.toFixed(2)} px, ${calMs.toFixed(0)} ms`);

// 2. run frames
const det = new BallDetector();
det.setup(cam, { maxW: PROCW });
const M = ballModel({ cd: 0.55 });
const pxNoise = Math.max(0.7, 1 / det.cfg.scale);
const results = [];
let rejected = 0, analysisMs = 0, analyses = 0;
const allTracks = [];
const gate = new ResultGate(r => results.push({ r, truth: scene.truthNear(r.tImpact) }), { wait: 0 });
const tracker = new Tracker({
  width: 1280,
  onTrack: tr => {
    allTracks.push(tr);
    const obs = tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v }));
    const a = performance.now();
    const dg = {};
    const r = analyzeTrack(obs, cam, M, { pxNoise, diag: dg, serveOnly: true });
    (window.__grid = window.__grid || []).push({ g: dg.gridRms, p: dg.gridP, ok: !!(r && r.plausible && r.kind === 'serve'), q: r?.quality, n: obs.length });
    analysisMs += performance.now() - a; analyses++;
    if (r) r.obs = obs;
    if (!r || !r.plausible || r.kind !== 'serve') {
      rejected++;
      const tr2 = scene.truthNear(obs[0].t + 0.1);
      if (tr2 && Math.abs(obs[0].t - tr2.tStart) < 0.6 && obs.length > 15) log(`  rejected ${obs.length}-pt track at t=${obs[0].t.toFixed(2)}: ${r ? `${r.kind} ${(r.speed * 3.6).toFixed(0)} km/h ±${(r.sigma * 3.6).toFixed(0)} plausible=${r.plausible} span=${r.span?.toFixed(1)} rms=${r.rms.toFixed(2)} n=${r.n}` : 'no fit'}`);
      return;
    }
    gate.push(r);
  },
});
let k = 0, detMs = 0, renderMs = 0;
const total = Math.round(SECONDS * FPS);
function chunk() {
  const end = Math.min(total, k + 120);
  for (; k < end; k++) {
    const t = 0.5 + k / FPS;
    let a = performance.now();
    const frame = scene.render(t);
    renderMs += performance.now() - a;
    a = performance.now();
    const d = det.process(frame, t);
    detMs += performance.now() - a;
    if (d && !d.noisy) tracker.push(d);
    if (k % 30 === 0) vctx.drawImage(frame, 0, 0);
  }
  out.textContent = out.textContent.replace(/frames .*\n?$/, '') + `frames ${k}/${total}\n`;
  if (k < total) setTimeout(chunk, 0); else finish();
}
function finish() {
  tracker.flush();
  gate.flush();
  log(`tracks analysed ${analyses} (${(analysisMs / Math.max(1, analyses)).toFixed(0)} ms each), rejected ${rejected}`);
  log(`render ${(renderMs / total).toFixed(1)} ms/frame, detection ${(detMs / total).toFixed(1)} ms/frame (processing ${det.cfg.pw}x${det.cfg.ph})`);
  const served = scene.allServes.filter(s => s.tStart < 0.5 + SECONDS - 1.2);
  const matched = new Map();
  const errs = [];
  for (const x of results) {
    const { r, truth } = x;
    const kmh = r.speed * 3.6;
    if (!truth) { log(`  ${r.kind} ${kmh.toFixed(1)} km/h — no matching serve (t=${r.tImpact.toFixed(2)})`); continue; }
    if (matched.has(truth)) { log(`  duplicate track for serve at ${truth.tStart.toFixed(2)}`); continue; }
    matched.set(truth, r);
    const e = (r.speed - truth.speed) / truth.speed * 100;
    if (r.quality !== 'poor') errs.push(e);
    log(`  ${r.kind.padEnd(5)} ${truth.side.padEnd(5)} true ${(truth.speed * 3.6).toFixed(1)}  measured ${kmh.toFixed(1)} ± ${(r.sigma * 3.6).toFixed(1)} km/h  err ${e >= 0 ? '+' : ''}${e.toFixed(1)}%  ${r.quality}  pts ${r.n}  bounce ${r.landingObserved ? 'seen' : 'extrap'}  land (${r.landing?.map(v => v.toFixed(2)).join(', ')}) true (${truth.bounce.slice(0, 2).map(v => v.toFixed(2)).join(', ')})  call ${r.margin == null ? '-' : r.margin <= 0 ? 'IN' : 'OUT'}`);
  }
  for (const sv of served) {
    if (matched.has(sv)) continue;
    log(`  MISSED ${sv.side} serve at t=${sv.tStart.toFixed(2)} (${(sv.speed * 3.6).toFixed(1)} km/h), bounce (${sv.bounce.slice(0, 2).map(v => v.toFixed(2)).join(', ')})`);
    for (const tr of allTracks) {
      const a = tr.pts[0].t, b = tr.pts.at(-1).t;
      if (b < sv.tStart - 0.3 || a > sv.tStart + 1.2) continue;
      const on = tr.pts.filter(p => { const P = sv.at(p.t); if (!P) return false; const q = truthCam.project(P); return Math.hypot(q[0] - p.u, q[1] - p.v) < 5; }).length;
      if (!on) continue;
      const firstOn = tr.pts.findIndex(p => { const P = sv.at(p.t); if (!P) return false; const q = truthCam.project(P); return Math.hypot(q[0] - p.u, q[1] - p.v) < 5; });
      log(`     track ${tr.id}: ${tr.pts.length} pts ${a.toFixed(3)}..${b.toFixed(3)}, on-ball ${on}, first on-ball index ${firstOn}`);
      window.__dump = window.__dump || []; window.__dump.push({ id: tr.id, serve: sv.tStart, obs: tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v })) });
    }
  }
  const detected = matched.size;
  const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
  const maxAbs = Math.max(0, ...errs.map(Math.abs));
  const pass = detected >= served.length - 1 && errs.length >= served.length - 2 && Math.abs(mean) < 2.5 && maxAbs < 7;
  log(`\nserves simulated ${served.length}, measured ${detected}; good/ok errors: mean ${mean.toFixed(2)}%, max |err| ${maxAbs.toFixed(1)}%`);
  log(pass ? 'RESULT PASS' : 'RESULT FAIL');
  out.className = pass ? 'pass' : 'fail';
  window.__e2e = { pass, served: served.length, detected, mean, maxAbs, results };
}
chunk();
