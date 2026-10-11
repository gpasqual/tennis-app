// Shot analysis: a ball track in the image (time-stamped pixel positions from one calibrated camera)
// -> 3D flight -> speed at the racket.
//
// One camera cannot triangulate, but the ball is not free to move: it flies under gravity, drag and
// spin, and it bounces on the (known) ground plane. Fitting that physical model to the rays fixes the
// depth: gravity sets the metric scale, and the bounce — the post-bounce arc has to start exactly where
// the incoming arc touches the court — pins the flight to the ground. The fitted flight is then
// integrated back to the server to get the speed at impact, which is what a radar gun reports.
import { lstsq, levenbergMarquardt, spdInverse } from './linalg.js';
import { flyTo, flyUntil, bounceState, G } from './physics.js';
import { C, netHeightAt, serveSide, serviceBoxMargin, singlesMargin } from './court.js';

const CL_SIGMA = 0.3;      // prior on the lift coefficients (spin), dimensionless
const IMPACT_INSET = 0.4;  // servers make contact ~0.4 m inside the baseline
export const IMPACT_Y = C.HL - IMPACT_INSET;

// ---------- 2D track helpers ----------
function polyFit(ts, vs, deg, t0) {
  const rows = ts.map(t => { const r = []; let p = 1; for (let d = 0; d <= deg; d++) { r.push(p); p *= (t - t0); } return r; });
  const c = lstsq(rows, vs, deg + 1);
  if (!c) return null;
  const ev = t => { let s = 0, p = 1; for (let d = 0; d <= deg; d++) { s += c[d] * p; p *= (t - t0); } return s; };
  let sse = 0; for (let i = 0; i < ts.length; i++) sse += (ev(ts[i]) - vs[i]) ** 2;
  return { ev, sse };
}
function trackFit(obs, deg) {
  const ts = obs.map(o => o.t), t0 = ts[0];
  const fu = polyFit(ts, obs.map(o => o.u), deg, t0), fv = polyFit(ts, obs.map(o => o.v), deg, t0);
  if (!fu || !fv) return null;
  const at = t => [fu.ev(t), fv.ev(t)];
  return { at, sse: fu.sse + fv.sse, res: () => obs.map(o => { const [u, v] = at(o.t); return (u - o.u) ** 2 + (v - o.v) ** 2; }) };
}

// Remove isolated false detections: a point survives if a local arc through its neighbours on the
// left, on the right, or on both sides predicts it (one-sided fits keep the points at the bounce kink).
// The worst point goes first and errors are recomputed, so one outlier cannot condemn its neighbours.
export function cleanTrack(obsIn, pxNoise = 1) {
  const obs = obsIn.slice();
  const maxDrop = Math.floor(obs.length * 0.3);
  for (let dropped = 0; dropped < maxDrop && obs.length >= 7; dropped++) {
    let worst = -1, worstRatio = 1;
    // Near the camera the image speed changes fast, so the ends (judged by extrapolation only) are
    // dropped only when they are far off relative to their step.
    for (let i = 0; i < obs.length; i++) {
      const end = i === 0 || i === obs.length - 1;
      const dPrev = i > 0 ? Math.hypot(obs[i].u - obs[i - 1].u, obs[i].v - obs[i - 1].v) : Infinity;
      const dNext = i < obs.length - 1 ? Math.hypot(obs[i].u - obs[i + 1].u, obs[i].v - obs[i + 1].v) : Infinity;
      const near = Math.min(dPrev, dNext);
      const thr = Math.max(6 * pxNoise, 4, (end ? 0.6 : 0.25) * near);
      let e = Infinity;
      for (const [a, b] of [[i - 4, i - 1], [i + 1, i + 4], [i - 2, i + 2]]) {
        const nb = [];
        for (let j = Math.max(0, a); j <= Math.min(obs.length - 1, b); j++) if (j !== i) nb.push(obs[j]);
        if (nb.length < 3) continue;
        const f = trackFit(nb, Math.min(2, nb.length - 2));
        if (!f) continue;
        const [u, v] = f.at(obs[i].t);
        e = Math.min(e, Math.hypot(u - obs[i].u, v - obs[i].v));
      }
      if (!isFinite(e)) continue;
      const ratio = e / thr;
      if (ratio > worstRatio) { worstRatio = ratio; worst = i; }
    }
    if (worst < 0) break;
    obs.splice(worst, 1);
  }
  return obs;
}

// RMS (px) of the best "two smooth arcs" description of a track: one arc, or two meeting at a kink.
// The worst 10% of the residuals are ignored so a stray false detection does not decide it.
function twoArcRms(obs) {
  const n = obs.length, drop = Math.ceil(0.1 * n);
  const robust = res => { const r = res.sort((a, b) => a - b).slice(0, n - drop); return r.reduce((a, b) => a + b, 0) / (2 * r.length); };
  const single = trackFit(obs, Math.min(3, n - 2));
  let best = single ? robust(single.res()) : Infinity;
  for (let s = 4; s <= n - 3; s++) {
    const a = trackFit(obs.slice(0, s), s >= 8 ? 3 : 2), b = trackFit(obs.slice(s), Math.min(2, n - s - 2));
    if (a && b) best = Math.min(best, robust(a.res().concat(b.res())));
  }
  return Math.sqrt(best);
}

// Split a track into smooth arcs (dynamic programming: fit error in units of the pixel noise plus a
// fixed price per arc). Returns the interior arc boundaries (indices where a new arc starts).
function arcBoundaries(obs, sigma) {
  const n = obs.length, MIN = 4, PRICE = 25, s2 = sigma * sigma;
  const cost = new Float64Array(n + 1).fill(Infinity), prev = new Int32Array(n + 1).fill(-1);
  cost[0] = 0;
  for (let j = MIN; j <= n; j++) {
    for (let i = Math.max(0, j - 45); i <= j - MIN; i++) {
      if (!isFinite(cost[i])) continue;
      const f = trackFit(obs.slice(i, j), Math.min(3, j - i - 2));
      if (!f) continue;
      const c = cost[i] + f.sse / s2 + PRICE;
      if (c < cost[j]) { cost[j] = c; prev[j] = i; }
    }
  }
  const cuts = [];
  for (let j = n; j > 0 && prev[j] >= 0; j = prev[j]) if (prev[j] > 0) cuts.push(prev[j]);
  return cuts.reverse();
}

// A track can start on the toss or the racket before the ball leaves the strings, or run on into the
// receiver's return. A serve, though, is at most two smooth arcs (before and after the bounce). The
// track is cut into arcs; of the stretches between arc boundaries, keep the longest one that two arcs
// still explain to within the pixel noise.
export function trimTrack(obs, pxNoise = 1) {
  const n = obs.length;
  if (n < 10) return obs;
  const cuts = arcBoundaries(obs, pxNoise);
  if (!cuts.length) return obs;
  const starts = [0, ...cuts], ends = [...cuts, n];
  const cands = [];
  for (const s0 of starts) for (const e0 of ends) if (e0 - s0 >= 8) cands.push({ s: s0, e: e0, rms: twoArcRms(obs.slice(s0, e0)) });
  if (!cands.length) return obs;
  const min = Math.min(...cands.map(c => c.rms));
  const lim = Math.max(2 * min, 3 * pxNoise);
  const ok = cands.filter(c => c.rms <= lim).sort((x, y) => (y.e - y.s) - (x.e - x.s) || x.rms - y.rms);
  return obs.slice(ok[0].s, ok[0].e);
}

// Where and when two arcs meet between tLo and tHi, and how sharply the motion turns there.
function meetPoint(fa, fb, tLo, tHi) {
  let tb = tLo, dmin = Infinity;
  for (let i = 0; i <= 120; i++) {
    const t = tLo + (tHi - tLo) * i / 120;
    const p = fa.at(t), q = fb.at(t);
    const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (d < dmin) { dmin = d; tb = t; }
  }
  const p = fa.at(tb), q = fb.at(tb);
  const da = [fa.at(tb + 1e-3)[0] - p[0], fa.at(tb + 1e-3)[1] - p[1]];
  const db = [fb.at(tb + 1e-3)[0] - q[0], fb.at(tb + 1e-3)[1] - q[1]];
  const cos = (da[0] * db[0] + da[1] * db[1]) / (Math.hypot(...da) * Math.hypot(...db) || 1);
  return { t: tb, u: (p[0] + q[0]) / 2, v: (p[1] + q[1]) / 2, gap: Math.sqrt(dmin), turn: Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI };
}

// Bounce candidates in the image: kinks between two smooth arcs. Seen from behind the court a bounce
// can be a shallow "V" that a parabola half-mimics over a short window, and long arcs cannot follow the
// perspective slow-down, so no single 2D test decides. This proposes the best global split and the
// strongest local kinks; the physical fit chooses among them.
export function bounceCandidates(obs, pxNoise = 1) {
  const n = obs.length, out = [];
  if (n < 8) return out;
  let g = null;
  for (let s = 4; s <= n - 3; s++) {
    const a = trackFit(obs.slice(0, s), s >= 8 ? 3 : 2), b = trackFit(obs.slice(s), Math.min(2, n - s - 2));
    if (a && b && (!g || a.sse + b.sse < g.sse)) g = { k: s, sse: a.sse + b.sse };
  }
  const single = trackFit(obs, Math.min(3, n - 2));
  const loc = [];
  for (let k = 3; k <= n - 3; k++) {
    const A = obs.slice(Math.max(0, k - 6), k), B = obs.slice(k, Math.min(n, k + 6));
    const fa = trackFit(A, Math.min(2, A.length - 2)), fb = trackFit(B, Math.min(2, B.length - 2)), f1 = trackFit(A.concat(B), 2);
    if (fa && fb && f1) loc.push({ k, gain: (f1.sse - fa.sse - fb.sse) / (pxNoise * pxNoise) });
  }
  loc.sort((a, b) => b.gain - a.gain);
  const ks = [];
  if (g && single && single.sse > 2 * g.sse + n * pxNoise * pxNoise) ks.push(g.k);
  // Near the start the perspective bends the track hard; a bounce is never in the first fifth
  for (const c of loc) {
    if (ks.length >= 7 || c.gain < 12) break;
    if (c.k >= Math.max(4, 0.2 * n) && !ks.some(x => Math.abs(x - c.k) <= 1)) ks.push(c.k);
  }
  for (const k of ks) {
    const A = obs.slice(Math.max(0, k - 7), k), B = obs.slice(k, Math.min(n, k + 7));
    const fa = trackFit(A, Math.min(2, A.length - 2)), fb = trackFit(B, Math.min(2, B.length - 2));
    if (!fa || !fb) continue;
    const m = meetPoint(fa, fb, obs[k - 1].t - 0.5 * (obs[k].t - obs[k - 1].t), obs[k].t);
    const step = Math.hypot(obs[k].u - obs[k - 1].u, obs[k].v - obs[k - 1].v);
    if (m.gap > Math.max(12 * pxNoise, 0.6 * step) || m.turn < 4) continue;
    out.push({ index: k, ...m });
  }
  return out;
}
export const findBounce2D = (obs, pxNoise = 1) => bounceCandidates(obs, pxNoise)[0] || null;

// ---------- 3D fit ----------
// Parameters: [x, y, z, vx, vy, vz, CLv, CLs] at t0 = first observation, plus [vx', vy', vz'] just after
// the bounce. The bounce time is not a parameter: it is where the incoming flight reaches z = r, so the
// bounce constraint holds exactly. Observations after that time belong to the outgoing arc. A weak
// prior ties the outgoing velocity to a normal bounce, so tracks that end before the bounce still fit.
export function analyzeTrack(obsIn, cam, M, { pxNoise = 1, diag = {}, serveOnly = false } = {}) {
  let obs = cleanTrack(trimTrack(obsIn, pxNoise), pxNoise);
  diag.cleaned = obsIn.length - obs.length;
  if (obs.length < 6) { diag.fail = 'too few points'; return null; }
  const t0 = obs[0].t, n = obs.length;
  // Initialisation options: each bounce candidate (with its bounce point on the court), "no bounce
  // seen", and a few late splits when the image shows no kink at all.
  const cands = bounceCandidates(obs, pxNoise);
  diag.bounces = cands;
  const options = cands.map(c => {
    let B = cam.rayToPlaneZ(c.u, c.v, M.r);
    if (!B || Math.abs(B[0]) > 9 || Math.abs(B[1]) > 16) B = null;
    return { split: c.index, B, tb: c.t };
  });
  options.push({ split: n, B: null, tb: null });
  if (!cands.length) for (let k = 3; k <= 5 && n - k >= 6; k++) options.push({ split: n - k, B: null, tb: null });
  for (const o of options) o.g = gridInit(obs.slice(0, o.split), cam, M, o.B, o.tb, pxNoise);
  // Cheap screen (arms, rackets and wobbling shadows do not fly like a ball at all), then the full
  // fit for the two most promising starts
  // The quick flight must also look like a shot: speed below the world record, and for serves a start
  // high up near a baseline heading for the net. Bodies, rackets and the toss fail this, which saves
  // the full fit for them.
  const shotLike = g => {
    const p = g.p, kmh = Math.hypot(p[3], p[4], p[5]) * 3.6;
    if (kmh < (serveOnly ? 50 : 20) || kmh > 270 || p[2] < -0.2 || p[2] > 4.2) return false;
    if (!serveOnly) return true;
    if (p[4] * p[1] >= 0 || Math.abs(p[4]) < 5) return false;          // heading for the net
    const dt = (IMPACT_Y - Math.abs(p[1])) / Math.abs(p[4]);           // time since the contact plane
    const zc = p[2] - p[5] * dt - 0.5 * G * dt * dt;                   // height there
    // first seen at most ~2 m behind the contact plane (servers stand at the baseline) and within 0.3 s of it
    return dt > -0.04 && dt < 0.3 && zc > 1.5 && zc < 4;
  };
  diag.grids = options.map(o => o.g && { rms: o.g.rms, kmh: Math.hypot(o.g.p[3], o.g.p[4], o.g.p[5]) * 3.6, y: o.g.p[1], z: o.g.p[2], vy: o.g.p[4] });
  const ranked = options.filter(o => o.g && o.g.rms <= 10 * pxNoise + 4 && shotLike(o.g)).sort((a, b) => a.g.rms - b.g.rms).slice(0, 2);
  diag.gridRms = ranked.length ? ranked[0].g.rms : null;
  diag.gridP = ranked.length ? ranked[0].g.p : null;
  let best = null, bestOpt = null;
  const fits = [];
  for (const o of ranked) {
    const init = o.g.p;
    const land = flyUntil(init.slice(0, 6), t0, M, 0, 0, s => s[2] - M.r, { maxT: 3 });
    const vpost = land ? bounceState(land.s, { cor: 0.7, fric: 0.7 }).slice(3) : [init[3] * 0.7, init[4] * 0.7, 3];
    const fit = refine(obs, cam, M, [...init, ...vpost], pxNoise, t0);
    if (fit) fits.push(fit);
    if (fit && (!best || fit.cost < best.cost)) { best = fit; bestOpt = o; }
  }
  if (!best) { diag.fail = 'fit'; return null; }
  // Two starts that explain the track about equally well but disagree on the speed: the track does
  // not pin the flight down (depth ambiguity), whatever the covariance says.
  const v0Of = f => speedOf(impactOf(f.p, t0, M).s);
  const ambiguous = fits.some(f => f !== best && f.cost < 2 * best.cost + 10 && Math.abs(v0Of(f) / v0Of(best) - 1) > 0.06);
  diag.B = bestOpt.B;
  let fit = best;
  // Drop false detections the fit cannot explain and refit
  for (let round = 0; round < 2; round++) {
    const sorted = fit.pxErr.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    const lim = Math.max(4 * pxNoise, 4 * med);
    const keep = obs.filter((_, i) => fit.pxErr[i] <= lim);
    if (keep.length === obs.length || keep.length < 6) break;
    obs = keep;
    const f2 = refine(obs, cam, M, fit.p, pxNoise, t0);
    if (!f2) break;
    fit = f2;
  }
  // The image bounce to check the fit against: the candidate nearest the fitted bounce time
  const land = flyUntil(fit.p.slice(0, 6), t0, M, fit.p[6], fit.p[7], s => s[2] - M.r, { maxT: 3 });
  let Bchk = null;
  if (land) {
    const c = cands.filter(c => Math.abs(c.t - land.t) < 0.05).sort((a, b) => Math.abs(a.t - land.t) - Math.abs(b.t - land.t))[0];
    if (c) { Bchk = cam.rayToPlaneZ(c.u, c.v, M.r); if (Bchk && (Math.abs(Bchk[0]) > 9 || Math.abs(Bchk[1]) > 16)) Bchk = null; }
  }
  return summarize(fit, obs, cam, M, Bchk, pxNoise, t0, ambiguous);
}

// Approximate flight for initialisation: drag folded into an effective time φ(τ) along the initial
// velocity, gravity added on top.
function approxFlight(Ps, v0, tau, kap) {
  const ph = kap > 0 ? Math.log(1 + kap * tau) / kap : tau;
  return [Ps[0] + v0[0] * ph, Ps[1] + v0[1] * ph, Ps[2] + v0[2] * ph - 0.5 * G * tau * tau];
}

// Grid search over the depths of the first and last observation along their rays; each pair fixes a
// flight, scored by reprojection error. Robust to the mirror and near/far ambiguities a direct
// algebraic solve falls into.
function gridInit(pre, cam, M, B, tB, pxNoise) {
  if (pre.length < 4) return null;
  const t0 = pre[0].t, Cc = cam.C;
  const depths = []; for (let i = 0; i < 40; i++) depths.push(1.5 * Math.pow(60, i / 39)); // 1.5 .. 90 m
  const step = Math.max(1, Math.floor(pre.length / 12));
  const sample = pre.filter((_, i) => i % step === 0 || i === pre.length - 1);
  const keep = Math.max(3, Math.ceil(sample.length * 0.85)); // trimmed cost: a stray point cannot decide
  const res = new Float64Array(sample.length);
  // Flight through Ps at time ta and Pe at time tb, referred back to t0; cost over the sample points.
  const evalCost = (Ps, ta, Pe, tb) => {
    const T = tb - ta;
    let v = [(Pe[0] - Ps[0]) / T, (Pe[1] - Ps[1]) / T, (Pe[2] - Ps[2] + 0.5 * G * T * T) / T], kap = 0;
    for (let it = 0; it < 3; it++) {
      kap = M.k * M.cd * Math.hypot(v[0], v[1], v[2]);
      const ph = Math.log(1 + kap * T) / kap;
      v = [(Pe[0] - Ps[0]) / ph, (Pe[1] - Ps[1]) / ph, (Pe[2] - Ps[2] + 0.5 * G * T * T) / ph];
    }
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp < 3 || sp > 90) return null;
    // State at t0 (the anchor may be a later point): step the approximate flight back
    const P0 = ta > t0 ? approxFlight(Ps, v, t0 - ta, 0) : Ps;
    for (let i = 0; i < sample.length; i++) {
      const P = approxFlight(Ps, v, sample[i].t - ta, kap);
      if (P[2] < -0.3) return null; // underground before the bounce
      const [u, w, z] = cam.project(P);
      if (z <= 0.2) return null;
      res[i] = ((u - sample[i].u) ** 2 + (w - sample[i].v) ** 2) / (pxNoise * pxNoise);
    }
    const sorted = Array.from(res).sort((a, b) => a - b);
    let sse = 0; for (let i = 0; i < keep; i++) sse += sorted[i];
    if (B && tB != null) {
      const P = approxFlight(Ps, v, tB - ta, kap);
      sse += ((P[0] - B[0]) ** 2 + (P[1] - B[1]) ** 2 + (P[2] - B[2]) ** 2) / 0.09 * 4;
    }
    return { sse, v, P0 };
  };
  // Anchors: one of the first three and one of the last two points along their rays (a track can
  // still start or end on a racket or shadow point)
  const n = pre.length;
  let best = null;
  for (const ia of [0, 1, 2].filter(i => i < n - 3)) {
    for (const ib of [n - 1, n - 2].filter(i => i > ia + 2)) {
      const a = pre[ia], b = pre[ib];
      const da = cam.ray(a.u, a.v), db = cam.ray(b.u, b.v);
      for (const s of depths) {
        const Ps = [Cc[0] + s * da[0], Cc[1] + s * da[1], Cc[2] + s * da[2]];
        if (Ps[2] < 0 || Ps[2] > 5 || Math.abs(Ps[0]) > 12 || Math.abs(Ps[1]) > 20) continue;
        for (const e of depths) {
          const Pe = [Cc[0] + e * db[0], Cc[1] + e * db[1], Cc[2] + e * db[2]];
          if (Pe[2] < 0 || Pe[2] > 6 || Math.abs(Pe[0]) > 12 || Math.abs(Pe[1]) > 20) continue;
          const r = evalCost(Ps, a.t, Pe, b.t);
          if (r && (!best || r.sse < best.sse)) best = { sse: r.sse, P0: r.P0, v: r.v };
        }
      }
    }
  }
  if (!best) return null;
  return { p: [...best.P0, ...best.v, 0, 0], rms: Math.sqrt(best.sse / (2 * keep)) * pxNoise };
}

// Predicted ball positions at `times` for parameters p (null if the flight is invalid).
export function predict(p, t0, times, M) {
  const s0 = [p[0], p[1], p[2], p[3], p[4], p[5]];
  const land = flyUntil(s0, t0, M, p[6], p[7], s => s[2] - M.r, { maxT: 3, h: 0.002 });
  if (!land) return null;
  const preT = [], postT = [], pi = [], qi = [];
  times.forEach((t, i) => { if (t <= land.t) { preT.push(t); pi.push(i); } else { postT.push(t); qi.push(i); } });
  const pos = new Array(times.length);
  const a = flyTo(s0, t0, preT, M, p[6], p[7], 0.004);
  pi.forEach((i, k) => { pos[i] = a[k]; });
  if (postT.length) {
    const b = flyTo([land.s[0], land.s[1], land.s[2], p[8], p[9], p[10]], land.t, postT, M, 0, 0, 0.004);
    qi.forEach((i, k) => { pos[i] = b[k]; });
  }
  return { pos, land, nPost: postT.length };
}

function refine(obs, cam, M, init, pxNoise, t0) {
  const times = obs.map(o => o.t);
  const n = obs.length, nP = init.length;
  let weights = new Float64Array(n).fill(1);
  const resid = p => {
    const pr = predict(p, t0, times, M);
    if (!pr || p[10] < 0) return null; // the ball must leave the court upwards
    const r = [];
    for (let i = 0; i < n; i++) {
      const [u, v, z] = cam.project(pr.pos[i]);
      if (z <= 0.1) return null;
      r.push((u - obs[i].u) / pxNoise * weights[i], (v - obs[i].v) / pxNoise * weights[i]);
    }
    r.push(p[6] / CL_SIGMA, p[7] / CL_SIGMA);
    // Outgoing velocity ~ a normal bounce of the incoming one (restitution ~0.75, friction ~0.65)
    const vl = pr.land.s, sg = Math.max(2, 0.15 * Math.hypot(vl[3], vl[4], vl[5]));
    r.push((p[8] - 0.65 * vl[3]) / sg, (p[9] - 0.65 * vl[4]) / sg, (p[10] + 0.75 * vl[5]) / sg);
    return Float64Array.from(r);
  };
  const steps = [1e-4, 1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3].slice(0, nP);
  let res = null, p = init;
  const errsOf = p => {
    const pr = predict(p, t0, times, M);
    return obs.map((o, i) => { const [u, v] = cam.project(pr.pos[i]); return Math.hypot(u - o.u, v - o.v); });
  };
  // Huber-style reweighting: two passes
  for (let pass = 0; pass < 2; pass++) {
    res = levenbergMarquardt(resid, p, steps, { maxIter: 40, tol: 1e-7 });
    if (!res) return null;
    p = Array.from(res.p);
    weights = Float64Array.from(errsOf(p).map(e => e <= 2 * pxNoise ? 1 : Math.sqrt(2 * pxNoise / e)));
  }
  const pr = predict(p, t0, times, M);
  return { p, JtJ: res.JtJ, cost: res.cost, m: res.r.length, pxErr: errsOf(p), nPost: pr.nPost };
}

function impactOf(p, t0, M) {
  const s0 = [p[0], p[1], p[2], p[3], p[4], p[5]];
  if (Math.abs(p[1]) >= IMPACT_Y) return { t: t0, s: s0 };
  // Integrate backwards to the plane where the server makes contact (at most 0.25 s back)
  const hit = flyUntil(s0, t0, M, p[6], p[7], s => IMPACT_Y - Math.abs(s[1]), { dir: -1, maxT: 0.25 });
  if (hit) return hit;
  return { t: t0 - 0.25, s: flyTo(s0, t0, [t0 - 0.25], M, p[6], p[7])[0] };
}
const speedOf = s => Math.hypot(s[3], s[4], s[5]);

function summarize(fit, obs, cam, M, Bobs, pxNoise, t0, ambiguous = false) {
  const p = fit.p, nP = p.length;
  const s0 = p.slice(0, 6);
  const imp = impactOf(p, t0, M);
  const v0 = speedOf(imp.s);
  const land = flyUntil(s0, t0, M, p[6], p[7], s => s[2] - M.r, { maxT: 3 });
  const net = flyUntil(imp.s, imp.t, M, p[6], p[7], s => s[1] * Math.sign(imp.s[1]), { maxT: 3 });
  const crossesNet = !!net && (!land || net.t < land.t);
  const clearance = crossesNet ? net.s[2] - M.r - netHeightAt(net.s[0]) : null;

  // Uncertainty of the impact speed from the fit covariance
  const s2 = Math.max(1, fit.cost / Math.max(1, fit.m - nP));
  const cov = fit.JtJ ? spdInverse(fit.JtJ, nP) : null;
  let sigma = null;
  if (cov) {
    const g = new Array(nP).fill(0);
    const steps = [1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-2, 1e-2];
    for (let j = 0; j < 8; j++) {
      const q = p.slice(); q[j] += steps[j];
      g[j] = (speedOf(impactOf(q, t0, M).s) - v0) / steps[j];
    }
    let v = 0;
    for (let a = 0; a < nP; a++) for (let b = 0; b < nP; b++) v += g[a] * cov[a * nP + b] * g[b];
    sigma = Math.sqrt(Math.max(0, v * s2));
  }

  const rms = Math.sqrt(fit.pxErr.reduce((a, e) => a + e * e, 0) / fit.pxErr.length);
  const impact = imp.s.slice(0, 3);
  const landing = land ? land.s.slice(0, 3) : null;
  const landingObserved = fit.nPost >= 2;
  // A serve is struck from just around a baseline, within the court's width
  const isServe = impact[2] > 1.7 && Math.abs(impact[1]) > 9.5 && Math.abs(impact[1]) < 13.5 && Math.abs(impact[0]) < 6 && crossesNet;
  const flight = land ? land.t - imp.t : null;
  let pathLen = null;
  if (land) {
    const ts = []; for (let t = imp.t; t < land.t; t += 0.01) ts.push(t); ts.push(land.t);
    const pts = flyTo(imp.s, imp.t, ts, M, p[6], p[7]);
    pathLen = 0; for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  }
  let margin = null;
  if (landing && crossesNet) margin = isServe ? serviceBoxMargin(impact, landing) : singlesMargin(impact, landing);

  // The observed part of the flight must cover real distance (a racket or an arm fitted as a ball
  // stays within a metre or two) and the speed must be reasonably determined.
  const ends = predict(p, t0, [obs[0].t, obs[obs.length - 1].t], M);
  const span = ends ? Math.hypot(...[0, 1, 2].map(k => ends.pos[1][k] - ends.pos[0][k])) : 0;
  const plausible = v0 > 8 && v0 < 80 && impact[2] > 0.1 && impact[2] < 4.5 && rms < 4 * pxNoise &&
    span > 4 && sigma != null && sigma < 0.25 * v0;
  // Consistency checks a wrong-depth solution tends to fail: a serve is struck at 1.9–3.5 m, and the
  // fitted bounce must sit where the image shows the bounce.
  const heightOk = !isServe || (impact[2] > 1.9 && impact[2] < 3.5);
  const bounceOk = !Bobs || !landing || Math.hypot(landing[0] - Bobs[0], landing[1] - Bobs[1]) < 1.0;
  // A ball first seen well after it left the racket (contact point out of frame or hidden) needs a long
  // extrapolation back to the racket, which the covariance alone under-rates.
  const extrap = t0 - imp.t;
  let quality = 'poor';
  if (plausible && sigma != null && heightOk && bounceOk && extrap <= 0.12 && !ambiguous) {
    const rel = sigma / v0;
    if (rel < 0.04 && obs.length >= 8 && landingObserved && extrap <= 0.07) quality = 'good';
    else if (rel < 0.08 && obs.length >= 6) quality = 'ok';
  }
  return {
    plausible, quality,
    kind: isServe ? 'serve' : 'shot',
    speed: v0, sigma,
    speedAtBounce: land ? speedOf(land.s) : null,
    avgSpeed: pathLen && flight ? pathLen / flight : null,
    tImpact: imp.t, impact, landing, landingObserved,
    flight, crossesNet, clearance,
    side: isServe ? serveSide(impact) : null,
    margin,
    spin: { lift: p[6], side: p[7] },
    params: p, t0, n: obs.length, rms, span, extrap, bounceRayHit: Bobs,
    curve: sampleCurve(imp, land, M, p),
  };
}

// Samples of the fitted flight for the overlay (impact -> landing)
function sampleCurve(imp, land, M, p) {
  const tEnd = land ? land.t : imp.t + 0.8;
  const ts = []; for (let t = imp.t; t < tEnd; t += 0.01) ts.push(t); ts.push(tEnd);
  return flyTo(imp.s, imp.t, ts, M, p[6], p[7]).map((s, i) => ({ t: ts[i], p: s.slice(0, 3) }));
}
