// node tests/court.test.js <workdir> — renders synthetic courts with tests/render_court.py and checks
// that autoCalibrate recovers the camera.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CameraModel } from '../js/camera.js';
import { focalPx } from '../js/lenses.js';
import { autoCalibrate } from '../js/courtdetect.js';
import { KEYPOINTS } from '../js/court.js';

const dir = process.argv[2] || 'tests/out';
mkdirSync(dir, { recursive: true });
const W = Number(process.env.W || 1280), H = Math.round(W * 9 / 16);
const intr = feq => ({ width: W, height: H, f: focalPx(feq, W, H), cx: W / 2, cy: H / 2 });
const cases = [
  { name: 'behind_centre_2m', feq: 26, eye: [0.5, -17.5, 2.0], look: [0, 1, 0], surface: 'blue' },
  { name: 'behind_offset_3m', feq: 26, eye: [4.0, -16.0, 3.0], look: [0, 0, 0], surface: 'green' },
  { name: 'corner_2p5m', feq: 26, eye: [6.5, -17.0, 2.5], look: [0, 0, 0], surface: 'clay' },
  { name: 'side_net_uw', feq: 13, eye: [10.5, -1, 1.5], look: [0, 0, 0], surface: 'blue' },
  { name: 'side_out_uw_2m', feq: 13, eye: [11.5, -3, 2.0], look: [0, 0, 0], surface: 'green' },
  { name: 'behind_high_uw', feq: 13, eye: [-2.0, -15.0, 4.0], look: [0, 2, 0], surface: 'clay' },
  { name: 'tele_far', feq: 52, eye: [1.0, -30.0, 5.0], look: [0, 0, 0], surface: 'blue' },
  // Real-world conditions: brushed clay with a tree shadow, and recorded video whose focal length is
  // not the preset (stabilisation crop: an iPhone "26 mm" main camera records 1080p like ~31 mm)
  { name: 'clay_corner_crop', feq: 26, feqTrue: 31, eye: [9.7, -18.1, 3.7], look: [2, -2, 0], surface: 'clay', texture: true },
  { name: 'clay_side_uw_crop', feq: 13, feqTrue: 14.5, eye: [11, -0.5, 1.9], look: [0, 0, 0.5], surface: 'clay', texture: true },
  { name: 'hard_behind_texture', feq: 26, eye: [1.5, -18.5, 2.2], look: [0, 0, 0], surface: 'green', texture: true },
];
const cams = cases.map(c => {
  const cam = CameraModel.lookAt(intr(c.feqTrue || c.feq), c.eye, c.look, (c.name.length % 5 - 2) * 0.01);
  return { ...c, cam, json: { name: c.name, ...cam.toJSON(), surface: c.surface, texture: !!c.texture } };
});
writeFileSync(join(dir, 'cams.json'), JSON.stringify(cams.map(c => c.json)));
execFileSync('python', ['tests/render_court.py', join(dir, 'cams.json'), dir], { stdio: 'inherit' });

let fails = 0;
const estOut = [];
for (const c of cams) {
  const buf = readFileSync(join(dir, c.name + '.rgba'));
  const img = { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), width: W, height: H };
  const t0 = performance.now();
  const res = autoCalibrate(img, intr(c.feq));
  const ms = performance.now() - t0;
  estOut.push({ name: c.name, cam: res.cam ? res.cam.toJSON() : null, hough: (res.debug?.lines || []).map(l => ({ a: l.a, b: l.b })) });
  if (!res.ok) { console.log(`FAIL ${c.name}: ${res.reason} (${ms.toFixed(0)} ms, ${res.debug?.lines?.length} lines)`); fails++; continue; }
  const est = res.cam, tru = c.cam;
  const dC = Math.hypot(est.C[0] - tru.C[0], est.C[1] - tru.C[1], est.C[2] - tru.C[2]);
  let maxPx = 0;
  for (const [x, y] of KEYPOINTS) {
    const a = est.project([x, y, 0]), b = tru.project([x, y, 0]);
    // also points in the air above the court (what the ball analysis needs)
    const a2 = est.project([x * 0.5, y * 0.5, 2.5]), b2 = tru.project([x * 0.5, y * 0.5, 2.5]);
    if (b[0] >= 0 && b[0] < W && b[1] >= 0 && b[1] < H) maxPx = Math.max(maxPx, Math.hypot(a[0] - b[0], a[1] - b[1]));
    if (b2[0] >= 0 && b2[0] < W && b2[1] >= 0 && b2[1] < H) maxPx = Math.max(maxPx, Math.hypot(a2[0] - b2[0], a2[1] - b2[1]));
  }
  const ok = dC < 0.25 && maxPx < 2.5 * Math.max(1, W / 1280); // pixel errors scale with the image size
  if (!ok) fails++;
  const foc = res.focal ? `f est ${res.focal.f.toFixed(0)}±${res.focal.sigma.toFixed(0)} (true ${tru.f.toFixed(0)}${c.feqTrue ? ', preset ' + intr(c.feq).f.toFixed(0) : ''})` : 'f n/a';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(18)} camera err ${(dC * 100).toFixed(1)} cm | max reproj ${maxPx.toFixed(2)} px | rms ${res.rms.toFixed(2)} px | lines ${res.lines} | ${foc} | ${ms.toFixed(0)} ms`);
}
writeFileSync(join(dir, 'est.json'), JSON.stringify(estOut));
process.exitCode = fails ? 1 : 0;
