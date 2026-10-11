// Preloaded camera intrinsics: per phone model and lens, the 35 mm-equivalent focal length as published
// by the maker. Video frames are a 16:9 crop of the 4:3 sensor that keeps the full long side, so the
// horizontal field of view of the long side is 2·atan(17.31 / f_eq) (17.31 mm = half the long side of a
// 4:3 frame with a 43.27 mm diagonal) and f_px = long_px · f_eq / 34.62.
// Phone lenses ship distortion-corrected video (iOS applies geometric distortion correction to the
// ultra-wide), so k1 = k2 = 0 unless noted. The court calibration cross-checks the focal length.

const L = (main, uw, tele, tele2) => {
  const out = [{ id: 'main', feq: main }];
  if (uw) out.push({ id: 'uw', feq: uw });
  if (tele) out.push({ id: 'tele', feq: tele });
  if (tele2) out.push({ id: 'tele2', feq: tele2 });
  return out;
};

export const PRESETS = [
  { id: 'ip17pro', brand: 'Apple', name: 'iPhone 17 Pro / Pro Max', lenses: L(24, 13, 100) },
  { id: 'ip17', brand: 'Apple', name: 'iPhone 17', lenses: L(26, 13) },
  { id: 'ipair', brand: 'Apple', name: 'iPhone Air', lenses: L(26) },
  { id: 'ip16pro', brand: 'Apple', name: 'iPhone 16 Pro / Pro Max', lenses: L(24, 13, 120) },
  { id: 'ip16', brand: 'Apple', name: 'iPhone 16 / 16 Plus', lenses: L(26, 13) },
  { id: 'ip16e', brand: 'Apple', name: 'iPhone 16e', lenses: L(26) },
  { id: 'ip15promax', brand: 'Apple', name: 'iPhone 15 Pro Max', lenses: L(24, 13, 120) },
  { id: 'ip15pro', brand: 'Apple', name: 'iPhone 15 Pro', lenses: L(24, 13, 77) },
  { id: 'ip15', brand: 'Apple', name: 'iPhone 15 / 15 Plus', lenses: L(26, 13) },
  { id: 'ip14pro', brand: 'Apple', name: 'iPhone 14 Pro / Pro Max', lenses: L(24, 13, 77) },
  { id: 'ip14', brand: 'Apple', name: 'iPhone 14 / 14 Plus', lenses: L(26, 13) },
  { id: 'ip13pro', brand: 'Apple', name: 'iPhone 13 Pro / Pro Max', lenses: L(26, 13, 77) },
  { id: 'ip13', brand: 'Apple', name: 'iPhone 13 / 13 mini', lenses: L(26, 13) },
  { id: 'ip12promax', brand: 'Apple', name: 'iPhone 12 Pro Max', lenses: L(26, 13, 65) },
  { id: 'ip12pro', brand: 'Apple', name: 'iPhone 12 Pro', lenses: L(26, 13, 52) },
  { id: 'ip12', brand: 'Apple', name: 'iPhone 12 / 12 mini', lenses: L(26, 13) },
  { id: 'ip11pro', brand: 'Apple', name: 'iPhone 11 Pro / Pro Max', lenses: L(26, 13, 52) },
  { id: 'ip11', brand: 'Apple', name: 'iPhone 11', lenses: L(26, 13) },
  { id: 'ipxs', brand: 'Apple', name: 'iPhone X / XS / XR', lenses: L(26, 0, 52) },
  { id: 'ipse', brand: 'Apple', name: 'iPhone SE (2nd/3rd gen) / 8', lenses: L(28) },
  { id: 'px10pro', brand: 'Google', name: 'Pixel 9 Pro / 10 Pro (XL)', lenses: L(25, 12, 113) },
  { id: 'px9', brand: 'Google', name: 'Pixel 9 / 10', lenses: L(25, 12) },
  { id: 'px8pro', brand: 'Google', name: 'Pixel 8 Pro', lenses: L(25, 11, 113) },
  { id: 'px8', brand: 'Google', name: 'Pixel 8 / 8a', lenses: L(25, 11) },
  { id: 'px7pro', brand: 'Google', name: 'Pixel 7 Pro', lenses: L(25, 14, 120) },
  { id: 'px7', brand: 'Google', name: 'Pixel 6 / 7 / 7a', lenses: L(25, 14) },
  { id: 'sgultra5x', brand: 'Samsung', name: 'Galaxy S24 / S25 Ultra', lenses: L(24, 13, 69, 111) },
  { id: 'sgultra10x', brand: 'Samsung', name: 'Galaxy S22 / S23 Ultra', lenses: L(24, 13, 69, 230) },
  { id: 'sgs', brand: 'Samsung', name: 'Galaxy S22–S25 / Plus', lenses: L(24, 13, 69) },
  { id: 'sga', brand: 'Samsung', name: 'Galaxy A series', lenses: L(26, 13) },
  { id: 'android', brand: 'Other', name: 'Other phone (typical)', lenses: L(26, 14) },
  { id: 'custom', brand: 'Other', name: 'Custom lens', lenses: [{ id: 'custom', feq: 26 }] },
];

export function findPreset(id) { return PRESETS.find(p => p.id === id) || PRESETS.find(p => p.id === 'android'); }
export function findLens(preset, lensId) { return preset.lenses.find(l => l.id === lensId) || preset.lenses[0]; }

// Zoom label as the camera app shows it (0.5×, 1×, 3× …): nearest marketing step to the focal ratio.
const ZOOM_STEPS = [0.5, 1, 2, 2.5, 3, 4, 5, 10];
export function zoomLabel(preset, lens) {
  const z = lens.feq / preset.lenses[0].feq;
  let best = 1;
  for (const s of ZOOM_STEPS) if (Math.abs(Math.log(z / s)) < Math.abs(Math.log(z / best))) best = s;
  return best + '×';
}

export const focalPx = (feq, width, height) => Math.max(width, height) * feq / 34.62;
export const hfovDeg = feq => 2 * Math.atan(17.31 / feq) * 180 / Math.PI;
export const feqFromFocalPx = (f, width, height) => f * 34.62 / Math.max(width, height);

// Intrinsics for a video frame of the given size.
export function intrinsicsFor(settings, width, height) {
  const preset = findPreset(settings.preset);
  const lens = findLens(preset, settings.lens);
  const feq = preset.id === 'custom' ? (Number(settings.customFeq) || 26) : lens.feq;
  return {
    width, height,
    f: focalPx(feq, width, height),
    cx: width / 2, cy: height / 2,
    k1: preset.id === 'custom' ? (Number(settings.customK1) || 0) : 0,
    k2: 0,
    feq,
  };
}

// Map a MediaDeviceInfo label to a lens id. iOS Safari exposes physical lenses ("Back Ultra Wide
// Camera", "Back Telephoto Camera") and virtual multi-lens devices ("Back Dual Wide Camera",
// "Back Triple Camera") that switch lenses on their own — those are useless for a fixed calibration.
export function classifyDeviceLabel(label) {
  const s = (label || '').toLowerCase();
  if (/front|anterior|frontal|user|facing front/.test(s)) return 'front';
  if (/dual|triple|doppia|tripla|desktop view/.test(s)) return 'virtual';
  if (/ultra/.test(s)) return 'uw';
  if (/tele/.test(s)) return 'tele';
  return 'main';
}
