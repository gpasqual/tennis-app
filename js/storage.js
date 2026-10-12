// Settings, calibration and the serve log live in localStorage (all small).
import { detectLang } from './i18n.js';

const SETTINGS_KEY = 'serveng.settings.v1';
const CAL_KEY = 'serveng.calibration.v1';
const SHOTS_KEY = 'serveng.shots.v1';
const MAX_SHOTS = 5000;

const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

export const DEFAULT_SETTINGS = {
  lang: detectLang(),
  units: 'metric',          // 'metric' (km/h) | 'imperial' (mph)
  preset: isIOS ? 'ip15' : 'android',
  presetAuto: true,         // follow the detected phone model until the user picks one
  stabilize: true,          // follow small turns of a hand-held / loosely mounted phone
  lens: 'uw',               // 0.5x ultra-wide: the recommended side-of-court setup (falls back to main)
  customFeq: 26,            // 35 mm-equivalent focal length for the custom lens
  customK1: 0,
  deviceId: '',
  resolution: '720',        // '720' | '1080'
  fps: 60,
  procW: 960,               // detection image width cap
  sensitivity: 1,           // 0.7 low | 1 normal | 1.4 high
  shots: 'serves',          // 'serves' | 'all'
  voice: true,
  keepAwake: true,
  tempC: 20,
  altitude: 0,
  cd: 0.55,
  debug: false,
  slowmo: 1,                // time scale of a slowed-down video file (4 = 120 fps shown at 30)
};

function readJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadSettings() { return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) }; }
export function saveSettings(s) { writeJson(SETTINGS_KEY, s); }

export function loadCalibration() { return readJson(CAL_KEY, null); }
export function saveCalibration(c) { writeJson(CAL_KEY, c); }
export function clearCalibration() { try { localStorage.removeItem(CAL_KEY); } catch { /* private mode */ } }

export function loadShots() { return readJson(SHOTS_KEY, []); }
export function addShot(rec) {
  const all = loadShots();
  all.push(rec);
  while (all.length > MAX_SHOTS) all.shift();
  return writeJson(SHOTS_KEY, all);
}
export function deleteShots(pred) { writeJson(SHOTS_KEY, loadShots().filter(r => !pred(r))); }
export function clearShots() { writeJson(SHOTS_KEY, []); }

// Sessions are runs between Start and Stop: group the log by sessionId, newest first.
export function listSessions() {
  const by = new Map();
  for (const r of loadShots()) {
    if (!by.has(r.session)) by.set(r.session, { id: r.session, start: r.ts, end: r.ts, shots: [] });
    const s = by.get(r.session);
    s.shots.push(r); s.start = Math.min(s.start, r.ts); s.end = Math.max(s.end, r.ts);
  }
  return [...by.values()].sort((a, b) => b.start - a.start);
}
