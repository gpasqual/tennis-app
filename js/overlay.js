// Drawing on the stage overlay (source pixels -> CSS pixels) and the top-view placement charts.
import { C, LINES, MARKS } from './court.js';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.srcW = 16; this.srcH = 9;
    this.rect = { x: 0, y: 0, w: 1, h: 1, s: 1 };
  }
  // Fit the overlay to the stage and compute where a srcW x srcH frame is shown (object-fit: contain).
  fit(srcW, srcH) {
    if (srcW) { this.srcW = srcW; this.srcH = srcH; }
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr; this.cssW = r.width; this.cssH = r.height;
    const s = Math.min(r.width / this.srcW, r.height / this.srcH);
    this.rect = { x: (r.width - this.srcW * s) / 2, y: (r.height - this.srcH * s) / 2, w: this.srcW * s, h: this.srcH * s, s };
  }
  toCss(u, v) { return [this.rect.x + u * this.rect.s, this.rect.y + v * this.rect.s]; }
  toSrc(x, y) { return [(x - this.rect.x) / this.rect.s, (y - this.rect.y) / this.rect.s]; }
  clear() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // Keep drawings on the picture (not in the letterbox bars)
  clipToFrame() {
    const c = this.ctx, r = this.rect;
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
  }

  // Court lines projected through the camera (with distortion), drawn as polylines.
  court(cam, { color = 'rgba(57,224,124,0.9)', width = 1.6, net = true } = {}) {
    const c = this.ctx;
    this.clipToFrame();
    c.strokeStyle = color; c.lineWidth = width; c.lineJoin = 'round';
    const seg = (a, b) => {
      c.beginPath();
      let started = false;
      for (let k = 0; k <= 24; k++) {
        const P = [a[0] + (b[0] - a[0]) * k / 24, a[1] + (b[1] - a[1]) * k / 24, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * k / 24];
        const p = cam.project(P);
        if (p[2] <= 0.2) { started = false; continue; }
        const [x, y] = this.toCss(p[0], p[1]);
        if (started) c.lineTo(x, y); else { c.moveTo(x, y); started = true; }
      }
      c.stroke();
    };
    for (const [x1, y1, x2, y2] of LINES) seg([x1, y1], [x2, y2]);
    for (const [x1, y1, x2, y2] of MARKS) seg([x1, y1], [x2, y2]);
    if (net) {
      c.setLineDash([5, 4]);
      seg([-C.POST_X, 0, C.NET_P], [0, 0, C.NET_C]); seg([0, 0, C.NET_C], [C.POST_X, 0, C.NET_P]);
      seg([-C.POST_X, 0, 0], [-C.POST_X, 0, C.NET_P]); seg([C.POST_X, 0, 0], [C.POST_X, 0, C.NET_P]);
      c.setLineDash([]);
    }
    c.restore();
  }

  handles(points, { active = -1, pinned = new Set() } = {}) {
    const c = this.ctx;
    points.forEach((p, i) => {
      if (!p) return;
      const [x, y] = this.toCss(p[0], p[1]);
      if (x < -20 || y < -20 || x > this.cssW + 20 || y > this.cssH + 20) return;
      c.beginPath(); c.arc(x, y, i === active ? 13 : 9, 0, Math.PI * 2);
      c.fillStyle = pinned.has(i) ? 'rgba(212,242,58,0.35)' : 'rgba(255,255,255,0.18)'; c.fill();
      c.lineWidth = 2; c.strokeStyle = pinned.has(i) ? '#d4f23a' : '#fff'; c.stroke();
      c.beginPath(); c.arc(x, y, 1.6, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
    });
  }

  polygon(pts, color) {
    if (!pts || pts.length < 3) return;
    const c = this.ctx;
    c.beginPath(); pts.forEach(([u, v], i) => { const [x, y] = this.toCss(u, v); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath();
    c.strokeStyle = color; c.lineWidth = 1; c.setLineDash([3, 4]); c.stroke(); c.setLineDash([]);
  }

  candidates(cands, color = 'rgba(255,90,90,0.9)') {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = 1.2;
    for (const k of cands) { const [x, y] = this.toCss(k.u, k.v); c.beginPath(); c.arc(x, y, k.busy ? 3 : 5, 0, Math.PI * 2); c.stroke(); }
  }

  tracks(tracks) {
    const c = this.ctx;
    c.strokeStyle = 'rgba(212,242,58,0.85)'; c.lineWidth = 2;
    for (const tr of tracks) {
      c.beginPath();
      tr.pts.forEach((p, i) => { const [x, y] = this.toCss(p.u, p.v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    }
  }

  // Fitted flight from the racket to the bounce, with the bounce marked.
  flight(cam, res, alpha = 1) {
    if (!res || !res.curve) return;
    const c = this.ctx;
    this.clipToFrame();
    c.globalAlpha = alpha;
    c.strokeStyle = '#d4f23a'; c.lineWidth = 3; c.lineCap = 'round';
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 4;
    c.beginPath();
    let started = false;
    for (const { p } of res.curve) {
      const q = cam.project(p);
      if (q[2] <= 0.2) { started = false; continue; }
      const [x, y] = this.toCss(q[0], q[1]);
      if (started) c.lineTo(x, y); else { c.moveTo(x, y); started = true; }
    }
    c.stroke();
    if (res.landing) {
      const q = cam.project([res.landing[0], res.landing[1], 0]);
      if (q[2] > 0.2) {
        const [x, y] = this.toCss(q[0], q[1]);
        const col = res.margin == null ? '#d4f23a' : res.margin <= 0 ? '#39e07c' : '#ff5050';
        c.shadowBlur = 0; c.strokeStyle = col; c.lineWidth = 2.5;
        c.beginPath(); c.ellipse(x, y, 10, 5, 0, 0, Math.PI * 2); c.stroke();
      }
    }
    c.restore();
  }
}

// ---------- placement charts (top view, SVG) ----------
// Bounces are drawn on the receiving half; serves from the far end are rotated 180° so every serve
// lands in the same picture.
const SVGNS = 'http://www.w3.org/2000/svg';
export function speedColor(frac) {
  // Sequential: muted blue -> optic yellow -> red-orange
  const stops = [[73, 166, 255], [212, 242, 58], [255, 110, 60]];
  const f = Math.max(0, Math.min(1, frac)) * 2, i = Math.min(1, Math.floor(f)), r = f - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * r)).join(',')})`;
}
export function placementSvg(svg, shots, { full = false, highlight = null } = {}) {
  // Coordinates: x across (-6.5..6.5), y from the net (0) to beyond the far baseline (13)
  const x0 = -6.8, x1 = 6.8, y0 = full ? -13.2 : -0.6, y1 = 13.2;
  svg.setAttribute('viewBox', `${x0} ${-y1} ${x1 - x0} ${y1 - y0}`);
  svg.innerHTML = '';
  const el = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.appendChild(e); return e; };
  const Y = y => -y; // SVG y down
  el('rect', { x: -C.HWD, y: Y(full ? C.HL : C.HL), width: 2 * C.HWD, height: full ? 2 * C.HL : C.HL, fill: '#1d3550', rx: 0.1 });
  const line = (a, b, w = 0.07) => el('line', { x1: a[0], y1: Y(a[1]), x2: b[0], y2: Y(b[1]), stroke: '#e8eaee', 'stroke-width': w, opacity: 0.85 });
  const halves = full ? [-1, 1] : [1];
  for (const s of halves) {
    line([-C.HWD, s * C.HL], [C.HWD, s * C.HL], 0.1);
    line([-C.HWS, s * C.SL], [C.HWS, s * C.SL]);
  }
  for (const x of [-C.HWD, -C.HWS, C.HWS, C.HWD]) line([x, full ? -C.HL : 0], [x, C.HL]);
  line([0, full ? -C.SL : 0], [0, C.SL]);
  el('line', { x1: -C.POST_X, y1: 0, x2: C.POST_X, y2: 0, stroke: '#9aa0aa', 'stroke-width': 0.12, 'stroke-dasharray': '0.3 0.2' });
  const pts = shots.filter(s => s.landing);
  const speeds = pts.map(s => s.speed);
  const lo = Math.min(...speeds), hi = Math.max(...speeds);
  for (const s of pts) {
    let [x, y] = s.landing;
    if (!full && s.impact && s.impact[1] > 0) { x = -x; y = -y; }
    const frac = hi > lo ? (s.speed - lo) / (hi - lo) : 0.5;
    const on = highlight && s.id === highlight;
    el('circle', { cx: x, cy: Y(y), r: on ? 0.42 : 0.3, fill: speedColor(frac), stroke: on ? '#fff' : '#09090b', 'stroke-width': on ? 0.12 : 0.06, opacity: s.quality === 'poor' ? 0.45 : 0.95 });
  }
}
