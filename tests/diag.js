// Detection / tracking diagnostics against ground truth on rendered demo frames.
import { demoCamera, SimScene } from '../js/simscene.js';
import { BallDetector } from '../js/detector.js';
import { Tracker } from '../js/tracker.js';

const q = new URLSearchParams(location.search);
const FROM = Number(q.get('from') || 2.0), TO = Number(q.get('to') || 4.6), FPS = Number(q.get('fps') || 60);
const out = document.getElementById('out'); out.textContent = '';
const log = s => { out.textContent += s + '\n'; };
const cam = demoCamera(1280, 720, q.get('placement') || 'offset');
const scene = new SimScene(cam, { seed: 21, fps: FPS });
const det = new BallDetector(); det.setup(cam, { maxW: 960 });
const tracks = [];
const tracker = new Tracker({ width: 1280, onTrack: tr => tracks.push(tr) });
const view = document.getElementById('view'); view.width = 1280; view.height = 720;
const vx = view.getContext('2d');
const truthPx = t => {
  const s = scene.serves[scene.serves.length - 1];
  if (!s || t < s.tStart) return null;
  const P = s.at(t); if (!P) return null;
  const p = cam.project(P);
  return p[2] > 0 ? [p[0], p[1]] : null;
};
let hits = 0, vis = 0, falseC = 0, frames = 0;
const rows = [];
scene.render(0.2); // same random sequence as e2e.js (it renders the calibration frame first)
for (let k = 0; ; k++) {
  const t = 0.5 + k / FPS; if (t > TO) break;
  const frame = scene.render(t);
  if (t < FROM) continue;
  const d = det.process(frame, t);
  if (!d) continue;
  frames++;
  const tp = truthPx(d.t);
  let near = null;
  if (tp) {
    vis++;
    for (const c of d.cands) { const e = Math.hypot(c.u - tp[0], c.v - tp[1]); if (!near || e < near.e) near = { e, c }; }
    if (near && near.e < 4) hits++;
  }
  falseC += d.cands.filter(c => !tp || Math.hypot(c.u - tp[0], c.v - tp[1]) > 6).length;
  if (tp) rows.push(`t=${d.t.toFixed(3)} truth (${tp[0].toFixed(1)},${tp[1].toFixed(1)}) nearest ${near ? near.e.toFixed(1) + 'px a=' + near.c.area.toFixed(0) + (near.c.busy ? ' busy' : '') : 'none'} cands ${d.cands.length}${d.noisy ? ' NOISY' : ''}`);
  tracker.push(d);
  if (Math.abs(t - (scene.serves.at(-1)?.tStart ?? 0) - 0.25) < 0.5 / FPS) vx.drawImage(frame, 0, 0);
}
tracker.flush();
log(`frames ${frames}, ball visible ${vis}, detected within 4 px ${hits} (${(100 * hits / Math.max(1, vis)).toFixed(0)}%), false candidates/frame ${(falseC / frames).toFixed(2)}`);
log(`tracks emitted ${tracks.length}`);
for (const tr of tracks) {
  const near = tr.pts.filter(p => { const tp = truthPx(p.t); return tp && Math.hypot(p.u - tp[0], p.v - tp[1]) < 5; }).length;
  log(`  track ${tr.id}: ${tr.pts.length} pts, t ${tr.pts[0].t.toFixed(3)}..${tr.pts.at(-1).t.toFixed(3)}, on-ball ${near}, start (${tr.pts[0].u.toFixed(0)},${tr.pts[0].v.toFixed(0)}) end (${tr.pts.at(-1).u.toFixed(0)},${tr.pts.at(-1).v.toFixed(0)})`);
}
log('\n' + rows.join('\n'));
window.__diag = true;
