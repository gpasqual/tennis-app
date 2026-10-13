import { t, setLang, getLang, applyDom, aboutContent, speechLang, fmtNum } from './i18n.js';
import { loadSettings, saveSettings, loadCalibration, saveCalibration, clearCalibration, loadShots, addShot, deleteShots, clearShots, listSessions } from './storage.js';
import { PRESETS, findPreset, findLens, zoomLabel, intrinsicsFor, hfovDeg } from './lenses.js';
import { CameraModel } from './camera.js';
import { Tracker } from './tracker.js';
import { Overlay, placementSvg } from './overlay.js';
import { Calibrator } from './calib.js';
import { startCamera, listCameras, FrameClock, frameLoop } from './sources.js';
import { ResultGate } from './results.js';
import { detectPhone } from './device.js';
import { StabView } from './stabilizer.js';
import { FramePipe } from './pipeline.js';
import { arcFit } from './trajectory.js';

export const VERSION = '1.11.0';
const $ = id => document.getElementById(id);

// ---------------- State ----------------
const S = {
  settings: loadSettings(),
  cal: loadCalibration(),     // saved calibration for the real camera
  fileCal: null, fileKey: '', // calibration of the video being analysed (each video has its own)
  cam: null,                  // CameraModel (source pixels) in use
  source: null,               // { kind: 'camera' | 'file', width, height }
  stream: null, stopLoop: null,
  running: false, session: null,
  pipe: new FramePipe(), detCfg: null, runId: 0, // the stabiliser and the detector run in a worker (pipeline.js)
  tracker: null, clock: new FrameClock(60),
  lastDet: null, lastResult: null, lastResultAt: 0, lastRecord: null,
  fps: { n: 0, t0: 0, value: 0 },
  wakeLock: null, calibrating: false, deviceList: [],
  stab: new StabView(), stabLost: 0, // small turns of the phone since calibrating (measured in the worker)
};
const overlay = new Overlay($('overlay'));

// ---------------- Worker RPC ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let rpcId = 0;
const pending = new Map();
worker.onmessage = e => {
  const { id, result, error } = e.data;
  const p = pending.get(id); if (!p) return;
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
function rpc(type, payload) {
  return new Promise((resolve, reject) => { const id = ++rpcId; pending.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }); });
}

// ---------------- Formatting ----------------
const imperial = () => S.settings.units === 'imperial';
const spd = ms => ms * (imperial() ? 2.23694 : 3.6);
const fmtSpd = ms => (ms == null ? '--' : String(Math.round(spd(ms))));
const unit = () => t(imperial() ? 'mph' : 'kmh');
const fmtLen = m => (imperial() ? `${fmtNum(m * 3.28084, 1)} ft` : `${fmtNum(m, 2)} m`);
const fmtCm = m => (imperial() ? `${Math.round(m * 39.37)} in` : `${Math.round(m * 100)} cm`);
const fmtTime = ts => new Date(ts).toLocaleTimeString(getLang() === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleString(getLang() === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function confirmDialog(text, okLabel = t('ok')) {
  return new Promise(resolve => {
    $('dialogText').textContent = text;
    const acts = $('dialogActions'); acts.innerHTML = '';
    const mk = (label, cls, val) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = () => { $('dialog').classList.add('hidden'); resolve(val); }; acts.appendChild(b); };
    mk(t('cancel'), '', false); mk(okLabel, 'primary', true);
    $('dialog').classList.remove('hidden');
  });
}
function busy(text) { if (text) { $('busyText').textContent = text; $('busy').classList.remove('hidden'); } else $('busy').classList.add('hidden'); }

// ---------------- Intrinsics & calibration ----------------
function currentIntrinsics(width, height) {
  return intrinsicsFor(S.settings, width, height);
}
function feqNow() {
  const p = findPreset(S.settings.preset);
  return p.id === 'custom' ? Number(S.settings.customFeq) || 26 : findLens(p, S.settings.lens).feq;
}

// Pick up the stored calibration for the current source (scaled if only the resolution changed).
// The calibration that belongs to a source: the saved one for the live camera, the video's own for a file.
function calFor(src) {
  if (!src) return null;
  if (src.kind === 'file') return S.fileCal && S.fileCal.key === S.fileKey ? S.fileCal : null;
  return S.cal;
}
function loadCalForSource() {
  S.cam = null;
  const src = S.source; if (!src) return;
  const cal = calFor(src);
  if (cal && Math.abs(cal.width / cal.height - src.width / src.height) < 0.01 && Math.abs(cal.feq - feqNow()) < 0.01) {
    S.cam = CameraModel.fromJSON(cal.cam).scaled(src.width, src.height);
  }
  updateChips();
}

function updateChips() {
  const p = findPreset(S.settings.preset), l = findLens(p, S.settings.lens);
  $('lensLabel').textContent = p.id === 'custom' ? `${t('lensCustom')} · ${S.settings.customFeq} mm` : `${presetName(p).split(' / ')[0]} · ${zoomLabel(p, l)}`;
  const cal = calFor(S.source);
  const stale = !S.cam && cal && S.source;
  $('calDot').className = 'dot' + (S.cam ? (cal?.focalWarn ? ' warn' : ' ok') : stale ? ' warn' : '');
  $('calLabel').textContent = S.cam ? t('calibrated') : t('notCalibrated');
  $('chipMode').classList.toggle('hidden', S.source?.kind !== 'file');
}

// ---------------- Sources ----------------
async function stopSource() {
  if (S.running) stopRun();
  S.stopLoop?.(); S.stopLoop = null;
  if (S.stream) { S.stream.getTracks().forEach(tr => tr.stop()); S.stream = null; }
  const v = $('video');
  v.pause(); v.removeAttribute('src'); v.srcObject = null; v.controls = false; v.load();
  $('frameView').classList.add('hidden');
  S.source = null;
  $('stage').classList.add('idle');
}

function sourceReady(kind, width, height) {
  S.source = { kind, width, height };
  S.stab = new StabView(); S.pipe.resetStab();
  $('empty').classList.add('hidden');
  $('stage').classList.remove('idle');
  overlay.fit(width, height);
  loadCalForSource();
  if (S.cam) return;
  // Not calibrated: start the calibration by itself (the live camera gets a moment to settle its
  // exposure and focus first)
  if (kind === 'file') startCalibration();
  else setTimeout(() => { if (S.source?.kind === kind && !S.cam && !S.calibrating) startCalibration(); }, 1500);
}

async function useCamera() {
  if (!window.isSecureContext) return toast(t('needsHttps'));
  await stopSource();
  try {
    const { stream } = await startCamera(S.settings);
    S.stream = stream;
    const v = $('video');
    v.srcObject = stream;
    await v.play();
    if (!v.videoWidth) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    S.clock = new FrameClock(S.settings.fps);
    S.stopLoop = frameLoop(v, onVideoFrame);
    sourceReady('camera', v.videoWidth, v.videoHeight);
    refreshDevices(true);
  } catch (e) {
    toast(e && e.name === 'NotAllowedError' ? t('cameraDenied') : t('cameraError', { e: e.message || e }), 5000);
  }
}

// Load a video file up to its first picture. iOS Safari decodes nothing until playback starts, so
// playback is started (muted) and stopped again on the first frame. Rejects when the browser cannot
// play the file (e.g. an iPhone HEVC/HDR clip on a browser without HEVC) or nothing arrives in time.
function loadVideo(v, url) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = err => {
      if (done) return;
      done = true; clearTimeout(timer);
      v.removeEventListener('loadeddata', onData); v.removeEventListener('error', onErr);
      err ? reject(err) : resolve();
    };
    const onData = () => finish();
    const onErr = () => finish(new Error(v.error?.message || 'decode'));
    const timer = setTimeout(() => finish(new Error('timeout')), 20000);
    v.addEventListener('loadeddata', onData); v.addEventListener('error', onErr);
    v.preload = 'auto';
    v.src = url;
    v.load();
    const p = v.play();
    if (p) p.then(() => v.pause()).catch(() => {});
  });
}
function seekTo(v, time) {
  return new Promise(resolve => {
    if (Math.abs(v.currentTime - time) < 1e-3) return resolve();
    const timer = setTimeout(resolve, 3000);
    v.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    v.currentTime = time;
  });
}

async function useFile(file) {
  await stopSource();
  const v = $('video');
  v.srcObject = null;
  v.muted = true; v.playsInline = true; v.controls = false;
  busy(t('loadingVideo'));
  try {
    await loadVideo(v, URL.createObjectURL(file));
    v.pause();
    await seekTo(v, 0);
    if (!v.videoWidth) throw new Error('no video');
  } catch (e) {
    busy(null);
    console.warn('video', e);
    v.removeAttribute('src'); v.load();
    return toast(t('videoError'), 9000);
  }
  busy(null);
  v.controls = true;
  // Start slowly enough that even a 240 fps clip shows every frame; the frame spacing then gives the
  // clip's frame rate and the playback speed is set so every frame is still analysed.
  v.playbackRate = 0.2;
  S.file = { gaps: [], fps: null };
  S.fileKey = `${file.name}|${file.size}|${file.lastModified}`;
  S.stopLoop = frameLoop(v, onVideoFrame);
  v.onended = () => { if (S.running) S.pipe.drain().then(() => { S.tracker?.flush(); gate.flush(); toast(t('fileEnded')); }); };
  // Scrubbing a paused video does not always fire the frame callback: follow the picture here too
  v.onseeked = () => {
    if (!S.cam || S.calibrating || S.running || S.settings.stabilize === false) return;
    if (S.stab.ready) analyse(v, v.currentTime).then(drawOverlay);
    drawOverlay();
  };
  // Show the first picture right away (a paused video stays black on some phones)
  sourceReady('file', v.videoWidth, v.videoHeight);
}

function measureFileFps(meta) {
  const F = S.file; if (!F || F.fps || meta.mediaTime == null) return;
  if (F.last != null && meta.mediaTime > F.last) F.gaps.push(meta.mediaTime - F.last);
  F.last = meta.mediaTime;
  if (F.gaps.length < 12) return;
  const gap = F.gaps.slice().sort((a, b) => a - b)[2]; // a low quantile: the true frame spacing
  F.fps = Math.round(1 / gap);
  if (!S.running) $('video').playbackRate = 1;
  if (F.fps >= 90) toast(t('slowmoClip', { fps: F.fps }), 5000);
}

// Analysing a video: it must never run ahead of the analysis — every frame counts (at 30 fps a serve
// moves 1-2 m between frames, and the detector compares neighbouring frames). Frames not analysed (a gap
// in media time: the worker had a queue) slow the playback down; an analysis that keeps up with room to
// spare lets it speed up again, up to real time.
const FILE_RATE0 = 0.25;
function paceFile(meta, r) {
  const F = S.file, v = $('video');
  if (!F || !S.running || meta.mediaTime == null || !r) return; // a frame left out shows as a gap at the next one
  const dt = F.fps ? 1 / F.fps : 1 / 30;
  if (F.lastRun != null && meta.mediaTime > F.lastRun) {
    const gap = meta.mediaTime - F.lastRun;
    if (gap > 1.5 * dt) {
      F.skipped = (F.skipped || 0) + Math.round(gap / dt) - 1;
      v.playbackRate = Math.max(0.05, v.playbackRate * 0.7);
      F.calm = 0;
    } else if (++F.calm > 45 && r.ms < 0.7 * dt * 1000 / v.playbackRate) {
      v.playbackRate = Math.min(1, Math.max(0.05, v.playbackRate * 1.15));
      F.calm = 0;
    }
  }
  F.lastRun = meta.mediaTime;
}

function onVideoFrame(now, meta) {
  const v = $('video');
  if (S.source?.kind === 'file') measureFileFps(meta);
  const t = S.source?.kind === 'file' ? (meta.mediaTime ?? v.currentTime) / (Number(S.settings.slowmo) || 1) : S.clock.stamp(now, meta);
  S.frameT = t;
  fpsMeter(t);
  const done = analyse(v, t, meta);
  drawOverlay();
  return done;
}

function fpsMeter(ts) {
  const f = S.fps;
  if (!f.t0) f.t0 = ts;
  f.n++;
  if (ts - f.t0 >= 1) { f.value = f.n / (ts - f.t0); f.n = 0; f.t0 = ts; $('chipFps').textContent = `${Math.round(f.value)} fps`; $('chipFps').classList.remove('hidden'); }
  else if (ts < f.t0) { f.t0 = ts; f.n = 0; }
}

// A frame to the worker: a phone that is not perfectly still is registered against the calibration
// frame on every frame — also before Start, so the court drawn on the picture follows it — and, while
// running, the detector resamples the frame into the calibrated view and looks for the ball. The result
// comes back a frame or two later, in order.
function analyse(src, ts, meta = null) {
  if (!S.cam || S.calibrating) return Promise.resolve();
  const stabilize = S.settings.stabilize !== false;
  if (!stabilize && !S.running) return Promise.resolve();
  const file = S.source?.kind === 'file', run = S.runId, running = S.running;
  return S.pipe.frame(src, ts, S.cam, { stabilize, detect: running, maxQueue: file ? 3 : 2 }).then(r => {
    if (file && running && meta) paceFile(meta, r);
    if (!r) return;
    if (r.st) {
      if (!r.st.ok) { if (++S.stabLost === 45) toast(t('phoneMoved'), 6000); return; }
      S.stabLost = 0;
      S.stab.set(S.cam, r.st.R);
    }
    // a frame sent before Stop (or in the run before) does not count
    if (!running || run !== S.runId || !r.det || !S.tracker) return;
    S.lastDet = r.det;
    if (!r.det.noisy) S.tracker.push(r.det);
    drawOverlay();
  });
}

// ---------------- Overlay ----------------
// The track to highlight as the ball: the one with the longest recent steady run — steady direction and
// pace from point to point, as a flying ball moves; an arm, a racket or a player's shadow can be as
// fast, but only in short jerky bursts, and a chain of stray detections not at all.
function liveBall() {
  const tNow = S.lastDet?.t;
  if (tNow == null) return null;
  const scored = [];
  for (const tr of S.tracker.confirmed()) {
    const p = tr.pts.slice(-15), n = p.length, last = p[n - 1];
    if (n < 4 || tNow - last.t > 0.15) continue;
    const vel = [];
    for (let i = 1; i < n; i++) { const dt = Math.max(1e-3, p[i].t - p[i - 1].t); vel.push([(p[i].u - p[i - 1].u) / dt, (p[i].v - p[i - 1].v) / dt]); }
    const steady = (a, b) => { const na = Math.hypot(...a), nb = Math.hypot(...b); return na && nb && nb / na <= 2 && na / nb <= 2 && (a[0] * b[0] + a[1] * b[1]) / (na * nb) >= Math.cos(35 * Math.PI / 180); };
    // a run also ends at a gap of more than two frames (the bounce often hides in one)
    const dts = []; for (let i = 1; i < n; i++) dts.push(p[i].t - p[i - 1].t);
    const frame = dts.slice().sort((a, b) => a - b)[0] || 1 / 30;
    let k = vel.length - 1;
    while (k > 0 && steady(vel[k - 1], vel[k]) && dts[k - 1] <= 2.5 * frame) k--;
    if (dts[vel.length - 1] > 2.5 * frame) continue; // the latest step is itself across a gap
    const run = vel.length - k + 1; // points in the latest steady run
    if (run < 4) continue;
    // and it must look like the ball: on average yellower than what it passes over (a racket swinging
    // up at contact moves like a ball for a few frames, but is not yellow)
    const runPts = p.slice(n - run);
    if (runPts.reduce((s, q) => s + (q.yg ?? 0), 0) / run < 6) continue;
    const from = p[n - run];
    scored.push({ tr, run: p.slice(n - run), score: Math.hypot(last.u - from.u, last.v - from.v) });
  }
  scored.sort((a, b) => b.score - a.score);
  // The ball being highlighted keeps the ring while it still moves like one, unless another track does
  // clearly better (no flicker to a player for a frame)
  const cur = scored.find(x => x.tr.id === S.ballId);
  const pick = cur && cur.score >= 0.67 * scored[0].score ? cur : scored[0];
  if (!pick || pick.score < 0.05 * S.source.width) { S.ballId = null; return null; }
  S.ballId = pick.tr.id;
  return pick;
}

// What is drawn for the ball: not the raw detections but a smooth curve through the latest steady run
// (a ball arc in perspective), the ring on it at the frame on screen. Short gaps (a missed frame, the
// ball passing a player) are bridged along the curve for a few frames, then the ring fades out.
const BRIDGE = 0.17; // s
function ballView() {
  const live = liveBall();
  if (live) {
    const fit = arcFit(live.run.map(p => ({ t: p.t, u: p.u, v: p.v })));
    if (fit) S.ballFit = { fit, t0: live.run[0].t, tLast: live.run[live.run.length - 1].t };
  }
  // The picture on screen is a frame or two ahead of the analysis (the worker): the ring is drawn where
  // the curve puts the ball now, its age counted from the latest analysed frame
  const bf = S.ballFit, tNow = S.frameT, tSeen = Math.min(tNow ?? 0, S.lastDet?.t ?? tNow ?? 0);
  if (!bf || tNow == null || tSeen - bf.tLast > BRIDGE || tNow < bf.t0 || tNow - tSeen > 0.15) return null;
  const alpha = tSeen - bf.tLast <= 0.07 ? 1 : 1 - (tSeen - bf.tLast - 0.07) / (BRIDGE - 0.07);
  return { at: t => bf.fit.at(t), from: Math.max(bf.t0, tNow - 0.6), to: tNow, alpha };
}
function drawOverlay() {
  if (S.calibrating) return;
  overlay.clear();
  if (!S.cam) return;
  // the court as it sits in the current picture (the phone may have turned a little since calibrating)
  const camView = S.stab.ready ? S.stab.camera(S.cam) : S.cam;
  overlay.court(camView, { color: S.running ? 'rgba(57,224,124,0.35)' : 'rgba(57,224,124,0.7)', width: 1.2, net: false });
  overlay.setView(S.stab.ready ? S.stab.refToCur() : null);
  if (S.running && S.tracker) overlay.ball(ballView());
  if (S.settings.debug && S.running) {
    overlay.polygon(S.detCfg?.hull, 'rgba(255,255,255,0.35)');
    if (S.lastDet) overlay.candidates(S.lastDet.cands);
    if (S.tracker) overlay.tracks(S.tracker.confirmed());
  }
  if (S.lastResult) {
    const age = (performance.now() - S.lastResultAt) / 1000;
    if (age < 5) overlay.flight(camView, S.lastResult, age < 3.5 ? 1 : (5 - age) / 1.5);
  }
}
const refit = () => { if (S.source) overlay.fit(); drawOverlay(); calibrator.draw(); };
window.addEventListener('resize', refit);
if (window.ResizeObserver) new ResizeObserver(refit).observe($('stage'));

// ---------------- Run / stop ----------------
function startRun() {
  if (!S.source) return toast(t('noSource'));
  if (!S.cam) return toast(t('noCalibration'));
  S.session = Date.now();
  gate.reset();
  S.runId++;
  S.detCfg = null;
  S.pipe.setup(S.cam, { maxW: Number(S.settings.procW), sensitivity: Number(S.settings.sensitivity) }).then(cfg => { S.detCfg = cfg; });
  S.tracker = new Tracker({ width: S.source.width, onTrack });
  S.running = true;
  if (S.source.kind === 'file') {
    const v = $('video');
    // A video is analysed slower than real time when the device needs it (see paceFile)
    S.file.lastRun = null; S.file.calm = 0; S.file.skipped = 0;
    v.playbackRate = FILE_RATE0;
    if (v.ended) v.currentTime = 0;
    if (v.paused) v.play();
    toast(t('fileAnalysing'), 5000);
  }
  if (S.settings.keepAwake) requestWakeLock();
  renderRunButton(); renderSession();
}
function stopRun() {
  S.running = false; S.runId++;
  if (S.source?.kind === 'file') $('video').playbackRate = 1;
  S.tracker?.flush();
  gate.flush();
  S.pipe.reset();
  releaseWakeLock();
  renderRunButton();
}
function renderRunButton() {
  $('btnRun').classList.toggle('on', S.running);
  $('runIcon').setAttribute('href', S.running ? '#i-stop' : '#i-play');
  $('runLabel').textContent = t(S.running ? 'stop' : 'start');
}
async function requestWakeLock() { try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ } }
function releaseWakeLock() { try { S.wakeLock?.release(); } catch { /* ignore */ } S.wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.running && S.settings.keepAwake) requestWakeLock(); });

// ---------------- Analysis ----------------
function physics() { return { tempC: Number(S.settings.tempC), altitude: Number(S.settings.altitude), cd: Number(S.settings.cd) }; }

const gate = new ResultGate(res => onResult(res));
function onTrack(track) {
  const cam = S.cam; if (!cam) return;
  const pxNoise = Math.max(0.7, 1 / (S.detCfg?.scale || 1));
  const obs = track.pts.map(p => ({ t: p.t, u: p.u, v: p.v }));
  const session = S.session;
  rpc('analyze', { obs, cam: cam.toJSON(), physics: physics(), pxNoise, serveOnly: S.settings.shots === 'serves' })
    .then(res => {
      if (!res || !res.plausible || session !== S.session) return;
      if (S.settings.shots === 'serves' && res.kind !== 'serve') return;
      gate.push(res);
    })
    .catch(err => console.warn('analysis failed', err));
}

function onResult(res) {
  const session = S.session;
  const rec = {
    id: Date.now() + Math.random(), ts: Date.now(), session,
    kind: res.kind, speed: res.speed, sigma: res.sigma, quality: res.quality,
    side: res.side, margin: res.margin, landing: res.landing, landingObserved: res.landingObserved,
    impact: res.impact, clearance: res.clearance, flight: res.flight, speedAtBounce: res.speedAtBounce, avgSpeed: res.avgSpeed,
    n: res.n, fps: Math.round(S.fps.value), source: S.source?.kind,
  };
  addShot(rec);
  S.lastResult = res; S.lastResultAt = performance.now(); S.lastRecord = rec;
  renderLast(rec); renderSession(); flash(rec); speak(rec);
}

function speak(rec) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(String(Math.round(spd(rec.speed))));
    u.lang = speechLang(); u.rate = 1.05;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
function flash(rec) {
  const el = $('flash');
  $('flashVal').textContent = fmtSpd(rec.speed); $('flashUnit').textContent = unit();
  el.classList.add('hidden'); void el.offsetWidth; el.classList.remove('hidden');
}

// ---------------- Panel ----------------
function callTag(rec) {
  if (rec.margin == null) return null;
  const close = Math.abs(rec.margin) < 0.08;
  if (close) return ['close', t('closeTag')];
  return rec.margin <= 0 ? ['in', t('inTag')] : ['out', t('outTag')];
}
function renderLast(rec) {
  const serveMode = S.settings.shots === 'serves';
  $('scLabel').textContent = rec ? t(rec.kind === 'serve' ? 'lastServe' : 'lastShot') : t(serveMode ? 'lastServe' : 'lastShot');
  $('speedUnit').textContent = unit();
  if (!rec) {
    $('speedVal').textContent = '--';
    $('speedSub').textContent = t(serveMode ? 'waiting' : 'waitingShot');
    $('speedTags').innerHTML = '';
    for (const id of ['dImpact', 'dNet', 'dBounce', 'dFlight']) $(id).textContent = '--';
    return;
  }
  $('speedVal').textContent = fmtSpd(rec.speed);
  const q = { good: 'qGood', ok: 'qOk', poor: 'qPoor' }[rec.quality];
  $('speedSub').innerHTML = `${rec.sigma != null ? `± ${Math.max(1, Math.round(spd(rec.sigma)))} ${unit()} · ` : ''}<span class="q-${rec.quality}">${t(q)}</span>`;
  const tags = [];
  if (rec.side) tags.push(`<span class="tag">${t(rec.side)}</span>`);
  const call = callTag(rec);
  if (call) tags.push(`<span class="tag ${call[0]}">${call[1]}</span>`);
  $('speedTags').innerHTML = tags.join('');
  $('dImpact').textContent = rec.impact ? fmtLen(rec.impact[2]) : '--';
  $('dNet').textContent = rec.clearance != null ? fmtCm(rec.clearance) : '--';
  $('dBounce').textContent = rec.speedAtBounce != null ? fmtSpd(rec.speedAtBounce) : '--';
  $('dFlight').textContent = rec.flight != null ? `${fmtNum(rec.flight, 2)} s` : '--';
}
function sessionShots() {
  if (!S.session) return [];
  return loadShots().filter(r => r.session === S.session);
}
function statsOf(shots) {
  const ok = shots.filter(s => s.quality !== 'poor');
  const sp = ok.map(s => s.speed);
  const called = shots.filter(s => s.margin != null);
  return {
    n: shots.length,
    max: sp.length ? Math.max(...sp) : null,
    avg: sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null,
    inPct: called.length ? Math.round(100 * called.filter(s => s.margin <= 0).length / called.length) : null,
  };
}
function renderSession() {
  const shots = sessionShots();
  const st = statsOf(shots);
  $('sCount').textContent = st.n; $('sMax').textContent = fmtSpd(st.max); $('sAvg').textContent = fmtSpd(st.avg);
  $('sIn').textContent = st.inPct == null ? '--' : `${st.inPct}%`;
  placementSvg($('miniCourt'), shots, { highlight: S.lastRecord?.id });
  const ol = $('recent'); ol.innerHTML = '';
  for (const s of shots.slice(-6).reverse()) {
    const call = callTag(s);
    const li = document.createElement('li');
    li.innerHTML = `<b class="q-${s.quality === 'poor' ? 'poor' : ''}">${fmtSpd(s.speed)}</b><span class="muted">${fmtTime(s.ts)}</span><span class="muted">${s.side ? t(s.side) : ''}</span>${call ? `<span class="tag ${call[0]}">${call[1]}</span>` : '<span></span>'}`;
    ol.appendChild(li);
  }
}

// ---------------- Calibration ----------------
const calibrator = new Calibrator({ overlay, frameCanvas: $('frameView'), loupe: $('loupe'), info: $('calibInfo'), rpc, t });

function grabFrame() {
  const fv = $('frameView'), src = S.source;
  fv.width = src.width; fv.height = src.height;
  const ctx = fv.getContext('2d');
  ctx.drawImage($('video'), 0, 0, src.width, src.height);
  fv.classList.remove('hidden');
}

async function startCalibration() {
  if (!S.source) return toast(t('noSource'));
  if (S.running) stopRun();
  // The frozen frame covers the video: its controls would only show through the letterbox
  if (S.source.kind === 'file') { $('video').pause(); $('video').controls = false; }
  grabFrame();
  S.calibrating = true;
  $('app').classList.add('calibrating');
  $('stage').classList.add('calibrating');
  $('calibBar').classList.remove('hidden');
  $('panel').scrollTop = 0;
  overlay.fit();
  const intr = currentIntrinsics(S.source.width, S.source.height);
  const p = findPreset(S.settings.preset);
  const lenses = p.id === 'custom' ? null : p.lenses.map(l => ({ id: l.id, feq: l.feq, label: lensName(p, l) }));
  calibrator.begin({
    intr, initialCam: S.cam, lenses, lens: S.settings.lens,
    // The court shows that another of the phone's lenses is in use: select it (the camera stays as is).
    // A video may come from any lens: it does not change the setting.
    onLens: S.source.kind !== 'camera' ? null : id => { S.settings.lens = id; saveSettings(S.settings); renderLensSeg(); updateChips(); toast(t('lensSwitched', { lens: lensName(p, findLens(p, id)) }), 5000); },
  });
  if (!S.cam) await runAuto();
}
async function runAuto() {
  busy(t('findingCourt'));
  try { await calibrator.auto(); } catch (e) { toast(String(e.message || e)); } finally { busy(null); }
}
async function runSnap() {
  busy(t('refining'));
  try { await calibrator.snap(); } catch (e) { toast(String(e.message || e)); } finally { busy(null); }
}
function endCalibration() {
  S.calibrating = false;
  calibrator.end();
  $('app').classList.remove('calibrating');
  $('stage').classList.remove('calibrating');
  $('calibBar').classList.add('hidden');
  overlay.fit();
  if (S.source?.kind === 'file') $('video').controls = true;
  $('frameView').classList.add('hidden');
  drawOverlay();
}
async function useCalibration() {
  const cam = calibrator.cam, src = S.source;
  if (!cam || !src || !S.calibrating) return;
  const fc = calibrator.focalCheck();
  const cal = { cam: cam.toJSON(), width: src.width, height: src.height, feq: feqNow(), preset: S.settings.preset, lens: S.settings.lens, ts: Date.now(), rms: calibrator.result?.rms ?? null, focalWarn: fc ? fc.ok === false : false };
  // The frame the court was found on is the reference the stabiliser registers every frame against
  S.stab = new StabView(); S.stab.set(cam, [1, 0, 0, 0, 1, 0, 0, 0, 1]); S.pipe.setReference($('frameView'), cam);
  if (src.kind === 'file') S.fileCal = { ...cal, key: S.fileKey };
  else { S.cal = cal; saveCalibration(cal); }
  S.cam = cam;
  endCalibration();
  updateChips();
  toast(t('calSaved'));
  estimatePlacement(cam);
}

// Expected accuracy for this camera position: simulated serves through the real pipeline maths.
async function estimatePlacement(cam) {
  const det = new BallDetector();
  det.setup(cam, { maxW: Number(S.settings.procW) });
  const hull = det.cfg.hull;
  const roi = [Math.max(0, Math.min(...hull.map(p => p[0]))), Math.max(0, Math.min(...hull.map(p => p[1]))), Math.min(cam.width, Math.max(...hull.map(p => p[0]))), Math.min(cam.height, Math.max(...hull.map(p => p[1])))];
  const fps = Math.round(S.fps.value) || Number(S.settings.fps);
  try {
    const r = await rpc('placement', { cam: cam.toJSON(), fps: Math.max(24, Math.min(240, fps)), pxNoise: Math.max(0.7, 1 / det.cfg.scale), physics: physics(), roi });
    // Typical (75th percentile) error of simulated serves through this camera; fits that failed count as bad
    const pctOf = e => (e.err75 == null || e.fitted < e.total * 0.6 ? 99 : 100 * e.err75);
    const fmt = e => { const p = pctOf(e); return p >= 99 ? '?' : String(Math.max(1, Math.round(p))); };
    // Name the ends as the user sees them: near / far from behind, left / right from the side
    const side = Math.abs(cam.C[0]) > Math.abs(cam.C[1]);
    const nameOf = y => {
      if (!side) return y < 0 ? 'nearBase' : 'farBase';
      const q = cam.project([0, y, 0]);
      return q[0] < cam.width / 2 ? 'leftBase' : 'rightBase';
    };
    let msg = t('accuracy', { n: fmt(r.near), a: t(nameOf(-11.5)), f: fmt(r.far), b: t(nameOf(11.5)), fps: Math.round(fps) });
    for (const [y, e] of [[-11.5, r.near], [11.5, r.far]]) {
      const p = pctOf(e);
      if (p > 6) msg += ' ' + t('accuracyBad', { end: t(nameOf(y)), n: p >= 99 ? '?' : Math.round(p) });
      if (e.bounceSeen < e.total / 2) msg += ' ' + t('bounceOut');
    }
    // The ball must be seen right off the racket: contact points ~2.4–3.1 m up near each baseline
    for (const [end, y] of [-11.5, 11.5].map(y => [nameOf(y), y])) {
      const out = [-1.2, 1.2].some(x => [2.4, 3.1].some(z => { const q = cam.project([x, y, z]); return q[2] <= 0 || q[0] < 0 || q[1] < 0 || q[0] > cam.width || q[1] > cam.height; }));
      if (out) msg += ' ' + t('contactOut', { end: t(end) });
    }
    toast(msg, 9000);
    const cal = calFor(S.source);
    if (cal) { cal.accuracy = r; if (S.source?.kind === 'camera') saveCalibration(cal); }
  } catch (e) { console.warn(e); }
}

// ---------------- Sheets & menu ----------------
function openSheet(id) { document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden')); $(id).classList.remove('hidden'); $('menu').classList.add('hidden'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden')); }
document.querySelectorAll('.sheet').forEach(sh => {
  sh.addEventListener('click', e => { if (e.target === sh) sh.classList.add('hidden'); });
  sh.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => sh.classList.add('hidden')));
});

function segBind(id, key, onChange, cast = v => v) {
  const seg = $(id);
  const render = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(S.settings[key]) === b.dataset.v));
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.settings[key] = cast(b.dataset.v); saveSettings(S.settings); render(); onChange?.();
  });
  render();
  return render;
}

// Camera & lens sheet
const presetName = p => (p.id === 'android' ? t('presetOther') : p.id === 'custom' ? t('presetCustom') : p.name);
function buildPresetSelect() {
  const sel = $('presetSel'); sel.innerHTML = '';
  // First entry: the detected phone (followed automatically until the user picks a model)
  const auto = document.createElement('option');
  auto.value = '__auto';
  auto.textContent = `${t('autoDetected')}: ${S.detected?.label || presetName(findPreset(S.detected?.preset || S.settings.preset))}`;
  sel.appendChild(auto);
  const brands = [...new Set(PRESETS.map(p => p.brand))];
  for (const b of brands) {
    const g = document.createElement('optgroup'); g.label = b === 'Other' ? t('brandOther') : b;
    for (const p of PRESETS.filter(p => p.brand === b)) { const o = document.createElement('option'); o.value = p.id; o.textContent = presetName(p); g.appendChild(o); }
    sel.appendChild(g);
  }
  sel.value = S.settings.presetAuto ? '__auto' : S.settings.preset;
}
// Detected phone -> preset (keeps the ultra-wide as the default lens when the phone has one)
function applyPreset(id) {
  S.settings.preset = id;
  const ls = findPreset(id).lenses;
  if (!ls.find(l => l.id === S.settings.lens)) S.settings.lens = (ls.find(l => l.id === 'uw') || ls[0]).id;
}
const lensName = (p, l) => {
  const name = { main: t('lensMain'), uw: t('lensUw'), tele: t('lensTele'), tele2: t('lensTele'), custom: t('lensCustom') }[l.id];
  return p.id === 'custom' ? name : `${zoomLabel(p, l)} ${name}`;
};
function renderLensSeg() {
  const p = findPreset(S.settings.preset);
  if (!p.lenses.find(l => l.id === S.settings.lens)) S.settings.lens = p.lenses[0].id;
  const seg = $('lensSeg'); seg.innerHTML = '';
  for (const l of p.lenses) {
    const b = document.createElement('button'); b.dataset.v = l.id;
    b.textContent = lensName(p, l);
    b.classList.toggle('on', l.id === S.settings.lens);
    seg.appendChild(b);
  }
  $('customBox').classList.toggle('hidden', p.id !== 'custom');
  $('customFeq').value = S.settings.customFeq;
  renderIntrInfo();
}
function renderIntrInfo() {
  const feq = feqNow();
  if (S.source) {
    const i = intrinsicsFor(S.settings, S.source.width, S.source.height);
    $('intrInfo').textContent = t('intrInfo', { f: Math.round(i.f), fov: hfovDeg(feq).toFixed(0), w: S.source.width, h: S.source.height });
  } else $('intrInfo').textContent = t('intrInfoNoVideo', { feq, fov: hfovDeg(feq).toFixed(0) });
}
function lensChanged(byUser = false) {
  saveSettings(S.settings); renderLensSeg(); loadCalForSource(); updateChips();
  // A lens chosen by the user: switch to the matching physical camera when the labels tell (iPhone)
  if (byUser && S.source?.kind === 'camera') { S.settings.deviceId = ''; saveSettings(S.settings); refreshDevices(true); }
}
$('presetSel').addEventListener('change', e => {
  S.settings.presetAuto = e.target.value === '__auto';
  S.settings.preset = S.settings.presetAuto ? (S.detected?.preset || S.settings.preset) : e.target.value;
  const ls = findPreset(S.settings.preset).lenses;
  S.settings.lens = (ls.find(l => l.id === 'uw') || ls[0]).id; // the recommended side-of-court setup uses the ultra-wide
  lensChanged(true);
});
$('lensSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.settings.lens = b.dataset.v; lensChanged(true); });
$('customFeq').addEventListener('change', e => { S.settings.customFeq = Math.max(8, Math.min(300, Number(e.target.value) || 26)); lensChanged(); });

async function refreshDevices(autoPick = false) {
  try {
    const cams = await listCameras();
    S.deviceList = cams;
    const sel = $('deviceSel');
    sel.innerHTML = `<option value="">${t('autoBack')}</option>`;
    for (const c of cams.filter(c => c.type !== 'front')) {
      const o = document.createElement('option'); o.value = c.id; o.textContent = c.label + (c.type === 'virtual' ? ' ⚠' : ''); sel.appendChild(o);
    }
    sel.value = S.settings.deviceId;
    // No camera chosen by hand: use the physical camera that matches the selected lens (iPhone labels
    // name them; Android labels do not, and the court calibration then tells which lens is in use)
    if (autoPick && !S.settings.deviceId && S.source?.kind === 'camera') {
      const want = S.settings.lens === 'uw' ? 'uw' : S.settings.lens.startsWith('tele') ? 'tele' : 'main';
      const match = cams.find(c => c.type === want);
      const activeId = S.stream?.getVideoTracks()[0]?.getSettings().deviceId;
      if (match && match.id !== activeId) { S.settings.deviceId = match.id; saveSettings(S.settings); sel.value = match.id; useCamera(); }
    }
  } catch { /* no permission yet */ }
}
$('deviceSel').addEventListener('change', e => { S.settings.deviceId = e.target.value; saveSettings(S.settings); if (S.source?.kind === 'camera') useCamera(); });

function placementGuide() {
  // Top view: good spots (green), acceptable (amber), avoid (red)
  const svg = `<svg viewBox="-12 -16 24 32" xmlns="http://www.w3.org/2000/svg">
    <rect x="-5.5" y="-11.9" width="11" height="23.8" fill="#1d3550"/>
    <g stroke="#e8eaee" stroke-width="0.12" fill="none"><rect x="-5.485" y="-11.885" width="10.97" height="23.77"/><path d="M-4.115 -11.885V11.885M4.115 -11.885V11.885M-4.115 -6.4H4.115M-4.115 6.4H4.115M0 -6.4V6.4"/></g>
    <path d="M-6.4 0H6.4" stroke="#9aa0aa" stroke-width="0.2" stroke-dasharray="0.4 0.3"/>
    <circle cx="0.8" cy="11.5" r="0.45" fill="#d4f23a"/><circle cx="-0.8" cy="-11.5" r="0.45" fill="#d4f23a"/>
    <g fill="#39e07c" opacity="0.95"><rect x="10.2" y="-1.2" width="1.8" height="2.4" rx="0.5"/><rect x="-12" y="-1.2" width="1.8" height="2.4" rx="0.5"/></g>
    <g stroke="#39e07c" stroke-width="0.18" fill="none" opacity="0.7"><path d="M10.2 0 L1.5 -11.5M10.2 0 L1.5 11.5"/></g>
    <text x="11.1" y="3.0" font-size="1.3" font-weight="700" fill="#39e07c" text-anchor="middle">0.5×</text>
    <g fill="#ffb43a" opacity="0.9"><path d="M3 14.5 L7.5 13.5 L8.5 16 L3.5 16.5z"/></g>
    <circle cx="0" cy="15.2" r="0.9" fill="#ff5050"/>
  </svg>`;
  const tips = t('placementTips').map(s => `<li>${s}</li>`).join('');
  $('placementGuide').innerHTML = svg + `<ul>${tips}</ul>`;
}

// Settings sheet
function bindSettings() {
  segBind('resSeg', 'resolution', () => { if (S.source?.kind === 'camera') useCamera(); });
  segBind('fpsSeg', 'fps', () => { if (S.source?.kind === 'camera') useCamera(); }, Number);
  segBind('unitSeg', 'units', () => { renderLast(S.lastRecord); renderSession(); });
  langSegRender = segBind('langSeg', 'lang', () => setLanguage(S.settings.lang));
  segBind('shotsSeg', 'shots', () => renderLast(S.lastRecord));
  segBind('procSeg', 'procW', () => { if (S.running && S.cam) S.pipe.setup(S.cam, { maxW: Number(S.settings.procW), sensitivity: Number(S.settings.sensitivity) }).then(cfg => { S.detCfg = cfg; }); }, Number);
  segBind('sensSeg', 'sensitivity', () => { S.pipe.sensitivity(Number(S.settings.sensitivity)); }, Number);
  segBind('slowSeg', 'slowmo', null, Number);
  const chk = (id, key, after) => { const el = $(id); el.checked = !!S.settings[key]; el.addEventListener('change', () => { S.settings[key] = el.checked; saveSettings(S.settings); after?.(); }); };
  chk('optVoice', 'voice'); chk('optAwake', 'keepAwake', () => { if (S.running) (S.settings.keepAwake ? requestWakeLock() : releaseWakeLock()); }); chk('optDebug', 'debug');
  const num = (id, key, lo, hi) => { const el = $(id); el.value = S.settings[key]; el.addEventListener('change', () => { const v = Number(el.value); if (isFinite(v)) { S.settings[key] = Math.max(lo, Math.min(hi, v)); saveSettings(S.settings); } el.value = S.settings[key]; }); };
  num('optTemp', 'tempC', -10, 45); num('optAlt', 'altitude', -100, 4000); num('optCd', 'cd', 0.4, 0.8);
  $('btnResetCal').addEventListener('click', async () => { if (await confirmDialog(t('confirmResetCal'), t('delete'))) { clearCalibration(); S.cal = null; loadCalForSource(); toast(t('deleted')); } });
  $('btnClearShots').addEventListener('click', async () => { if (await confirmDialog(t('confirmClear'), t('delete'))) { clearShots(); renderSession(); toast(t('deleted')); } });
  $('btnAbout2').addEventListener('click', () => { renderAbout(); openSheet('sheetAbout'); });
  $('verLabel').textContent = VERSION;
}

function renderAbout() {
  const body = $('aboutBody'); body.innerHTML = '';
  for (const [h, ps] of aboutContent()) {
    body.insertAdjacentHTML('beforeend', `<h3>${h}</h3>`);
    if (ps) ps.forEach(p => body.insertAdjacentHTML('beforeend', `<p>${p}</p>`));
    else body.insertAdjacentHTML('beforeend', `<ul>${t('placementTips').map(s => `<li>${s}</li>`).join('')}</ul>`);
  }
  body.insertAdjacentHTML('beforeend', `<p class="muted mono">SERVE-NG ${VERSION}</p>`);
}

// History
function renderHistory() {
  const list = $('historyList'); list.innerHTML = '';
  const sessions = listSessions();
  if (!sessions.length) { list.innerHTML = `<p class="hint">${t('noSessions')}</p>`; return; }
  for (const s of sessions) {
    const st = statsOf(s.shots);
    const b = document.createElement('button'); b.className = 'sess-item';
    b.innerHTML = `<span class="when">${fmtDate(s.start)}</span><span class="big">${fmtSpd(st.max)}</span><span class="meta">${t('sessionShots', { n: st.n })} · ${t('avg')} ${fmtSpd(st.avg)} ${unit()}${st.inPct != null ? ` · ${t('inPct')} ${st.inPct}%` : ''}</span>`;
    b.addEventListener('click', () => openSession(s.id));
    list.appendChild(b);
  }
}
let openSessionId = null;
function openSession(id) {
  openSessionId = id;
  const s = listSessions().find(x => x.id === id); if (!s) return;
  const st = statsOf(s.shots);
  $('sessTitle').textContent = fmtDate(s.start);
  $('sessStats').innerHTML = `<div><b>${st.n}</b><small>${t('serves')}</small></div><div><b>${fmtSpd(st.max)}</b><small>${t('max')}</small></div><div><b>${fmtSpd(st.avg)}</b><small>${t('avg')}</small></div><div><b>${st.inPct == null ? '--' : st.inPct + '%'}</b><small>${t('inPct')}</small></div>`;
  placementSvg($('sessCourt'), s.shots);
  const rows = s.shots.slice().reverse().map(r => {
    const call = callTag(r);
    return `<tr><td>${fmtTime(r.ts)}</td><td><b>${fmtSpd(r.speed)}</b> <span class="muted">±${r.sigma != null ? Math.max(1, Math.round(spd(r.sigma))) : '?'}</span></td><td>${r.side ? t(r.side) : ''}</td><td>${call ? `<span class="tag ${call[0]}">${call[1]}</span>` : ''}</td><td class="q-${r.quality}">${t({ good: 'qGood', ok: 'qOk', poor: 'qPoor' }[r.quality])}</td></tr>`;
  }).join('');
  $('sessTable').innerHTML = `<tr><th>${t('colTime')}</th><th>${t('colSpeed')} (${unit()})</th><th>${t('colSide')}</th><th>${t('colCall')}</th><th>${t('colQ')}</th></tr>${rows}`;
  openSheet('sheetSession');
}
function toCsv(shots) {
  const head = ['time', 'kind', 'speed_kmh', 'sigma_kmh', 'quality', 'side', 'call_margin_m', 'bounce_x_m', 'bounce_y_m', 'contact_height_m', 'net_clearance_m', 'speed_at_bounce_kmh', 'flight_s', 'points', 'fps'];
  const f = (v, d = 1) => (v == null ? '' : Number(v).toFixed(d));
  const lines = shots.map(r => [new Date(r.ts).toISOString(), r.kind, f(r.speed * 3.6), f(r.sigma != null ? r.sigma * 3.6 : null), r.quality, r.side || '', f(r.margin, 2), f(r.landing?.[0], 2), f(r.landing?.[1], 2), f(r.impact?.[2], 2), f(r.clearance, 2), f(r.speedAtBounce != null ? r.speedAtBounce * 3.6 : null), f(r.flight, 3), r.n, r.fps].join(','));
  return [head.join(','), ...lines].join('\n');
}
async function exportCsv(shots, name) {
  const blob = new Blob([toCsv(shots)], { type: 'text/csv' });
  const file = new File([blob], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(t('exported'));
}
const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
$('btnExportAll').addEventListener('click', () => exportCsv(loadShots(), `serve-ng-${stamp()}.csv`));
$('btnExportSess').addEventListener('click', () => { const s = listSessions().find(x => x.id === openSessionId); if (s) exportCsv(s.shots, `serve-ng-${stamp()}.csv`); });
$('btnDeleteSess').addEventListener('click', async () => {
  if (!(await confirmDialog(t('confirmDeleteSess'), t('delete')))) return;
  deleteShots(r => r.session === openSessionId); closeSheets(); renderHistory(); openSheet('sheetHistory'); renderSession(); toast(t('deleted'));
});

// ---------------- Language ----------------
let langSegRender = null;
function setLanguage(l) {
  S.settings.lang = l === 'it' ? 'it' : 'en';
  saveSettings(S.settings);
  setLang(S.settings.lang);
  applyAllText();
  langSegRender?.();
  if (!$('sheetAbout').classList.contains('hidden')) renderAbout();
  if (!$('sheetHistory').classList.contains('hidden')) renderHistory();
}
function renderLangToggle() {
  const tg = $('langToggle');
  tg.dataset.lang = S.settings.lang;
  tg.querySelectorAll('button').forEach(b => { const on = b.dataset.l === S.settings.lang; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
}
// Tap a flag to pick it; tap the active one to switch to the other
$('langToggle').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setLanguage(b.dataset.l === S.settings.lang ? (b.dataset.l === 'it' ? 'en' : 'it') : b.dataset.l);
});

// ---------------- Wiring ----------------
function applyAllText() {
  renderLangToggle();
  buildPresetSelect();
  applyDom();
  renderLensSeg(); renderRunButton(); renderLast(S.lastRecord); renderSession(); updateChips(); placementGuide();
}

async function detectAndApplyPhone() {
  try { S.detected = await detectPhone(); } catch { S.detected = null; }
  if (S.detected && S.settings.presetAuto) { applyPreset(S.detected.preset); saveSettings(S.settings); }
  buildPresetSelect(); renderLensSeg(); updateChips();
}

function init() {
  setLang(S.settings.lang);
  detectAndApplyPhone();
  buildPresetSelect();
  bindSettings();
  applyAllText();

  $('btnStartCam').addEventListener('click', useCamera);
  $('btnFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ''; });
  $('btnRun').addEventListener('click', () => (S.running ? stopRun() : startRun()));
  $('btnCal').addEventListener('click', () => (S.calibrating ? null : startCalibration()));
  $('chipCal').addEventListener('click', () => (S.calibrating ? null : startCalibration()));
  $('chipLens').addEventListener('click', () => { renderLensSeg(); openSheet('sheetSetup'); });
  $('btnHistory').addEventListener('click', () => { renderHistory(); openSheet('sheetHistory'); });
  $('btnAuto').addEventListener('click', runAuto);
  $('btnSnap').addEventListener('click', runSnap);
  $('btnCalCancel').addEventListener('click', endCalibration);
  $('btnCalUse').addEventListener('click', useCalibration);
  $('btnMenu').addEventListener('click', e => { e.stopPropagation(); $('menu').classList.toggle('hidden'); });
  document.addEventListener('click', e => { if (!e.target.closest('#menu')) $('menu').classList.add('hidden'); });
  $('menu').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $('menu').classList.add('hidden');
    ({
      setup: () => { renderLensSeg(); openSheet('sheetSetup'); },
      settings: () => openSheet('sheetSettings'),
      camera: useCamera,
      file: () => $('fileInput').click(),
      history: () => { renderHistory(); openSheet('sheetHistory'); },
      about: () => { renderAbout(); openSheet('sheetAbout'); },
    })[b.dataset.act]?.();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // Development hook (tests): S, the worker, and stepping a video frame by frame through the same
  // per-frame path as playback (for test browsers that do not play video)
  window.__serve = {
    S, rpc,
    // any drawable frame (image, canvas) through the per-frame path at time t
    async feed(src, t) { S.frameT = t; await analyse(src, t); drawOverlay(); },
    flush() { S.tracker?.flush(); gate.flush(); },
    ball: () => liveBall()?.tr,
    ballView: () => ballView(),
    async stepFile(from, to, fps = 30) {
      const v = $('video');
      v.pause();
      for (let tm = from; tm <= to; tm += 1 / fps) {
        v.currentTime = tm;
        await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); });
        await onVideoFrame(performance.now(), { mediaTime: v.currentTime });
      }
      await S.pipe.drain();
      S.tracker?.flush(); gate.flush();
    },
  };
}
init();
