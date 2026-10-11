// Ball flight: gravity + quadratic drag + Magnus lift, integrated with RK4.
// a = g - k·Cd·|v|·v + k·|v|²·(CLv·n_up + CLs·n_side), k = ρ·A / (2m)
// n_up: unit normal to v in the vertical plane (pointing up; backspin > 0, topspin < 0)
// n_side: unit horizontal normal to v, to the right of the direction of travel.
import { BALL } from './court.js';

export const G = 9.81;

// ISA pressure at altitude, ideal gas at the given temperature.
export function airDensity(tempC = 20, altitude = 0) {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
  return p / (287.05 * (tempC + 273.15));
}

export function ballModel({ tempC = 20, altitude = 0, cd = 0.55 } = {}) {
  const rho = airDensity(tempC, altitude);
  const A = Math.PI * BALL.radius * BALL.radius;
  return { rho, cd, k: rho * A / (2 * BALL.mass), r: BALL.radius };
}

function deriv(s, M, CLv, CLs, out) {
  const vx = s[3], vy = s[4], vz = s[5];
  const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const kd = M.k * M.cd * v;
  let ax = -kd * vx, ay = -kd * vy, az = -G - kd * vz;
  if (CLv || CLs) {
    const h = Math.sqrt(vx * vx + vy * vy);
    if (h > 1e-6 && v > 1e-6) {
      const L = M.k * v * v;
      const uv = L * CLv / (v * h), us = L * CLs / h;
      ax += -vz * vx * uv + vy * us;
      ay += -vz * vy * uv - vx * us;
      az += L * CLv * h / v;
    }
  }
  out[0] = vx; out[1] = vy; out[2] = vz; out[3] = ax; out[4] = ay; out[5] = az;
}

const k1 = new Float64Array(6), k2 = new Float64Array(6), k3 = new Float64Array(6), k4 = new Float64Array(6), tmp = new Float64Array(6);
function rk4(s, h, M, CLv, CLs) {
  deriv(s, M, CLv, CLs, k1);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
  deriv(tmp, M, CLv, CLs, k2);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
  deriv(tmp, M, CLv, CLs, k3);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + h * k3[i];
  deriv(tmp, M, CLv, CLs, k4);
  for (let i = 0; i < 6; i++) s[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}

// States [x, y, z, vx, vy, vz] at each of `times` (any order, before or after t0).
export function flyTo(state0, t0, times, M, CLv = 0, CLs = 0, hmax = 0.002) {
  const out = new Array(times.length);
  const idx = times.map((_, i) => i);
  const fwd = idx.filter(i => times[i] >= t0).sort((a, b) => times[a] - times[b]);
  const bwd = idx.filter(i => times[i] < t0).sort((a, b) => times[b] - times[a]);
  for (const [list, dir] of [[fwd, 1], [bwd, -1]]) {
    const s = Float64Array.from(state0);
    let tc = t0;
    for (const i of list) {
      const target = times[i];
      while ((target - tc) * dir > 1e-12) {
        const h = dir * Math.min(hmax, Math.abs(target - tc));
        rk4(s, h, M, CLv, CLs); tc += h;
      }
      out[i] = Array.from(s);
    }
  }
  return out;
}

// Step from t0 until pred(state) turns true (or the time limit). Returns { t, s } at the crossing,
// linearly refined between steps, or null.
export function flyUntil(state0, t0, M, CLv, CLs, pred, { dir = 1, maxT = 2, h = 0.001 } = {}) {
  const s = Float64Array.from(state0);
  let tc = t0, prev = Array.from(s), fPrev = pred(prev);
  if (fPrev <= 0) return { t: t0, s: prev };
  for (let n = 0; n * h < maxT; n++) {
    rk4(s, dir * h, M, CLv, CLs); tc += dir * h;
    const cur = Array.from(s), f = pred(cur);
    if (f <= 0) {
      const a = fPrev / (fPrev - f);
      return { t: tc - dir * h * (1 - a), s: prev.map((v, i) => v + (cur[i] - v) * a) };
    }
    prev = cur; fPrev = f;
  }
  return null;
}

// Simple bounce for the simulator: restitution on vz, friction on the horizontal speed.
export function bounceState(s, { cor = 0.75, fric = 0.65 } = {}) {
  return [s[0], s[1], s[2], s[3] * fric, s[4] * fric, -s[5] * cor];
}
