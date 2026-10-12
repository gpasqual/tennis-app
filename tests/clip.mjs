// Run a recorded clip through the real pipeline in Node (no browser): calibration on a frame, the
// stabiliser, the ball detector, the tracker and the analysis. Frames come from ffmpeg (rotation and HDR
// tone mapping handled), so it runs on phone videos as they are.
//   node tests/clip.mjs <video> [--cal 0] [--from 0] [--to 1e9] [--procw 960] [--nostab] [--out tracks.json]
// Canvas work (frame scaling / warping, the ROI polygon) is done in plain JS here; the maths is the app's.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { autoCalibrate } from '../js/courtdetect.js';
import { BallDetector } from '../js/detector.js';
import { Tracker } from '../js/tracker.js';
import { analyzeTrack } from '../js/trajectory.js';
import { ballModel } from '../js/physics.js';
import { focalPx, feqFromFocalPx } from '../js/lenses.js';
import { Stabilizer } from '../js/stabilizer.js';

const args = process.argv.slice(2);
const file = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const CAL = Number(opt('cal', 0)), FROM = Number(opt('from', 0)), TO = Number(opt('to', 1e9)), PROCW = Number(opt('procw', 960));
const DUMP = args.includes('--dump'), STAB = !args.includes('--nostab'), OUT = opt('out', null);

// ---- minimal canvas: the court air-space polygon (BallDetector.setup) and frame shrinking (Stabilizer) ----
class MiniCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    const c = this, path = [];
    return {
      fillStyle: '', beginPath() { path.length = 0; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); }, closePath() {},
      fill() { c.poly = path.slice(); },
      drawImage(src) { if (src && src.raw) c.src = src; },
      getImageData(x0, y0, w, h) {
        if (c.src) return shrink(c.src.raw, w);
        const data = new Uint8ClampedArray(w * h * 4), P = c.poly || [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const px = x + 0.5, py = y + 0.5;
          let inside = false;
          for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
            const [xi, yi] = P[i], [xj, yj] = P[j];
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
          }
          if (inside) data[(y * w + x) * 4 + 3] = 255;
        }
        return { data };
      },
      setTransform() {}, clearRect() {}, save() {}, restore() {}, rect() {}, clip() {},
    };
  }
}
globalThis.OffscreenCanvas = MiniCanvas;

// ---- frame plumbing ----
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,color_transfer:stream_side_data=rotation', '-of', 'json', file]).toString()).streams[0];
const rot = Math.abs(Number((probe.side_data_list || []).find(d => d.rotation != null)?.rotation || 0));
const W = rot === 90 || rot === 270 ? probe.height : probe.width, H = rot === 90 || rot === 270 ? probe.width : probe.height;
const [fn, fd] = probe.avg_frame_rate.split('/').map(Number), FPS = fn / fd;
const hdr = /arib|2084/.test(probe.color_transfer || '');
const vf = hdr ? ['-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'] : [];

// A frame object the modified detector / stabiliser understand: raw RGBA at native size
const frameOf = data => ({ raw: data, width: W, height: H });

// area-average downscale of raw RGBA to width w (for calibration and the stabiliser)
function shrink(src, w) {
  const s = W / w, h = Math.round(H / s), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const j = (yy * W + xx) * 4; r += src[j]; g += src[j + 1]; b += src[j + 2]; n++; }
      const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

// Detector: processing image by bilinear sampling straight from the raw frame (exact homography)
class NodeDetector extends BallDetector {
  process(source, t, warp = null) {
    const c = this.cfg; if (!c) return null;
    const data = new Uint8ClampedArray(c.pw * c.ph * 4), S = source.raw, Hm = warp;
    for (let Y = 0; Y < c.ph; Y++) for (let X = 0; X < c.pw; X++) {
      let x = c.bx0 + (X + 0.5) / c.scale, y = c.by0 + (Y + 0.5) / c.scale;
      if (Hm) { const w = Hm[6] * x + Hm[7] * y + Hm[8]; const u = (Hm[0] * x + Hm[1] * y + Hm[2]) / w, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / w; x = u; y = v; }
      const fx = x - 0.5, fy = y - 0.5;
      if (fx < 0 || fy < 0 || fx > W - 1.001 || fy > H - 1.001) continue; // alpha 0: outside the frame
      const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, j = (y0 * W + x0) * 4, o = (Y * c.pw + X) * 4;
      for (let ch = 0; ch < 3; ch++) {
        data[o + ch] = (1 - ay) * ((1 - ax) * S[j + ch] + ax * S[j + 4 + ch]) + ay * ((1 - ax) * S[j + W * 4 + ch] + ax * S[j + W * 4 + 4 + ch]);
      }
      data[o + 3] = 255;
    }
    this.frames.push({ data, t, warped: !!warp });
    if (this.frames.length > 3) this.frames.shift();
    if (this.frames.length < 3) return null;
    const [f0, f1, f2] = this.frames;
    return this.detect(f0.data, f1.data, f2.data, f1.t, f0.warped || f1.warped || f2.warped);
  }
}

async function* frames() {
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, ...vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const size = W * H * 4;
  let buf = Buffer.alloc(0), k = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      yield { k: k++, data: new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + size)) };
      buf = buf.subarray(size);
    }
  }
}

// ---- run ----
console.log(`${file}: ${W}x${H} ${FPS.toFixed(2)} fps${rot ? ` (rotated ${rot})` : ''}${hdr ? ' HDR' : ''}`);
let cam = null, det = null, tracker = null, stab = null;
const M = ballModel({ cd: 0.55 });
const tracks = [];
let stabMs = 0, detMs = 0, n = 0, lost = 0;
const t00 = performance.now();
for await (const { k, data } of frames()) {
  const t = k / FPS;
  if (!cam) {
    if (k < CAL) continue;
    const small = shrink(data, Math.min(1280, W));
    const s = small.width / W;
    const intr = { width: small.width, height: small.height, f: focalPx(26, small.width, small.height), cx: small.width / 2, cy: small.height / 2 };
    const r = autoCalibrate(small, intr, { focals: [13, 26].map(m => focalPx(m, small.width, small.height)) });
    if (!r.ok) { console.log(`calibration on frame ${k} FAILED: ${r.reason}`); process.exit(1); }
    cam = r.cam.scaled(W, H);
    console.log(`calibration (frame ${k}): camera (${cam.C.map(v => v.toFixed(2)).join(', ')}), lens ${feqFromFocalPx(cam.f, W, H).toFixed(1)} mm eq, rms ${(r.rms / s).toFixed(2)} px, coverage ${r.coverage.toFixed(2)}`);
    det = new NodeDetector();
    det.setup(cam, { maxW: PROCW });
    tracker = new Tracker({ width: W, onTrack: tr => tracks.push(tr) });
    if (STAB) { stab = new Stabilizer(); stab.setReference(frameOf(data), cam); }
  }
  if (t < FROM || t > TO) continue;
  const f = frameOf(data);
  let warp = null;
  if (stab) {
    const a = performance.now();
    const r = stab.track(f);
    stabMs += performance.now() - a;
    if (!r.ok) { lost++; det.reset(); continue; }
    warp = stab.refToCur(r.R);
  }
  const a = performance.now();
  const d = det.process(f, t, warp);
  detMs += performance.now() - a;
  n++;
  if (d && DUMP) console.log(`  f${Math.round(d.t * FPS)} ${d.noisy ? 'NOISY' : ''}: ` + d.cands.slice(0, 10).map(c => `${c.u.toFixed(0)},${c.v.toFixed(0)} a${c.area.toFixed(0)} s${c.strength.toFixed(0)}${c.busy ? 'B' : ''}`).join('  '));
  if (d && !d.noisy) tracker.push(d);
}
tracker.flush();
const pxNoise = Math.max(0.7, 1 / det.cfg.scale);
console.log(`${n} frames in ${((performance.now() - t00) / 1000).toFixed(0)} s (stabiliser ${(stabMs / n).toFixed(1)} ms, lost ${lost}; detector ${(detMs / n).toFixed(1)} ms at ${det.cfg.pw}x${det.cfg.ph}); ${tracks.length} tracks`);
const results = [];
tracks.forEach((tr, i) => {
  const obs = tr.pts.map(p => ({ t: p.t, u: p.u, v: p.v }));
  const r = analyzeTrack(obs, cam, M, { pxNoise, serveOnly: true });
  const any = r && r.plausible ? r : analyzeTrack(obs, cam, M, { pxNoise, serveOnly: false });
  const best = r && r.plausible ? r : any;
  if (!best) return;
  results.push({ i, t0: obs[0].t, n: obs.length, kind: best.kind, plausible: best.plausible, speed: best.speed * 3.6, sigma: best.sigma * 3.6, quality: best.quality, impact: best.impact, landing: best.landing, seen: best.landingObserved });
});
for (const r of results.filter(r => r.plausible)) console.log(`  t=${r.t0.toFixed(2)}s track ${r.i} (${r.n} pts): ${r.kind} ${r.speed.toFixed(1)} ± ${r.sigma.toFixed(1)} km/h ${r.quality}  contact (${r.impact.map(v => v.toFixed(1)).join(', ')})  bounce (${r.landing.map(v => v.toFixed(1)).join(', ')})${r.seen ? ' seen' : ''}`);
if (!results.some(r => r.plausible)) console.log('  no plausible shot');
if (OUT) writeFileSync(OUT, JSON.stringify({ W, H, fps: FPS, cam: cam.toJSON(), tracks: tracks.map(tr => tr.pts.map(p => [p.t, p.u, p.v])), results }));
