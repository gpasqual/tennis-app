// Best-effort phone model detection. Browsers do not name the phone: Android Chrome tells the model
// through User-Agent Client Hints; on iPhone only the screen size (points × pixel ratio) narrows it to
// a family. That is enough here: every iPhone with an ultra-wide has the same 13 mm-equivalent lens,
// and the court calibration measures the real focal length anyway.

// iPhone families by portrait screen size in points and device pixel ratio.
const IPHONES = [
  { w: 440, h: 956, dpr: 3, preset: 'ip17pro', label: 'iPhone 16 Pro Max / 17 Pro Max' },
  { w: 402, h: 874, dpr: 3, preset: 'ip17pro', label: 'iPhone 16 Pro / 17 / 17 Pro' },
  { w: 420, h: 912, dpr: 3, preset: 'ipair', label: 'iPhone Air' },
  { w: 430, h: 932, dpr: 3, preset: 'ip15promax', label: 'iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus' },
  { w: 393, h: 852, dpr: 3, preset: 'ip15pro', label: 'iPhone 14 Pro / 15 / 15 Pro / 16' },
  { w: 428, h: 926, dpr: 3, preset: 'ip14', label: 'iPhone 12 Pro Max / 13 Pro Max / 14 Plus' },
  { w: 390, h: 844, dpr: 3, preset: 'ip13', label: 'iPhone 12 / 13 / 14 / 16e' },
  { w: 375, h: 812, dpr: 3, preset: 'ip11pro', label: 'iPhone X / XS / 11 Pro / 12 mini / 13 mini' },
  { w: 414, h: 896, dpr: 3, preset: 'ip11pro', label: 'iPhone XS Max / 11 Pro Max' },
  { w: 414, h: 896, dpr: 2, preset: 'ip11', label: 'iPhone XR / 11' },
  { w: 375, h: 667, dpr: 2, preset: 'ipse', label: 'iPhone SE / 8' },
  { w: 414, h: 736, dpr: 3, preset: 'ipse', label: 'iPhone 8 Plus' },
];

export function iphoneFromScreen(w, h, dpr) {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  return IPHONES.find(p => Math.abs(p.w - a) <= 1 && Math.abs(p.h - b) <= 1 && Math.abs(p.dpr - dpr) < 0.3) || null;
}

// Android model names (Client Hints "model", e.g. "Pixel 8 Pro", "SM-S928B") to presets.
export function androidPreset(model) {
  const m = (model || '').trim();
  const rules = [
    [/Pixel (9|10) Pro/i, 'px10pro'], [/Pixel (9|10)\b/i, 'px9'],
    [/Pixel 8 Pro/i, 'px8pro'], [/Pixel 8/i, 'px8'],
    [/Pixel 7 Pro/i, 'px7pro'], [/Pixel (6|7)/i, 'px7'],
    [/SM-S9[23]8/i, 'sgultra5x'],           // Galaxy S24 / S25 Ultra
    [/SM-S9[01]8/i, 'sgultra10x'],          // Galaxy S22 / S23 Ultra
    [/SM-S9\d\d/i, 'sgs'],                  // Galaxy S22–S25 / Plus
    [/SM-A\d/i, 'sga'],                     // Galaxy A series
  ];
  for (const [re, id] of rules) if (re.test(m)) return id;
  return null;
}

// { preset, label, sure } — preset falls back to the generic phone when nothing matches.
export async function detectPhone() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) {
    const fam = iphoneFromScreen(screen.width, screen.height, window.devicePixelRatio || 2);
    return fam ? { preset: fam.preset, label: fam.label, sure: true } : { preset: 'ip15', label: 'iPhone', sure: false };
  }
  if (/Android/.test(ua)) {
    let model = '';
    try {
      if (navigator.userAgentData?.getHighEntropyValues) model = (await navigator.userAgentData.getHighEntropyValues(['model'])).model || '';
    } catch { /* hints unavailable */ }
    if (!model) { const m = ua.match(/Android [\d.]+; ([^;)]+)\)/); if (m && m[1].trim() !== 'K') model = m[1].trim(); }
    const preset = androidPreset(model);
    return { preset: preset || 'android', label: model || 'Android', sure: !!preset };
  }
  return { preset: 'android', label: '', sure: false };
}
