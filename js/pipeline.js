// The per-frame analysis — the stabiliser and the ball detector — off the page's thread. The page hands
// each video frame to a worker as an ImageBitmap (a copy on the GPU, ~0.2 ms) and gets back the camera
// rotation and the ball candidates; the tracker, the overlay and the results stay on the page, which so
// keeps drawing and playing smoothly while a frame is analysed. A browser without OffscreenCanvas in
// workers runs the same analysis on the page, as before.
import { Stabilizer } from './stabilizer.js';
import { BallDetector } from './detector.js';
import { CameraModel } from './camera.js';

// The analysis itself, the same in the worker and on the page. Messages: { type, ... }.
export class FrameAnalyser {
  constructor() { this.stab = new Stabilizer(); this.det = new BallDetector(); this.cam = null; }

  handle(m) {
    if (m.cam) { this.cam = CameraModel.fromJSON(m.cam); this.stab = new Stabilizer(); }
    switch (m.type) {
      case 'reference': this.stab = new Stabilizer(); if (this.cam) this.stab.setReference(m.image, this.cam); return null;
      case 'resetStab': this.stab = new Stabilizer(); return null;
      case 'setup': this.det.setup(this.cam, m.opts); return { scale: this.det.cfg.scale, hull: this.det.cfg.hull };
      case 'sensitivity': if (this.det.cfg) this.det.cfg.sensitivity = m.value; return null;
      case 'reset': this.det.reset(); return null;
      case 'frame': return this.frame(m);
      default: return null;
    }
  }

  // stabilize: register the frame against the calibration frame (a phone that is not perfectly still)
  // and let the detector resample it into the calibrated view; detect: look for the ball (while running)
  frame({ image, t, stabilize, detect }) {
    const t0 = performance.now();
    let st = null, warp = null, det = null;
    if (stabilize && this.cam) {
      // a calibration from an earlier session: the view is assumed unchanged
      if (!this.stab.ready) this.stab.setReference(image, this.cam);
      const r = this.stab.track(image);
      st = { ok: !!r?.ok, R: r?.R ?? null };
      if (r?.ok) warp = this.stab.refToCur(r.R);
      else if (detect) this.det.reset();
    }
    const t1 = performance.now();
    if (detect && this.det.cfg && (!stabilize || st?.ok)) det = this.det.process(image, t, warp);
    const t2 = performance.now();
    return { t, st, det, ms: t2 - t0, msStab: t1 - t0, msDet: t2 - t1 };
  }
}

// The page's side. Messages reach the worker in the order they were made (a frame whose ImageBitmap is
// ready early waits for the ones before it) and replies come back in that order.
export class FramePipe {
  constructor() {
    this.pending = []; this.inFlight = 0; this.queue = Promise.resolve();
    this.sentCam = null; this.setupOpts = null; this.refSource = null; this.local = null; this.worker = null;
    if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./frameworker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = e => this.reply(e.data);
        this.worker.onerror = e => { e.preventDefault?.(); this.toLocal(); };
      } catch { this.worker = null; }
    }
    if (!this.worker) this.local = new FrameAnalyser();
  }
  get inWorker() { return !!this.worker; }

  reply(d) {
    if (d.type === 'unsupported') return this.toLocal();
    if (d.type === 'error') console.warn('frame worker:', d.error);
    const p = this.pending.shift(); if (!p) return;
    if (p.frame) this.inFlight--;
    p.resolve(d.type === 'error' ? null : d.result);
  }
  // The worker cannot analyse here (no 2D OffscreenCanvas in workers): the page does it, as before
  toLocal() {
    if (this.local) return;
    this.worker?.terminate(); this.worker = null;
    this.local = new FrameAnalyser();
    if (this.sentCam) this.local.handle({ type: 'resetStab', cam: this.sentCam.toJSON() });
    // the calibration frame again (the canvas it is on is still there), not whatever frame comes next
    if (this.refSource) this.local.handle({ type: 'reference', image: this.refSource });
    if (this.setupOpts) this.local.handle({ type: 'setup', opts: this.setupOpts });
    for (const p of this.pending) p.resolve(null);
    this.pending = []; this.inFlight = 0;
  }
  // m goes when `image` (a promise of an ImageBitmap, or null) is ready and everything before it went
  post(m, image = null, frame = false, src = null) {
    if (frame) this.inFlight++;
    return new Promise(resolve => {
      this.queue = this.queue.then(() => image).then(bm => {
        if (!this.worker) { bm?.close?.(); if (frame) this.inFlight--; return resolve(this.local ? this.local.handle(src ? { ...m, image: src } : m) : null); }
        if (bm) m.image = bm;
        this.pending.push({ resolve, frame });
        this.worker.postMessage(m, bm ? [bm] : []);
      }, () => { // no ImageBitmap of this source: analyse on the page from now on
        if (frame) this.inFlight--;
        this.toLocal();
        resolve(src ? this.local.handle({ ...m, image: src }) : null);
      });
    });
  }
  // the camera model goes along when it changed
  withCam(m, cam) {
    if (cam && cam !== this.sentCam) { this.sentCam = cam; m.cam = cam.toJSON(); }
    return m;
  }

  // The frame the calibration was made on: the stabiliser's reference
  setReference(source, cam) {
    const m = this.withCam({ type: 'reference' }, cam);
    this.refSource = source;
    if (this.local) return Promise.resolve(this.local.handle({ ...m, image: source }));
    return this.post(m, createImageBitmap(source), false, source);
  }
  resetStab() { this.refSource = null; return this.local ? Promise.resolve(this.local.handle({ type: 'resetStab' })) : this.post({ type: 'resetStab' }); }
  setup(cam, opts) {
    this.setupOpts = opts;
    const m = this.withCam({ type: 'setup', opts }, cam);
    return this.local ? Promise.resolve(this.local.handle(m)) : this.post(m);
  }
  sensitivity(value) {
    if (this.setupOpts) this.setupOpts.sensitivity = value;
    return this.local ? Promise.resolve(this.local.handle({ type: 'sensitivity', value })) : this.post({ type: 'sensitivity', value });
  }
  reset() { return this.local ? Promise.resolve(this.local.handle({ type: 'reset' })) : this.post({ type: 'reset' }); }
  // settles when every frame sent so far has come back
  drain() { return this.local ? Promise.resolve() : this.post({ type: 'noop' }); }

  // One frame: { t, st, det, ms }, or null when it was not analysed (maxQueue frames already waiting).
  // The ImageBitmap is taken right away, so it is this frame even if the video moves on meanwhile.
  frame(src, t, cam, { stabilize, detect, maxQueue = 3 }) {
    const m = this.withCam({ type: 'frame', t, stabilize, detect }, cam);
    if (this.local) return Promise.resolve(this.local.handle({ ...m, image: src }));
    if (this.inFlight >= maxQueue) return Promise.resolve(null);
    return this.post(m, createImageBitmap(src), true, src);
  }
}
