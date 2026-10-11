// ITF court geometry (metres, outer edges of the lines) in court coordinates (see camera.js).
export const C = {
  HL: 11.885,   // half length (baseline)
  HWD: 5.485,   // half doubles width
  HWS: 4.115,   // half singles width
  SL: 6.40,     // service line distance from the net
  NET_C: 0.914, // net height at the centre strap
  NET_P: 1.07,  // net height at the posts
  POST_X: 6.40, // posts 0.914 m outside the doubles sideline
  MARK: 0.10,   // centre mark length
};

// Painted lines along their centre lines (court dimensions are to the outer edges, so each line sits
// half its width inside): [x1, y1, x2, y2, family, width]. family: 't' = transverse (constant y),
// 'l' = longitudinal (constant x). Used for drawing, auto-detection and refinement.
const BL = C.HL - 0.05, SV = C.SL - 0.025, DX = C.HWD - 0.025, SX = C.HWS - 0.025;
export const LINES = [
  [-C.HWD, -BL, C.HWD, -BL, 't', 0.10],   // near baseline
  [-C.HWS, -SV, C.HWS, -SV, 't', 0.05],   // near service line
  [-C.HWS, SV, C.HWS, SV, 't', 0.05],     // far service line
  [-C.HWD, BL, C.HWD, BL, 't', 0.10],     // far baseline
  [-DX, -C.HL, -DX, C.HL, 'l', 0.05],     // left doubles sideline
  [-SX, -C.HL, -SX, C.HL, 'l', 0.05],     // left singles sideline
  [0, -C.SL, 0, C.SL, 'l', 0.05],         // centre service line
  [SX, -C.HL, SX, C.HL, 'l', 0.05],       // right singles sideline
  [DX, -C.HL, DX, C.HL, 'l', 0.05],       // right doubles sideline
];
export const LINE_Y = [-BL, -SV, SV, BL];        // transverse centre lines, near to far
export const LINE_X = [-DX, -SX, 0, SX, DX];     // longitudinal centre lines, left to right
export const MARKS = [[0, -C.HL, 0, -C.HL + C.MARK], [0, C.HL, 0, C.HL - C.MARK]];

// Keypoints for manual alignment: the line crossings (centre lines).
export const KEYPOINTS = [
  [-DX, -BL], [-SX, -BL], [0, -BL], [SX, -BL], [DX, -BL],
  [-SX, -SV], [0, -SV], [SX, -SV],
  [-SX, SV], [0, SV], [SX, SV],
  [-DX, BL], [-SX, BL], [0, BL], [SX, BL], [DX, BL],
];

export const netHeightAt = x => {
  const a = Math.min(1, Math.abs(x) / C.POST_X);
  return C.NET_C + (C.NET_P - C.NET_C) * a * a; // the cord sags roughly parabolically
};

// Serve geometry. A server at the near end (y < 0) faces +y; their right hand side is +x.
// Deuce = server's right half. The serve must land crosscourt in the service box on the far side.
export function serveSide(impact) {
  const facing = impact[1] < 0 ? 1 : -1;
  return impact[0] * facing >= 0 ? 'deuce' : 'ad';
}
// Signed distance (m) of a bounce from the correct service box: <= 0 inside (lines are in).
export function serviceBoxMargin(impact, bounce) {
  const far = impact[1] < 0 ? 1 : -1;            // receiver half sign
  const sx = impact[0] >= 0 ? -1 : 1;            // crosscourt half
  const x = bounce[0] * sx, y = bounce[1] * far; // fold into the canonical box 0<=x<=HWS, 0<=y<=SL
  const dx = Math.max(-x, x - C.HWS), dy = Math.max(-y, y - C.SL);
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
// Generic in/out for rally shots: inside the singles court on the far half.
export function singlesMargin(start, bounce) {
  const far = start[1] < 0 ? 1 : -1;
  const x = Math.abs(bounce[0]), y = bounce[1] * far;
  const dx = x - C.HWS, dy = Math.max(-y, y - C.HL);
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

// Ball (ITF type 2): 56.0–59.4 g, 6.54–6.86 cm.
export const BALL = { mass: 0.0577, radius: 0.0335 };
