"""Render synthetic court images for the court-detection tests.

python tests/render_court.py cams.json outdir
cams.json: [{ name, width, height, f, cx, cy, R: [9], t: [3], surface, texture }]
texture: brush marks on the surface and a tree shadow with sun flecks over part of the court (real clay).
Writes <outdir>/<name>.rgba (raw RGBA bytes) and <outdir>/<name>.png (for looking at).
"""
import json, sys, os
import numpy as np
import cv2

HL, HWD, HWS, SL = 11.885, 5.485, 4.115, 6.40
LINES = [(-HWD, -HL, HWD, -HL, 0.10), (-HWS, -SL, HWS, -SL, 0.05), (-HWS, SL, HWS, SL, 0.05), (-HWD, HL, HWD, HL, 0.10),
         (-HWD, -HL, -HWD, HL, 0.05), (-HWS, -HL, -HWS, HL, 0.05), (0, -SL, 0, SL, 0.05), (HWS, -HL, HWS, HL, 0.05), (HWD, -HL, HWD, HL, 0.05),
         (0, -HL, 0, -HL + 0.1, 0.05), (0, HL, 0, HL - 0.1, 0.05)]
SURF = {'blue': ((150, 95, 45), (70, 120, 60)), 'green': ((80, 125, 60), (70, 100, 70)), 'clay': ((70, 110, 190), (60, 95, 160))}  # BGR court, surround


def clip_front(poly, R, t, zmin=0.2):
    """Sutherland–Hodgman clip of a world polygon against camera depth >= zmin."""
    def depth(p):
        return float((R @ p + t)[2])
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        da, db = depth(a), depth(b)
        if da >= zmin:
            out.append(a)
        if (da >= zmin) != (db >= zmin):
            s = (zmin - da) / (db - da)
            out.append(a + s * (b - a))
    return out


def project(pts, K, R, t):
    P = (R @ np.array(pts).T).T + t
    uv = (K @ P.T).T
    return uv[:, :2] / uv[:, 2:3]


def fill(img, poly3d, color, K, R, t, ss):
    poly = clip_front([np.array(p, float) for p in poly3d], R, t)
    if len(poly) < 3:
        return
    uv = project(poly, K, R, t) * ss - 0.5  # model pixel coords (pixel i spans [i, i+1)) -> OpenCV centres
    cv2.fillPoly(img, [np.round(uv * 16).astype(np.int32)], color, lineType=cv2.LINE_AA, shift=4)


def texture(img, K, R, t, ss, rng):
    """Clay brush marks (short pale streaks) everywhere on the ground, and a blotchy tree shadow with
    sun flecks across the middle of the picture."""
    Hs, Ws = img.shape[:2]
    ground = np.zeros((Hs, Ws), np.uint8)
    fill(ground, [(-60, -60, 0), (60, -60, 0), (60, 80, 0), (-60, 80, 0)], 255, K, R, t, ss)
    marks = np.zeros((Hs, Ws), np.float32)
    n = Hs * Ws // 900
    for _ in range(n):
        x, y = rng.integers(0, Ws), rng.integers(0, Hs)
        a = rng.normal(0, 0.6)
        L = rng.integers(10 * ss, 45 * ss)
        cv2.line(marks, (int(x), int(y)), (int(x + L * np.cos(a)), int(y + L * np.sin(a))), float(rng.uniform(0.3, 1.0)), int(rng.integers(1, 3 * ss)))
    marks = cv2.GaussianBlur(marks, (0, 0), ss * 0.8)
    g = (ground > 0)[..., None]
    pale = np.array([150, 190, 225], np.float32)  # BGR dry clay
    f = img.astype(np.float32)
    f = np.where(g, f + (pale - f) * np.clip(marks, 0, 1)[..., None] * 0.55, f)
    # tree shadow: low-frequency blobs, holes of sun inside
    lo = cv2.resize(rng.random((Hs // (60 * ss) + 2, Ws // (60 * ss) + 2)).astype(np.float32), (Ws, Hs), interpolation=cv2.INTER_CUBIC)
    band = np.exp(-((np.arange(Ws)[None, :] - Ws * 0.5) / (Ws * 0.18)) ** 2)
    shade = (lo * band > 0.42)
    hi = cv2.resize(rng.random((Hs // (12 * ss) + 2, Ws // (12 * ss) + 2)).astype(np.float32), (Ws, Hs), interpolation=cv2.INTER_CUBIC)
    shade &= ~(hi > 0.78)
    sm = cv2.GaussianBlur(shade.astype(np.float32), (0, 0), ss * 1.5)[..., None]
    f = np.where(g, f * (1 - 0.6 * sm), f)
    img[:] = np.clip(f, 0, 255).astype(np.uint8)


def render(cam, rng):
    W, H = cam['width'], cam['height']
    ss = 2  # supersample
    K = np.array([[cam['f'], 0, cam['cx']], [0, cam['f'], cam['cy']], [0, 0, 1]])
    R = np.array(cam['R']).reshape(3, 3)
    t = np.array(cam['t'])
    court, surround = SURF[cam.get('surface', 'blue')]
    img = np.zeros((H * ss, W * ss, 3), np.uint8)
    # sky + background trees
    for y in range(H * ss):
        img[y, :] = (235 - y * 40 // (H * ss), 200 - y * 30 // (H * ss), 170)
    noise = rng.integers(0, 60, (H * ss // 8 + 1, W * ss // 8 + 1)).astype(np.uint8)
    trees = cv2.resize(noise, (W * ss, H * ss), interpolation=cv2.INTER_CUBIC)
    # ground and court
    fill(img, [(-60, -60, 0), (60, -60, 0), (60, 80, 0), (-60, 80, 0)], surround, K, R, t, ss)
    # horizon band of trees: everything above the projected far ground edge that is still sky
    sky = (img[:, :, 2] == 170)
    tree_col = np.stack([40 + trees // 2, 70 + trees, 50 + trees // 3], -1).astype(np.uint8)
    band = sky.copy()
    rows = np.where(sky.any(1))[0]
    if len(rows):
        last = rows.max()
        band[: max(0, last - int(0.12 * H * ss))] = False
    img[band] = tree_col[band]
    fill(img, [(-HWD - 3.5, -HL - 6, 0), (HWD + 3.5, -HL - 6, 0), (HWD + 3.5, HL + 6, 0), (-HWD - 3.5, HL + 6, 0)], court, K, R, t, ss)
    for x1, y1, x2, y2, w in LINES:
        if x1 == x2:
            poly = [(x1 - w / 2, y1, 0), (x1 + w / 2, y1, 0), (x2 + w / 2, y2, 0), (x2 - w / 2, y2, 0)]
            # lines are measured to the outside edge: sidelines/baselines lie inside the court
            off = -np.sign(x1) * w / 2 if x1 != 0 else 0
            poly = [(p[0] + off, p[1], 0) for p in poly]
        else:
            off = -np.sign(y1) * w / 2
            poly = [(x1, y1 - w / 2 + off, 0), (x2, y2 - w / 2 + off, 0), (x2, y2 + w / 2 + off, 0), (x1, y1 + w / 2 + off, 0)]
        fill(img, poly, (235, 238, 240), K, R, t, ss)
    if cam.get('texture'):
        texture(img, K, R, t, ss, rng)
    # net: dark mesh with white tape, posts
    mesh = img.copy()
    fill(mesh, [(-6.4, 0, 0), (6.4, 0, 0), (6.4, 0, 1.07), (0, 0, 0.914), (-6.4, 0, 1.07)], (30, 30, 30), K, R, t, ss)
    img = cv2.addWeighted(img, 0.45, mesh, 0.55, 0)  # see-through mesh
    fill(img, [(-6.4, 0, 1.07), (0, 0, 0.914), (6.4, 0, 1.07), (6.4, 0, 1.0), (0, 0, 0.85), (-6.4, 0, 1.0)], (240, 240, 240), K, R, t, ss)
    for px in (-6.4, 6.4):
        fill(img, [(px - 0.04, 0, 0), (px + 0.04, 0, 0), (px + 0.04, 0, 1.07), (px - 0.04, 0, 1.07)], (30, 60, 30), K, R, t, ss)
    # a player near the far baseline and one near the near baseline (dark blobs)
    for (x, y) in ((1.0, HL + 0.5), (-0.8, -HL - 0.5)):
        fill(img, [(x - 0.25, y, 0), (x + 0.25, y, 0), (x + 0.25, y, 1.8), (x - 0.25, y, 1.8)], (50, 30, 140), K, R, t, ss)
    img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), 0.6)
    img = np.clip(img.astype(np.int16) + rng.normal(0, 4, img.shape).astype(np.int16), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    img = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return img


def main():
    cams = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(3)
    for cam in cams:
        img = render(cam, rng)
        cv2.imwrite(os.path.join(out, cam['name'] + '.png'), img)
        rgba = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
        rgba.tofile(os.path.join(out, cam['name'] + '.rgba'))
    print('rendered', len(cams))


if __name__ == '__main__':
    main()
