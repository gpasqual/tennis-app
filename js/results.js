// Several tracks can describe the same shot (the flight split in two, a piece picked up by a second
// track). Results whose impact times are within 0.4 s are one shot: wait briefly for all pieces, then
// keep the best-determined one.
const RANK = { good: 2, ok: 1, poor: 0 };
const better = (a, b) => (RANK[a.quality] - RANK[b.quality]) || ((b.sigma / b.speed) - (a.sigma / a.speed)) || (a.n - b.n);

export class ResultGate {
  constructor(onShot, { wait = 600 } = {}) {
    this.onShot = onShot; this.wait = wait;
    this.pending = []; this.recent = [];
  }
  push(res) {
    if (this.recent.some(r => Math.abs(r.tImpact - res.tImpact) < 0.4)) return; // already reported
    const same = this.pending.find(p => Math.abs(p.res.tImpact - res.tImpact) < 0.4);
    if (same) { if (better(res, same.res) > 0) same.res = res; return; }
    const entry = { res };
    entry.timer = this.wait > 0 ? setTimeout(() => this.emit(entry), this.wait) : null;
    this.pending.push(entry);
  }
  emit(entry) {
    this.pending = this.pending.filter(p => p !== entry);
    this.recent.push(entry.res);
    if (this.recent.length > 20) this.recent.shift();
    this.onShot(entry.res);
  }
  flush() { for (const e of this.pending.slice()) { clearTimeout(e.timer); this.emit(e); } }
  reset() { for (const e of this.pending) clearTimeout(e.timer); this.pending = []; this.recent = []; }
}
