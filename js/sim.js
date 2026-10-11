// Synthetic serves with known ground truth (demo mode and tests). No DOM.
import { flyTo, flyUntil, bounceState } from './physics.js';
import { C } from './court.js';

// Aim a serve from `impact` so it lands at target [x, y] with the given speed and spin.
function aim(impact, target, speed, M, CLv, CLs) {
  let az = Math.atan2(target[0] - impact[0], target[1] - impact[1]); // from +y towards +x
  let el = -0.05;
  for (let outer = 0; outer < 6; outer++) {
    const dirOf = (e, a) => [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
    const land = (e, a) => {
      const d = dirOf(e, a);
      const hit = flyUntil([...impact, d[0] * speed, d[1] * speed, d[2] * speed], 0, M, CLv, CLs, s => s[2] - M.r, { maxT: 3 });
      return hit ? hit.s : null;
    };
    const fwd = [Math.sin(az), Math.cos(az)];
    const want = (target[0] - impact[0]) * fwd[0] + (target[1] - impact[1]) * fwd[1];
    let lo = -0.5, hi = 0.4;
    for (let i = 0; i < 40; i++) {
      el = (lo + hi) / 2;
      const s = land(el, az);
      const got = s ? (s[0] - impact[0]) * fwd[0] + (s[1] - impact[1]) * fwd[1] : -1;
      if (got < want) lo = el; else hi = el;
    }
    const s = land(el, az);
    if (!s) break;
    const miss = Math.atan2(s[0] - impact[0], s[1] - impact[1]) - Math.atan2(target[0] - impact[0], target[1] - impact[1]);
    az -= miss;
    if (Math.abs(miss) < 1e-5) break;
  }
  return [Math.cos(el) * Math.sin(az) * speed, Math.cos(el) * Math.cos(az) * speed, Math.sin(el) * speed];
}

// A serve (or any shot) with dense ground-truth states. end: 'near' (server at y < 0) | 'far'.
export function makeServe({ M, speed = 47, side = 'deuce', end = 'near', CLv = -0.08, CLs = 0, height = 2.7, target = null, tStart = 0, rng = Math.random }) {
  const s = end === 'near' ? -1 : 1;           // server half sign
  const facing = -s;                           // +1 when facing +y
  const right = side === 'deuce' ? 1 : -1;     // server's right half for deuce
  const impact = [facing * right * (0.5 + rng() * 0.6), s * (C.HL - 0.2 - rng() * 0.4), height];
  if (!target) {
    // Somewhere in the crosscourt service box, biased towards the lines like a real first serve
    const bx = -Math.sign(impact[0]) * (0.4 + rng() * 3.4);
    const by = -s * (3.6 + rng() * 2.6);
    target = [bx, by];
  }
  const v0 = aim(impact, target, speed, M, CLv, CLs);
  const st0 = [...impact, ...v0];
  const hit = flyUntil(st0, 0, M, CLv, CLs, q => q[2] - M.r, { maxT: 3 });
  const tb = hit.t;
  const after = bounceState(hit.s);
  const dt = 0.001, n1 = Math.ceil(tb / dt) + 1, n2 = 1200;
  const pre = flyTo(st0, 0, Array.from({ length: n1 }, (_, i) => Math.min(tb, i * dt)), M, CLv, CLs);
  const post = flyTo(after, tb, Array.from({ length: n2 }, (_, i) => tb + i * dt), M, 0, CLs * 0.3);
  return {
    tStart, impact, v0, speed, bounceT: tStart + tb, bounce: hit.s.slice(0, 3), side, end, CLv, CLs,
    // Ball position at absolute time t (null before impact or after the end of the sample)
    at(t) {
      const r = t - tStart;
      if (r < 0) return null;
      if (r <= tb) { const i = Math.min(n1 - 2, Math.floor(r / dt)), a = (r - i * dt) / dt; return lerp(pre[i], pre[i + 1], a); }
      const q = r - tb, i = Math.floor(q / dt);
      if (i >= n2 - 1) return null;
      return lerp(post[i], post[i + 1], (q - i * dt) / dt);
    },
  };
}
const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

// Seeded PRNG for reproducible tests / demo
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
