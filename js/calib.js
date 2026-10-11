// Court calibration on a frozen frame: automatic detection, draggable keypoints (pose solved with the
// known intrinsics, so the whole court follows the finger consistently), and snap-to-lines refinement.
import { CameraModel } from './camera.js';
import { KEYPOINTS } from './court.js';
import { levenbergMarquardt, rotFromVec, vecFromRot } from './linalg.js';
import { fmtNum } from './i18n.js';

const PROC_MAX_W = 1280;

export class Calibrator {
  constructor({ overlay, frameCanvas, loupe, info, rpc, t, onChange }) {
    Object.assign(this, { overlay, frameCanvas, loupe, info, rpc, t, onChange });
    this.active = -1; this.pinned = new Map(); this.cam = null; this.result = null;
    this.bind();
  }

  begin({ intr, initialCam }) {
    this.intr = intr;
    this.cam = initialCam ? new CameraModel({ ...intr, R: initialCam.R, t: initialCam.t }) : CameraModel.lookAt(intr, [3, -17, 2.6], [0, 0, 0]);
    this.pinned.clear(); this.result = null; this.on = true;
    this.say(this.t('calHelp'));
    this.draw();
  }
  end() { this.on = false; this.active = -1; this.loupe.classList.add('hidden'); }

  procImage() {
    const W = this.frameCanvas.width, H = this.frameCanvas.height;
    const s = Math.min(1, PROC_MAX_W / W), pw = Math.round(W * s), ph = Math.round(H * s);
    const c = Object.assign(document.createElement('canvas'), { width: pw, height: ph });
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(this.frameCanvas, 0, 0, pw, ph);
    return { img: x.getImageData(0, 0, pw, ph), s };
  }

  async auto() {
    const { img, s } = this.procImage();
    const intr = { width: img.width, height: img.height, f: this.intr.f * s, cx: this.intr.cx * s, cy: this.intr.cy * s, k1: this.intr.k1, k2: this.intr.k2 };
    const r = await this.rpc('calibrate', { img, intr });
    if (r.cam) this.cam = CameraModel.fromJSON(r.cam).scaled(this.intr.width, this.intr.height);
    this.pinned.clear();
    this.result = r.ok ? this.scaleResult(r, s) : null;
    this.report(r.ok ? 'courtFound' : 'courtNotFound');
    this.draw();
    return r.ok;
  }

  async snap() {
    const { img, s } = this.procImage();
    const r = await this.rpc('refine', { img, cam: this.cam.scaled(img.width, img.height).toJSON() });
    if (!r.ok) { this.report('snapFailed'); return false; }
    this.cam = CameraModel.fromJSON(r.cam).scaled(this.intr.width, this.intr.height);
    this.pinned.clear();
    this.result = this.scaleResult(r, s);
    this.report('courtFound');
    this.draw();
    return true;
  }

  scaleResult(r, s) {
    return { rms: r.rms / s, inliers: r.inliers, coverage: r.coverage, lines: r.lines, focal: r.focal ? { f: r.focal.f / s, sigma: r.focal.sigma / s } : null };
  }

  // Status text: what happened + where the camera is + the lens check.
  report(key) {
    const t = this.t, c = this.cam, lines = [`<div>${t(key)}</div>`];
    const h = c.C[2], d = Math.hypot(c.C[0], c.C[1]);
    lines.push(`<div>${t('camInfo', { h: fmtNum(h, 1), d: fmtNum(d, 1) })}${this.result ? ' · ' + t('lineFit', { r: fmtNum(this.result.rms, 1) }) : ''}</div>`);
    const fc = this.focalCheck();
    if (fc) lines.push(`<div class="${fc.cls}">${fc.text}</div>`);
    if (this.result && this.result.coverage != null && this.result.coverage < 0.85) lines.push(`<div class="warn">${t('lowCoverage', { n: Math.round(100 * this.result.coverage) })}</div>`);
    this.info.innerHTML = lines.join('');
  }
  focalCheck() {
    if (!this.result) return null;
    const f = this.result.focal, p = this.intr.f, t = this.t;
    if (!f || !(f.sigma < 0.03 * f.f)) return { cls: 'muted', text: t('focalNA') };
    const ok = Math.abs(f.f / p - 1) < 0.06;
    return { cls: ok ? 'good' : 'warn', ok, text: t(ok ? 'focalOk' : 'focalOff', { f: Math.round(f.f), p: Math.round(p) }) };
  }
  say(html) { this.info.innerHTML = `<div>${html}</div>`; }
  appendInfo(html, cls = '') { this.info.insertAdjacentHTML('beforeend', `<div class="${cls}">${html}</div>`); }

  keypointsPx() { return KEYPOINTS.map(([x, y]) => { const p = this.cam.project([x, y, 0]); return p[2] > 0.2 ? [p[0], p[1]] : null; }); }

  draw() {
    if (!this.on) return;
    const o = this.overlay;
    o.clear();
    o.court(this.cam, { color: 'rgba(57,224,124,0.95)', width: 1.8 });
    o.handles(this.keypointsPx(), { active: this.active, pinned: new Set(this.pinned.keys()) });
  }

  // Pose from the dragged points: pinned keypoints pull hard, the others hold the previous pose softly.
  solve() {
    const anchors = this.anchors;
    const pts = [];
    KEYPOINTS.forEach((P, i) => {
      if (this.pinned.has(i)) pts.push({ P, q: this.pinned.get(i), w: 1 });
      else if (anchors[i]) pts.push({ P, q: anchors[i], w: this.pinned.size >= 4 ? 0.02 : 0.12 });
    });
    const intr = this.cam.intrinsics();
    const make = p => new CameraModel({ ...intr, R: rotFromVec([p[0], p[1], p[2]]), t: [p[3], p[4], p[5]] });
    const resid = p => {
      const c = make(p), r = [];
      for (const o of pts) {
        const q = c.project([o.P[0], o.P[1], 0]);
        if (q[2] <= 0.2) return null;
        r.push((q[0] - o.q[0]) * o.w, (q[1] - o.q[1]) * o.w);
      }
      return Float64Array.from(r);
    };
    const res = levenbergMarquardt(resid, [...vecFromRot(this.cam.R), ...this.cam.t], [1e-5, 1e-5, 1e-5, 1e-4, 1e-4, 1e-4], { maxIter: 15 });
    if (res) {
      const c = make(res.p);
      if (c.C[2] > 0.2) this.cam = c;
    }
  }

  bind() {
    const cv = this.overlay.canvas;
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      if (!this.on) return;
      const [x, y] = pos(e);
      let best = -1, bd = 30;
      this.keypointsPx().forEach((p, i) => {
        if (!p) return;
        const [hx, hy] = this.overlay.toCss(p[0], p[1]);
        const d = Math.hypot(hx - x, hy - y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) return;
      cv.setPointerCapture(e.pointerId);
      this.active = best;
      const hp = this.keypointsPx()[best];
      const [hx, hy] = this.overlay.toCss(hp[0], hp[1]);
      this.grab = [hx - x, hy - y];
      this.anchors = this.keypointsPx();
      this.showLoupe(hp);
      this.draw();
      e.preventDefault();
    });
    cv.addEventListener('pointermove', e => {
      if (!this.on || this.active < 0) return;
      const [x, y] = pos(e);
      const q = this.overlay.toSrc(x + this.grab[0], y + this.grab[1]);
      this.pinned.set(this.active, q);
      this.solve();
      this.result = null;
      this.showLoupe(q);
      this.draw();
      this.onChange?.();
      e.preventDefault();
    });
    const up = () => {
      if (this.active < 0) return;
      this.active = -1;
      this.loupe.classList.add('hidden');
      this.draw();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  // Magnifier above the finger: 3x crop of the frozen frame with the court lines and a crosshair.
  showLoupe(p) {
    const L = this.loupe, ctx = L.getContext('2d');
    const size = L.width, zoom = 3, half = size / (2 * zoom);
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.frameCanvas, p[0] - half, p[1] - half, 2 * half, 2 * half, 0, 0, size, size);
    ctx.strokeStyle = '#d4f23a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
    ctx.restore();
    const [x, y] = this.overlay.toCss(p[0], p[1]);
    const st = this.overlay.canvas.getBoundingClientRect(), stage = this.overlay.canvas.parentElement.getBoundingClientRect();
    let lx = x - 75 + (st.left - stage.left), ly = y - 190 + (st.top - stage.top);
    if (ly < 4) ly = y + 50;
    lx = Math.max(4, Math.min(stage.width - 154, lx));
    L.style.left = lx + 'px'; L.style.top = ly + 'px';
    L.classList.remove('hidden');
  }
}
