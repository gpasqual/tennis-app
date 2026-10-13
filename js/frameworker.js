// Frame worker: the stabiliser and the ball detector on each video frame (see pipeline.js).
import { FrameAnalyser } from './pipeline.js';

let ok = false;
try { ok = !!new OffscreenCanvas(1, 1).getContext('2d'); } catch { ok = false; }
if (!ok) postMessage({ type: 'unsupported' });

const A = new FrameAnalyser();
onmessage = e => {
  const m = e.data;
  try {
    const result = A.handle(m);
    postMessage({ type: 'reply', result });
  } catch (err) {
    postMessage({ type: 'error', error: String(err && err.stack || err) });
  } finally {
    m.image?.close?.();
  }
};
