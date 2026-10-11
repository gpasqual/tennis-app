"""Draw estimated court lines (red) and Hough lines (yellow) over rendered test images.
python tests/overlay_court.py outdir   (reads outdir/est.json written by court.test.js)
"""
import json, os, sys
import numpy as np
import cv2

out = sys.argv[1]
est = json.load(open(os.path.join(out, 'est.json')))
HL, HWD, HWS, SL = 11.885, 5.485, 4.115, 6.40
LINES = [(-HWD, -HL, HWD, -HL), (-HWS, -SL, HWS, -SL), (-HWS, SL, HWS, SL), (-HWD, HL, HWD, HL),
         (-HWD, -HL, -HWD, HL), (-HWS, -HL, -HWS, HL), (0, -SL, 0, SL), (HWS, -HL, HWS, HL), (HWD, -HL, HWD, HL)]
for e in est:
    img = cv2.imread(os.path.join(out, e['name'] + '.png'))
    for l in e.get('hough', []):
        cv2.line(img, tuple(int(v) for v in l['a']), tuple(int(v) for v in l['b']), (0, 220, 255), 1)
    if e.get('cam'):
        c = e['cam']
        K = np.array([[c['f'], 0, c['cx']], [0, c['f'], c['cy']], [0, 0, 1]])
        R = np.array(c['R']).reshape(3, 3); t = np.array(c['t'])
        for x1, y1, x2, y2 in LINES:
            pts = []
            for s in np.linspace(0, 1, 30):
                P = R @ np.array([x1 + (x2 - x1) * s, y1 + (y2 - y1) * s, 0]) + t
                if P[2] > 0.1:
                    q = K @ P; pts.append((q[:2] / q[2]))
            for a, b in zip(pts, pts[1:]):
                cv2.line(img, tuple(int(v) for v in a), tuple(int(v) for v in b), (0, 0, 255), 1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(out, e['name'] + '_est.png'), img)
print('overlays written')
