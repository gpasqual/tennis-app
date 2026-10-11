// Camera / video-file frame sources and frame timing.
import { classifyDeviceLabel } from './lenses.js';

export async function startCamera({ deviceId = '', resolution = '720', fps = 60 } = {}) {
  const [w, h] = resolution === '1080' ? [1920, 1080] : [1280, 720];
  const video = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } };
  if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { ideal: 'environment' };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  // Keep the optical zoom at 1x: the calibration and the lens preset assume it
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom) await track.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min ?? 1, Math.min(caps.zoom.max ?? 1, 1)) }] });
  } catch { /* not supported */ }
  return { stream, track };
}

// Back cameras with their lens type guessed from the label (labels need camera permission first).
export async function listCameras() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label || 'Camera', type: classifyDeviceLabel(d.label) }));
}

// Per-frame timestamps on the camera clock. Prefers the capture time, falls back to media time and
// finally to presentation time, snapped to the frame grid so display jitter does not leak into the
// ball timing.
export class FrameClock {
  constructor(fps = 60) { this.period = 1 / fps; this.last = null; this.lastRaw = null; }
  reset() { this.last = null; this.lastRaw = null; }
  stamp(now, meta) {
    let raw;
    if (meta && meta.captureTime > 0) raw = meta.captureTime / 1000;
    else if (meta && meta.mediaTime > 0 && (this.lastRaw == null || meta.mediaTime > this.lastRaw.media)) raw = meta.mediaTime;
    else raw = now / 1000;
    const media = meta ? meta.mediaTime : 0;
    if (this.last == null || raw <= this.lastRaw?.raw || raw - this.lastRaw.raw > 1) {
      this.last = raw; this.lastRaw = { raw, media };
      return raw;
    }
    const d = raw - this.lastRaw.raw;
    const n = Math.max(1, Math.round(d / this.period));
    if (n <= 2) this.period += 0.02 * (d / n - this.period);
    let t = this.last + n * this.period;
    t += 0.1 * (raw - t); // follow the clock slowly
    this.last = t; this.lastRaw = { raw, media };
    return t;
  }
}

// requestVideoFrameCallback loop with a requestAnimationFrame fallback. Returns a stop function.
export function frameLoop(video, cb) {
  let stopped = false, handle = null;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const step = (now, meta) => { if (stopped) return; cb(now, meta); handle = video.requestVideoFrameCallback(step); };
    handle = video.requestVideoFrameCallback(step);
    return () => { stopped = true; if (handle != null) video.cancelVideoFrameCallback(handle); };
  }
  let lastTime = -1;
  const step = now => {
    if (stopped) return;
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; cb(now, { mediaTime: video.currentTime }); }
    handle = requestAnimationFrame(step);
  };
  handle = requestAnimationFrame(step);
  return () => { stopped = true; cancelAnimationFrame(handle); };
}
