// Ball candidates per frame by three-frame differencing inside the court's airspace.
// A pixel moves at frame k-1 if it differs from BOTH frame k-2 and frame k: that isolates a fast ball
// (it travels more than its own size per frame) without the ghost a two-frame difference leaves.
// Output lags one frame. Coordinates are native video pixels (pixel i spans [i, i+1)).

export class BallDetector {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.frames = []; // [{ data, t }]
    this.cfg = null;
  }

  // cam: CameraModel in native pixels. maxW: processing width cap. sensitivity: 0.5 (low) .. 2 (high)
  setup(cam, { maxW = 960, sensitivity = 1 } = {}) {
    const W = cam.width, H = cam.height;
    // Airspace above the court (+ run-off) where a ball can be
    const pts = [];
    for (const x of [-8.5, 8.5]) for (const y of [-15.5, 15.5]) for (const z of [0, 4.5]) {
      const p = cam.project([x, y, z]);
      if (p[2] > 0.3) pts.push([p[0], p[1]]);
    }
    let hull = convexHull(pts);
    let bx0 = 0, by0 = 0, bx1 = W, by1 = H;
    if (hull.length >= 3 && pts.length === 8) {
      bx0 = Math.max(0, Math.floor(Math.min(...hull.map(p => p[0])))); bx1 = Math.min(W, Math.ceil(Math.max(...hull.map(p => p[0]))));
      by0 = Math.max(0, Math.floor(Math.min(...hull.map(p => p[1])))); by1 = Math.min(H, Math.ceil(Math.max(...hull.map(p => p[1]))));
    } else hull = [[0, 0], [W, 0], [W, H], [0, H]]; // camera inside the box: use the whole frame
    const bw = Math.max(16, bx1 - bx0), bh = Math.max(16, by1 - by0);
    const scale = Math.min(1, maxW / bw, (maxW * 0.75) / bh);
    const pw = Math.max(16, Math.round(bw * scale)), ph = Math.max(16, Math.round(bh * scale));
    this.canvas.width = pw; this.canvas.height = ph;
    // ROI mask at processing resolution
    const mc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
    const mx = mc.getContext('2d');
    mx.fillStyle = '#fff'; mx.beginPath();
    hull.forEach(([x, y], i) => { const X = (x - bx0) * scale, Y = (y - by0) * scale; i ? mx.lineTo(X, Y) : mx.moveTo(X, Y); });
    mx.closePath(); mx.fill();
    const md = mx.getImageData(0, 0, pw, ph).data;
    const roi = new Uint8Array(pw * ph);
    let roiCount = 0;
    for (let i = 0; i < roi.length; i++) if (md[i * 4 + 3] > 127) { roi[i] = 1; roiCount++; }
    // Largest ball image anywhere in the airspace (nearest point to the camera), in processing px
    let dmin = Infinity;
    for (const x of [-8.5, 0, 8.5]) for (const y of [-15.5, -8, 0, 8, 15.5]) for (const z of [0, 2, 4.5]) dmin = Math.min(dmin, cam.distanceTo([x, y, z]));
    const dBall = cam.f * 0.067 / Math.max(2, dmin) * scale;
    this.cfg = {
      bx0, by0, bw, bh, scale, pw, ph, roi, roiCount, hull,
      maxArea: Math.max(40, Math.ceil((dBall + 3) * (5 * dBall + 8))),
      sensitivity,
    };
    this.frames = [];
    this.m = new Uint16Array(pw * ph);
    this.labels = new Int32Array(pw * ph);
    this.stack = new Int32Array(pw * ph);
  }

  reset() { this.frames = []; }

  // source: video / canvas / ImageBitmap. Returns { t, cands, busy, noisy } for the previous frame.
  process(source, t) {
    const c = this.cfg; if (!c) return null;
    this.ctx.drawImage(source, c.bx0, c.by0, c.bw, c.bh, 0, 0, c.pw, c.ph);
    const data = this.ctx.getImageData(0, 0, c.pw, c.ph).data;
    this.frames.push({ data, t });
    if (this.frames.length > 3) this.frames.shift();
    if (this.frames.length < 3) return null;
    const [f0, f1, f2] = this.frames;
    return this.detect(f0.data, f1.data, f2.data, f1.t);
  }

  detect(a, b, d, t) {
    const c = this.cfg, n = c.pw * c.ph, roi = c.roi, m = this.m;
    // Noise floor from a sparse sample of |b - d|
    const hist = new Uint32Array(766);
    let samples = 0;
    for (let i = 0; i < n; i += 11) {
      if (!roi[i]) continue;
      const j = i * 4;
      hist[Math.abs(b[j] - d[j]) + Math.abs(b[j + 1] - d[j + 1]) + Math.abs(b[j + 2] - d[j + 2])]++;
      samples++;
    }
    let acc = 0, p90 = 0;
    for (; p90 < 765; p90++) { acc += hist[p90]; if (acc >= samples * 0.9) break; }
    const thr = Math.max(36, 3 * p90) / c.sensitivity;
    let moving = 0;
    for (let i = 0; i < n; i++) {
      m[i] = 0;
      if (!roi[i]) continue;
      const j = i * 4;
      // Most pixels do not change at all: test one difference first
      const d2 = Math.abs(b[j] - d[j]) + Math.abs(b[j + 1] - d[j + 1]) + Math.abs(b[j + 2] - d[j + 2]);
      if (d2 < thr) continue;
      const d1 = Math.abs(b[j] - a[j]) + Math.abs(b[j + 1] - a[j + 1]) + Math.abs(b[j + 2] - a[j + 2]);
      if (d1 < thr) continue;
      m[i] = d1 < d2 ? d1 : d2; moving++;
    }
    // Exposure jumps, camera shake: everything moves
    if (moving > c.roiCount * 0.04) return { t, cands: [], busy: [], noisy: true };

    // Connected components (8-neighbourhood)
    const L = this.labels, st = this.stack, w = c.pw;
    L.fill(0);
    const blobs = [];
    for (let i = 0; i < n; i++) {
      if (!m[i] || L[i]) continue;
      const id = blobs.length + 1;
      let sp = 0; st[sp++] = i; L[i] = id;
      let cnt = 0, sw = 0, sx = 0, sy = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, sr = 0, sg = 0, sb = 0, peak = 0;
      while (sp) {
        const k = st[--sp], x = k % w, y = (k / w) | 0, v = m[k];
        cnt++; sw += v; sx += v * x; sy += v * y; if (v > peak) peak = v;
        sr += b[k * 4]; sg += b[k * 4 + 1]; sb += b[k * 4 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (cnt > 4000) continue; // huge blob (a player): stop growing it, it is discarded anyway
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= c.ph) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (m[q] && !L[q]) { L[q] = id; st[sp++] = q; }
          }
        }
      }
      blobs.push({ cnt, sw, x: sx / sw, y: sy / sw, x0, y0, x1, y1, peak, r: sr / cnt, g: sg / cnt, b: sb / cnt });
    }
    const busy = [], cands = [];
    for (const bl of blobs) {
      if (bl.cnt > c.maxArea) { busy.push(bl); continue; }
      if (bl.cnt === 1 && bl.peak < thr * 1.6) continue;
      const bw = bl.x1 - bl.x0 + 1, bh = bl.y1 - bl.y0 + 1;
      if (Math.max(bw, bh) > 6 * Math.min(bw, bh) + 4) continue; // long thin streak: a line or a racket edge
      cands.push(bl);
    }
    // Fragments next to a big moving blob (player, racket) are flagged: usable to extend a track,
    // not to start one.
    const near = (bl, z) => {
      const mx = (z.x1 - z.x0) * 0.25 + 4, my = (z.y1 - z.y0) * 0.25 + 4;
      return bl.x >= z.x0 - mx && bl.x <= z.x1 + mx && bl.y >= z.y0 - my && bl.y <= z.y1 + my;
    };
    const s = 1 / c.scale;
    const out = cands.map(bl => {
      // Optic yellow: red and green well above blue
      const yellow = Math.max(0, Math.min(1, ((bl.r + bl.g) / 2 - bl.b - 20) / 80));
      return {
        u: (bl.x + 0.5) * s + c.bx0, v: (bl.y + 0.5) * s + c.by0,
        area: bl.cnt * s * s, strength: bl.sw * (1 + yellow), yellow,
        busy: busy.some(z => near(bl, z)),
      };
    }).sort((p, q) => q.strength - p.strength).slice(0, 16);
    return {
      t, cands: out, noisy: false,
      busy: busy.map(z => ({ u0: z.x0 * s + c.bx0, v0: z.y0 * s + c.by0, u1: (z.x1 + 1) * s + c.bx0, v1: (z.y1 + 1) * s + c.by0 })),
    };
  }
}

export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
