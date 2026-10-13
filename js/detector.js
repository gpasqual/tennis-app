// Ball candidates per frame by three-frame differencing inside the court's airspace.
// A pixel moves at frame k-1 if it differs from BOTH frame k-2 and frame k: that isolates a fast ball
// (it travels more than its own size per frame) without the ghost a two-frame difference leaves.
// Output lags one frame. Coordinates are native video pixels (pixel i spans [i, i+1)).
// With a moving phone each frame is first resampled into the calibrated view (homography from the
// stabiliser), so the frames line up and the candidates come out in calibration coordinates.

export class BallDetector {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
    // A plain (GPU) canvas: a video frame is copied and scaled on the graphics chip, then read back once.
    // willReadFrequently would move the canvas to the CPU, where every video frame is converted in
    // software: 60 ms instead of 4 for a 1080p HDR frame.
    this.ctx = this.canvas.getContext('2d');
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
      maxArea: Math.max(40, Math.ceil((dBall + 3) * (5 * dBall + 8))), dBall,
      sensitivity,
    };
    this.frames = [];
    this.m = new Uint16Array(pw * ph);
    this.labels = new Int32Array(pw * ph);
    this.stack = new Int32Array(pw * ph);
  }

  reset() { this.frames = []; }

  // source: video / canvas / ImageBitmap. warp: homography (native pixels) from the calibrated view to
  // this frame, or null for a still camera. Returns { t, cands, busy, noisy } for the previous frame.
  process(source, t, warp = null) {
    const c = this.cfg; if (!c) return null;
    if (warp) this.drawWarped(source, warp);
    else this.ctx.drawImage(source, c.bx0, c.by0, c.bw, c.bh, 0, 0, c.pw, c.ph);
    const data = this.ctx.getImageData(0, 0, c.pw, c.ph).data;
    this.frames.push({ data, t, warped: !!warp });
    if (this.frames.length > 3) this.frames.shift();
    if (this.frames.length < 3) return null;
    const [f0, f1, f2] = this.frames;
    return this.detect(f0.data, f1.data, f2.data, f1.t, f0.warped || f1.warped || f2.warped);
  }

  // Resample the frame into the calibrated view. Canvas 2D only does affine maps, so the processing
  // image is cut into tiles, each drawn with the affine map that matches the homography at its corners
  // (well under a pixel off inside a tile for the turns of a hand-held phone). The frame is first copied
  // once, at processing scale, into a CPU-side canvas: drawing tiles straight from a video or GPU canvas
  // reads the whole frame back for every tile. Parts of the view the frame does not cover stay
  // transparent and are ignored.
  drawWarped(source, H) {
    const c = this.cfg, ctx = this.ctx, sc = c.scale;
    const SW = source.videoWidth || source.naturalWidth || source.width, SH = source.videoHeight || source.naturalHeight || source.height;
    const toSrc = (X, Y) => {
      const x = c.bx0 + X / sc, y = c.by0 + Y / sc, w = H[6] * x + H[7] * y + H[8];
      return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    };
    // 1. the part of the frame the view needs, copied once at processing scale
    const edge = [];
    for (let k = 0; k <= 4; k++) edge.push(toSrc(c.pw * k / 4, 0), toSrc(c.pw * k / 4, c.ph), toSrc(0, c.ph * k / 4), toSrc(c.pw, c.ph * k / 4));
    const sx = Math.max(0, Math.floor(Math.min(...edge.map(p => p[0]))) - 4), sy = Math.max(0, Math.floor(Math.min(...edge.map(p => p[1]))) - 4);
    const ex = Math.min(SW, Math.ceil(Math.max(...edge.map(p => p[0]))) + 4), ey = Math.min(SH, Math.ceil(Math.max(...edge.map(p => p[1]))) + 4);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.pw, c.ph);
    if (!(ex > sx && ey > sy)) return;
    const gw = Math.max(1, Math.ceil((ex - sx) * sc)), gh = Math.max(1, Math.ceil((ey - sy) * sc));
    if (!this.stage || this.stage.width < gw || this.stage.height < gh) {
      this.stage = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(gw, gh) : Object.assign(document.createElement('canvas'), { width: gw, height: gh });
      this.stageCtx = this.stage.getContext('2d');
    }
    this.stageCtx.clearRect(0, 0, this.stage.width, this.stage.height);
    this.stageCtx.drawImage(source, sx, sy, ex - sx, ey - sy, 0, 0, (ex - sx) * sc, (ey - sy) * sc);
    // 2. tiles; staging pixel = (frame pixel - (sx, sy)) * scale
    const nx = Math.max(1, Math.ceil(c.pw / 96)), ny = Math.max(1, Math.ceil(c.ph / 96));
    for (let ty = 0; ty < ny; ty++) {
      const Y0 = Math.round(ty * c.ph / ny), Y1 = Math.round((ty + 1) * c.ph / ny);
      for (let tx = 0; tx < nx; tx++) {
        const X0 = Math.round(tx * c.pw / nx), X1 = Math.round((tx + 1) * c.pw / nx);
        const g = p => [(p[0] - sx) * sc, (p[1] - sy) * sc];
        const s0 = g(toSrc(X0, Y0)), s1 = g(toSrc(X1, Y0)), s2 = g(toSrc(X0, Y1)), s3 = g(toSrc(X1, Y1));
        const a = s1[0] - s0[0], b = s2[0] - s0[0], cc = s1[1] - s0[1], d = s2[1] - s0[1], det = a * d - b * cc;
        if (!det) continue;
        // canvas = M * staging + e, with M = diag(tile size) * inverse([s1 - s0, s2 - s0])
        const m11 = (X1 - X0) * d / det, m12 = -(X1 - X0) * b / det, m21 = -(Y1 - Y0) * cc / det, m22 = (Y1 - Y0) * a / det;
        const qx = Math.max(0, Math.floor(Math.min(s0[0], s1[0], s2[0], s3[0])) - 2), qy = Math.max(0, Math.floor(Math.min(s0[1], s1[1], s2[1], s3[1])) - 2);
        const rx = Math.min(gw, Math.ceil(Math.max(s0[0], s1[0], s2[0], s3[0])) + 2), ry = Math.min(gh, Math.ceil(Math.max(s0[1], s1[1], s2[1], s3[1])) + 2);
        if (!(rx > qx && ry > qy)) continue;
        ctx.save();
        ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
        ctx.setTransform(m11, m21, m12, m22, X0 - (m11 * s0[0] + m12 * s0[1]), Y0 - (m21 * s0[0] + m22 * s0[1]));
        ctx.drawImage(this.stage, qx, qy, rx - qx, ry - qy, qx, qy, rx - qx, ry - qy);
        ctx.restore();
      }
    }
  }

  detect(a, b, d, t, warped = false) {
    const c = this.cfg, n = c.pw * c.ph, roi = c.roi, m = this.m;
    // Resampled frames line up to a fraction of a pixel, not exactly: an edge then shows a difference
    // of about (misalignment x gradient). That much is allowed for at each pixel.
    const slack = warped ? 0.7 : 0, w4 = c.pw * 4;
    // Noise floor from a sparse sample of |b - d|
    const hist = new Uint32Array(766);
    let samples = 0;
    for (let i = 0; i < n; i += 11) {
      if (!roi[i]) continue;
      const j = i * 4;
      if (warped && (a[j + 3] < 250 || b[j + 3] < 250 || d[j + 3] < 250)) continue;
      hist[Math.abs(b[j] - d[j]) + Math.abs(b[j + 1] - d[j + 1]) + Math.abs(b[j + 2] - d[j + 2])]++;
      samples++;
    }
    let acc = 0, p90 = 0;
    for (; p90 < 765; p90++) { acc += hist[p90]; if (acc >= samples * 0.9) break; }
    const thr = Math.max(36, 3 * p90) / c.sensitivity;
    this.onDebug?.({ a, b, d, thr, slack, t });
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
      if (warped) {
        // outside the frame (transparent), or an edge that only moved by the alignment error
        if (a[j + 3] < 250 || b[j + 3] < 250 || d[j + 3] < 250) continue;
        const x = i % c.pw, y = (i / c.pw) | 0;
        if (x < 1 || y < 1 || x >= c.pw - 1 || y >= c.ph - 1) continue;
        let gsum = 0;
        for (let ch = 0; ch < 3; ch++) {
          const ga = Math.max(Math.abs(a[j + 4 + ch] - a[j - 4 + ch]) + Math.abs(a[j + w4 + ch] - a[j - w4 + ch]), Math.abs(d[j + 4 + ch] - d[j - 4 + ch]) + Math.abs(d[j + w4 + ch] - d[j - w4 + ch]));
          gsum += ga * 0.5;
        }
        const need = thr + slack * gsum;
        if (d1 < need || d2 < need) continue;
      }
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
      let cnt = 0, sw = 0, sx = 0, sy = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, sr = 0, sg = 0, sb = 0, peak = 0, qr = 0, qg = 0, qb = 0;
      while (sp) {
        const k = st[--sp], x = k % w, y = (k / w) | 0, v = m[k];
        cnt++; sw += v; sx += v * x; sy += v * y; if (v > peak) peak = v;
        sr += b[k * 4]; sg += b[k * 4 + 1]; sb += b[k * 4 + 2];
        // the same pixels in the frames before and after: what the object covers
        qr += (a[k * 4] + d[k * 4]) / 2; qg += (a[k * 4 + 1] + d[k * 4 + 1]) / 2; qb += (a[k * 4 + 2] + d[k * 4 + 2]) / 2;
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
      blobs.push({ cnt, sw, x: sx / sw, y: sy / sw, x0, y0, x1, y1, peak, r: sr / cnt, g: sg / cnt, b: sb / cnt, br: qr / cnt, bg: qg / cnt, bb: qb / cnt });
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
    // A moving player breaks up into a cluster of fragments, each one stronger than a far ball; the
    // ball flies alone. Fragments with several others around them count as busy too, and the candidates
    // are ranked isolated first: ranking by strength alone dropped the far ball in favour of pieces of
    // the server.
    const R = Math.max(10, 3 * c.dBall);
    const crowd = bl => { let n = 0; for (const o of blobs) if (o !== bl && Math.abs(o.x - bl.x) < R && Math.abs(o.y - bl.y) < R) n++; return n; };
    const s = 1 / c.scale;
    const out = cands.map(bl => {
      // Optic yellow: red and green well above blue
      const yellow = Math.max(0, Math.min(1, ((bl.r + bl.g) / 2 - bl.b - 20) / 80));
      // The ball's shadow runs along the court under it and meets it at the bounce, often a stronger
      // detection than the ball. A shadow is clearly darker than the court it covers, with the same
      // colour; the ball is as bright or brighter, and greener (yellow on clay). Shadows (and dark
      // clothes) are set apart, not offered to the tracker.
      const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
      const lb = lum(bl.br, bl.bg, bl.bb), shade = lum(bl.r, bl.g, bl.b) < 0.92 * lb && (bl.g - bl.r) - (bl.bg - bl.br) < 0.03 * lb;
      return {
        u: (bl.x + 0.5) * s + c.bx0, v: (bl.y + 0.5) * s + c.by0,
        area: bl.cnt * s * s, strength: bl.sw * (1 + yellow), yellow,
        rgb: [bl.r, bl.g, bl.b], under: [bl.br, bl.bg, bl.bb], shade,
        // how much yellower (green over blue) than what it covers: an optic-yellow ball is, a racket,
        // a body or a shadow hardly
        yg: (bl.g - bl.b) - (bl.bg - bl.bb),
        busy: busy.some(z => near(bl, z)) || crowd(bl) >= 3 || shade,
      };
    }).sort((p, q) => (p.busy - q.busy) || (q.strength - p.strength));
    const shadows = out.filter(c => c.shade).slice(0, 16);
    return {
      t, cands: out.filter(c => !c.shade).slice(0, this.maxCands ?? 32), shadows, noisy: false,
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
