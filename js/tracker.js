// Links per-frame ball candidates into tracks. A track is confirmed once three detections move
// consistently; confirmed tracks are extended by predicting the next position (quadratic in time) and
// get one wider "second chance" gate, which lets them run through the bounce kink. A track that has
// not been extended for a few frames is closed and, if long enough, handed to onTrack.
export class Tracker {
  constructor({ width = 1280, onTrack = () => {} } = {}) {
    this.onTrack = onTrack;
    this.setSize(width);
    this.reset();
  }
  setSize(width) {
    this.k = width / 1280;             // gate sizes are tuned at 1280 px
    this.maxStep = 0.25 * width;
    this.minPath = 0.09 * width;
  }
  reset() { this.tracks = []; this.limbo = []; this.period = 1 / 60; this.lastT = null; this.nextId = 1; }

  push({ t, cands }) {
    if (this.lastT != null) {
      const dt = t - this.lastT;
      if (dt > 0 && dt < 0.2) this.period = this.period * 0.9 + dt * 0.1;
    }
    this.lastT = t;
    const used = new Set();
    const k = this.k;
    // Duplicates (tracks that grew from the same detections) end on the same point: keep the longest
    const byLast = new Map();
    for (const tr of this.tracks) {
      const p = tr.pts[tr.pts.length - 1], key = `${p.t}|${p.u}|${p.v}`;
      const o = byLast.get(key);
      if (!o || tr.pts.length > o.pts.length) byLast.set(key, tr);
    }
    this.tracks = [...byLast.values()];

    // 1) confirmed tracks pick first, best match overall first
    const conf = this.tracks.filter(tr => tr.pts.length >= 3);
    const pairs = [];
    for (const tr of conf) {
      const pr = predict(tr.pts, t);
      const last = tr.pts[tr.pts.length - 1];
      const step = Math.hypot(pr[0] - last.u, pr[1] - last.v);
      const gate = Math.max(8 * k, 0.35 * step);
      cands.forEach((c, i) => {
        const d = Math.hypot(c.u - pr[0], c.v - pr[1]);
        if (d <= gate) pairs.push({ tr, i, s: d / gate });
      });
    }
    pairs.sort((a, b) => a.s - b.s);
    const done = new Set();
    for (const p of pairs) {
      if (done.has(p.tr) || used.has(p.i)) continue;
      add(p.tr, cands[p.i], t); done.add(p.tr); used.add(p.i);
    }
    // Second chance (bounce, deflection): a step of similar length from the last point. Established
    // tracks may turn any way (seen from behind, a bounce reverses the vertical image motion); young
    // tracks only within 70°.
    for (const tr of conf) {
      if (done.has(tr)) continue;
      const n = tr.pts.length, a = tr.pts[n - 2], b = tr.pts[n - 1];
      const dtPrev = b.t - a.t, dtNow = t - b.t;
      if (dtPrev <= 0 || dtNow > 3.5 * this.period) continue;
      const vx = (b.u - a.u) / dtPrev, vy = (b.v - a.v) / dtPrev, sp = Math.hypot(vx, vy) * dtNow;
      if (sp < 2 * k) continue;
      const minCos = n >= 6 ? -0.5 : Math.cos(70 * Math.PI / 180);
      let best = -1, bs = Infinity;
      cands.forEach((c, i) => {
        if (used.has(i)) return;
        const dx = c.u - b.u, dy = c.v - b.v, d = Math.hypot(dx, dy);
        if (d < 0.35 * sp || d > 2.2 * sp) return;
        const cos = (dx * vx + dy * vy) / (d * Math.hypot(vx, vy));
        if (cos < minCos) return;
        const s = Math.abs(Math.log(d / sp)) + 0.5 * (1 - cos);
        if (s < bs) { bs = s; best = i; }
      });
      if (best >= 0) { add(tr, cands[best], t); done.add(tr); used.add(best); }
    }

    // 2) two-point tracks: constant-velocity prediction
    for (const tr of this.tracks.filter(tr => tr.pts.length === 2)) {
      const [a, b] = tr.pts;
      const f = (t - b.t) / (b.t - a.t);
      const pu = b.u + (b.u - a.u) * f, pv = b.v + (b.v - a.v) * f;
      const gate = Math.max(10 * k, 0.5 * Math.hypot(b.u - a.u, b.v - a.v) * f);
      let best = -1, bd = gate;
      cands.forEach((c, i) => { if (used.has(i)) return; const d = Math.hypot(c.u - pu, c.v - pv); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { add(tr, cands[best], t); used.add(best); }
    }

    // 3) single detections pair with the nearest plausible candidate of this frame
    const singles = this.tracks.filter(tr => tr.pts.length === 1);
    for (const tr of singles) {
      const a = tr.pts[0];
      if (t - a.t > 2.5 * this.period) continue;
      let best = -1, bd = Infinity;
      cands.forEach((c, i) => {
        if (used.has(i)) return;
        const d = Math.hypot(c.u - a.u, c.v - a.v);
        if (d >= 2 * k && d <= this.maxStep && d < bd) { bd = d; best = i; }
      });
      if (best >= 0) {
        const nt = { id: this.nextId++, pts: [a, mk(cands[best], t)] };
        this.tracks.push(nt);
      }
    }
    // 4) unused candidates (not next to a player) seed new tracks
    cands.forEach((c, i) => { if (!used.has(i) && !c.busy) this.tracks.push({ id: this.nextId++, pts: [mk(c, t)] }); });

    // Stitch: a young confirmed track that starts where a recently lost track ended continues it
    // (the ball was missed for a few frames, or turned too sharply at the bounce).
    for (const tr of this.tracks) {
      if (tr.pts.length !== 3) continue;
      const f = tr.pts[0];
      let best = null, bd = Infinity;
      for (const old of this.limbo) {
        const n = old.pts.length, l = old.pts[n - 1], l2 = old.pts[n - 2];
        const gap = f.t - l.t;
        if (gap <= 0 || gap > 8 * this.period) continue;
        const step = Math.hypot(l.u - l2.u, l.v - l2.v) / Math.max(1e-4, l.t - l2.t);
        const d = Math.hypot(f.u - l.u, f.v - l.v);
        // The ball keeps roughly its pace while unseen: a slow blob (a player) is not its continuation
        const s1 = tr.pts[1], pace = Math.hypot(s1.u - f.u, s1.v - f.v) / Math.max(1e-4, s1.t - f.t);
        if (pace < step / 3 || pace > step * 3) continue;
        if (d <= Math.max(30 * k, 2.5 * step * gap) && d < bd) { bd = d; best = old; }
      }
      if (best) {
        tr.pts = best.pts.concat(tr.pts);
        tr.id = best.id;
        this.limbo = this.limbo.filter(o => o !== best);
      }
    }
    // Retire stale tracks; long ones wait in limbo for a possible continuation before being emitted
    const keep = [];
    for (const tr of this.tracks) {
      const last = tr.pts[tr.pts.length - 1];
      const maxGap = (tr.pts.length >= 3 ? 3.5 : 2.5) * this.period;
      if (t - last.t <= maxGap) { keep.push(tr); continue; }
      if (tr.pts.length >= 5) this.limbo.push(tr);
    }
    this.limbo = this.limbo.filter(tr => {
      if (t - tr.pts[tr.pts.length - 1].t <= 10 * this.period) return true;
      if (this.worthAnalysing(tr)) this.onTrack(tr);
      return false;
    });
    // Keep the tracker bounded in noisy scenes
    this.tracks = keep.length > 120 ? keep.sort((a, b) => b.pts.length - a.pts.length).slice(0, 120) : keep;
  }

  // A shot crosses a good part of the picture; arms, rackets and the toss do not.
  worthAnalysing(tr) {
    const p = tr.pts;
    if (p.length < 6 || p[p.length - 1].t - p[0].t < 0.08) return false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of p) { x0 = Math.min(x0, q.u); x1 = Math.max(x1, q.u); y0 = Math.min(y0, q.v); y1 = Math.max(y1, q.v); }
    return pathLen(p) >= this.minPath && Math.hypot(x1 - x0, y1 - y0) >= 0.7 * this.minPath;
  }
  // Close everything (end of a clip)
  flush() {
    for (const tr of this.limbo.concat(this.tracks)) if (this.worthAnalysing(tr)) this.onTrack(tr);
    this.tracks = []; this.limbo = [];
  }
  confirmed() { return this.tracks.filter(tr => tr.pts.length >= 3); }
}

const mk = (c, t) => ({ t, u: c.u, v: c.v, a: c.area, y: c.yellow });
function add(tr, c, t) { tr.pts.push(mk(c, t)); }
function pathLen(p) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].u - p[i - 1].u, p[i].v - p[i - 1].v); return s; }

// Quadratic (Lagrange) extrapolation through the last three points.
function predict(pts, t) {
  const n = pts.length, a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
  const la = ((t - b.t) * (t - c.t)) / ((a.t - b.t) * (a.t - c.t));
  const lb = ((t - a.t) * (t - c.t)) / ((b.t - a.t) * (b.t - c.t));
  const lc = ((t - a.t) * (t - b.t)) / ((c.t - a.t) * (c.t - b.t));
  // Blend with linear extrapolation for long gaps (the quadratic overshoots)
  const f = (t - c.t) / (c.t - b.t);
  const lin = [c.u + (c.u - b.u) * f, c.v + (c.v - b.v) * f];
  const quad = [la * a.u + lb * b.u + lc * c.u, la * a.v + lb * b.v + lc * c.v];
  const wq = f <= 1.5 ? 1 : 0.5;
  return [quad[0] * wq + lin[0] * (1 - wq), quad[1] * wq + lin[1] * (1 - wq)];
}
