# SERVE-NG — tennis serve speed from a phone camera

An installable web app (iPhone or Android) that films the court, finds the court lines, tracks the ball
and estimates the speed of every serve on the fly — like a radar gun, from one phone.
Built the same way as MOTO-NG: plain HTML/JS modules, no build step, no backend, hosted on GitHub Pages.

**What it does**
- Live camera feed (rear camera, 720p/1080p, 60 fps preferred) with the court overlaid
- **Court calibration**: automatic court-line detection, or drag the line crossings into place (with a magnifier),
  then *Snap to lines* for sub-pixel precision. Works from behind the baseline, from the corner or from the side.
- **Preloaded camera intrinsics** per phone model and lens (iPhone 8 → 17 Pro, Pixel 6 → 10 Pro, Galaxy S22 → S25 Ultra,
  generic and custom). The calibration cross-checks the focal length against the court and warns if the wrong lens is selected.
- **Serve speed at the racket** (what a radar shows), with an uncertainty (±) and a quality label, spoken aloud
- Contact height, net clearance, speed at the bounce, flight time, deuce/ad side and an **in / out call** for the service box
- Placement chart of where each serve landed, session stats (max, average, % in), history and CSV export
- Calibration warns when the server's contact point or the bounce area is out of frame, or the lens looks wrong
- **Expected accuracy** for your camera position, computed right after calibration
- **Demo mode**: a simulated court with serves of known speed, run through exactly the same pipeline
- **Analyse a video** recorded earlier (including slow-motion clips)
- EN / IT, km/h / mph, works offline once loaded

Everything runs on the phone. No video leaves the device.

---

## 1. Run it locally

```bash
python tests/devserver.py 8781   # or: python -m http.server 8781
```

Open <http://localhost:8781> and tap **Try the demo**, then **Calibrate** → **Use** → **Start**.
The camera needs HTTPS (or localhost).

## 2. Put it on the phone (GitHub Pages)

Same as MOTO-NG: push this folder to a GitHub repository and enable **Settings › Pages › Deploy from a branch ›
`main` / (root)**. The app is then at `https://<you>.github.io/tennis-app/`.
On iPhone open it in Safari → Share → **Add to Home Screen**; on Android Chrome → **Install app**.

## 3. At the court

1. **Camera & lens** (tap the lens chip): the phone is **detected automatically** (Android: the exact model from the
   browser; iPhone: the model family from the screen size — all iPhones with an ultra-wide share the same 13 mm lens)
   and the **0.5× ultra-wide** is selected. On iPhone the app opens the matching physical camera ("Back Ultra Wide
   Camera"); avoid "Dual"/"Triple" — those switch lenses by themselves. Pick a model by hand only if the detection is
   wrong. Prefer **60 fps**.
   The court calibration then **measures the lens** from the court lines: if the camera in use is not the selected lens
   (e.g. on Android, where cameras are not named), the app notices and switches to the right one.
2. **Place the phone** steady, landscape:
   - **recommended (default)**: at the side of the court, exactly level with the net, about 5–6 m outside the
     doubles sideline (as far back as the side fence allows), 1.8–2.5 m high, **0.5× ultra-wide**, aimed at the middle
     of the net so both baselines and both servers are in the frame — serves from either end are measured equally
     well. Closer than ~5 m, the nearer server's contact point leaves the frame (the app warns after calibration);
   - also good: behind the baseline at the server's end, 3–6 m to the side of the centre mark, 2.5–3 m high, 1× lens;
   - avoid: straight behind the server at head height (the ball flies along the line of sight).
3. **Calibrate**: it starts by itself when the camera (or a video) has no calibration. The controls sit beside the
   picture (below it in portrait), so the whole court stays visible. Check the green lines sit on the court lines;
   drag a point if not, then *Snap to lines* and **Use**. The toast tells you the expected accuracy for that
   placement, for serves from either end.
4. **Start** and serve. Each serve shows up within about a second of the bounce.

Re-calibrate whenever the phone is moved to another spot. Small turns are followed: every frame is registered
against the calibration frame (a phone that is hand-held or wobbles on the fence turns about its own lens, so one
rotation maps the whole picture) and resampled into the calibrated view before the ball is looked for. A tripod or a
fence clamp is still better: steadier frames, fewer false detections.

**Slow motion.** Browsers give a web app at most about 60 fps live (the 120/240 fps slow-motion modes are only for the
phone's own camera app). Recorded slow-motion clips can be analysed with *Analyse a video*: an original high-speed
file (e.g. 240 fps) is detected and played slowly so every frame is used. A clip that was exported already slowed down
(240 fps shown at 30 fps) needs *Settings › Slow motion* set to the slow-down factor (8×). Calibrate on a paused frame
of the clip.

## 4. How the speed is computed

| Step | Method |
|---|---|
| Intrinsics | 35 mm-equivalent focal length of the selected lens → focal length in pixels for the video size (16:9 video keeps the full sensor width). The court fit also estimates the focal length; a mismatch over 6 % is flagged. |
| Court calibration | White-line pixels: thin bright ridges that stand out from the local texture (brush marks, leaves, sun flecks are ridges too, but weaker), with a direction from the structure tensor → Hough lines voted only along each pixel's own direction and kept only where they form a continuous stroke → lines grouped by vanishing point → every pair of transverse + longitudinal lines matched to court lines gives a homography; the focal length it implies is solved for (Zhang's constraints) across all the phone's lenses, and the pose must be plausible → best hypotheses refined: strokes and a ridge search along each projected line (net cord masked out), pose and focal length optimised on point-to-line distances. The preset focal length is kept when the measurement agrees within 2 % or the view cannot tell. |
| Ball candidates | Three-frame difference (a pixel moving relative to both the previous and the next frame) inside the projected air space above the court; connected components filtered by size; fragments next to players flagged. |
| Tracking | Candidates linked by quadratic prediction, a wider second-chance gate for the bounce kink, duplicate suppression and stitching of a track that was lost for a few frames. |
| Track clean-up | The track is cut into smooth arcs (dynamic programming); the longest stretch that two arcs explain (before and after the bounce) is kept, which drops the toss, the racket and the receiver's return. Isolated false detections are removed. |
| 3D flight | One camera cannot triangulate, but the ball follows physics. A model with gravity, quadratic drag (ρ from temperature and altitude, C_d 0.55) and Magnus lift/side force is fitted (Levenberg–Marquardt) to the rays of the tracked pixels. The bounce time is where the incoming arc hits the court, and the outgoing arc must start there — that pins the depth. Several bounce candidates and start points are tried with a quick approximate fit; flights that do not start from a serve position are dropped before the full fit. |
| Serve speed | The fitted flight is integrated back to the contact plane (0.4 m inside the baseline): that speed is what a radar reports. The ± comes from the fit covariance. |
| Quality | good / fair / rough from the ±, the number of points, whether the bounce was seen, how far the fit had to extrapolate back to the racket, whether the contact height and the bounce position are consistent, and whether two different starts give different speeds (ambiguous view). Rough results are shown greyed and left out of max / average. |

How well it works (synthetic, `tests/`):
- **Monte Carlo** on 120–210 km/h serves with spin, 8 % missed detections and 4 % false matches: with a recommended
  placement, 90 % of the serves rated good/fair are within **±2.5–3.5 % at 60 fps** and **±3–4.5 % at 30 fps**
  (side of the court with the 0.5× lens: ±2.5 % / ±3.2 %).
  Straight behind either player is clearly worse (±6–10 %), and the app says so after calibration.
- **End to end** (rendered court frames → detector → tracker → analysis, `tests/e2e.html`): from the default spot
  (side of the court at the net, 0.5×) **9 of 9** demo serves measured, all within **±0.5 %**, bounce positions within
  ~1 cm, every in/out call right, no false serves; from behind the baseline 8 of 9. On **red clay** (also with
  clay-dusted pinkish lines and a worn, clay-stained ball) 9 of 9 within ±0.6 %.
- **Dusty clay lines**: auto-detect finds the court until the lines are ~65 % clay-coloured; beyond that, drag the
  points roughly into place and *Snap to lines* still locks on (within ~2 cm).
- **Court calibration** on rendered courts (7 placements × 3 resolutions, plus the demo court): camera position
  within a few centimetres, focal-length check within 0.5 %.

These are simulations. Real footage adds motion blur, rolling shutter, clutter on neighbouring courts and lighting
changes; expect it to be somewhat worse until it has been tuned on real serves.

**Real footage** (first clip: iPhone 14, 1080p30 HDR, hand-held, raised spot behind the corner of a clay court with a
tree shadow and brush marks):
- **Court calibration** finds the court on every frame tried, the same camera each time (within ~5 cm), whichever
  lens is selected. Two things had to change for it: line pixels are now judged against the texture around them (the
  brushed clay and the sun flecks made thousands of false line pixels; lines inside the shadow were missed), and the
  **focal length is measured from the court** instead of trusted from the preset — iPhone video is cropped for
  stabilisation, so the "26 mm" main camera recorded like a **31 mm** lens.
- **Hand-held**: the picture shifted 0.5–2.6 px between frames and drifted up to ~150 px (about 7°) over 10 s. The
  stabiliser follows it to ~1 px (checked against re-calibrating the court on frames across the clip) in ~19 ms per
  frame; after it, only the players, their shadows and the ball show up as moving. On rendered serves with a
  simulated hand-held camera (±1.2° drift plus jitter) speeds stay within ±0.4 %.
- **Serve speed: not yet on this clip.** The ball is tracked from the racket to the net, but at 30 fps from behind
  and above the server the ball beyond the net is a faint 2–4 px dot that is not picked up, and without the bounce
  the speed is not pinned down (this view mostly looks along the flight). Next: detection of the far, small ball.

## 5. Project layout

```
index.html            markup + icon sprite
css/app.css           theme and layout
js/app.js             controller: sources, run loop, results, sheets, settings, history
js/lenses.js          phone/lens database and intrinsics
js/camera.js          pinhole camera with radial distortion, pose from homography
js/court.js           ITF court geometry, service-box calls
js/courtdetect.js     automatic court calibration and refinement
js/calib.js           calibration UI: auto-detect, draggable keypoints, loupe, snap, lens measured from the court
js/device.js          phone model detection (Android client hints, iPhone screen family)
js/detector.js        ball candidates (three-frame differencing in the court air space, on stabilised frames)
js/stabilizer.js      camera rotation tracking against the calibration frame (hand-held / wobbly phone)
js/tracker.js         candidate linking into tracks
js/physics.js         ball flight (drag + Magnus), RK4
js/trajectory.js      track clean-up, bounce candidates, 3D flight fit, speed, uncertainty, quality
js/results.js         merges results that describe the same serve
js/worker.js          analysis, calibration and accuracy estimate off the UI thread
js/sources.js         camera / video file sources, frame timing
js/sim.js, simscene.js  simulated serves and the rendered demo court
js/overlay.js         drawing (court, detections, flight) and placement charts
js/storage.js, i18n.js  settings / serve log, EN + IT strings
tests/                node tests (maths, court detection on rendered images) and an in-browser end-to-end test
```

Tests (from this folder):

| Test | What it checks |
|---|---|
| `node tests/trajectory.test.js` | Monte Carlo of the speed fit for 7 camera placements at 60 and 30 fps (`TRIALS=40` for more) |
| `node tests/tracks.test.js` | regression tracks captured from the end-to-end run (serves that start on the toss / racket) |
| `node tests/court.test.js <outdir>` | automatic calibration on courts rendered by `tests/render_court.py` (Python + OpenCV); `W=1920` for other sizes |
| `tests/e2e.html?seconds=45` | in the browser: rendered demo frames through the real detector, tracker and analysis; `&shake=1` turns the camera like a hand-held phone |
| `tests/diag.html?from=2&to=5` | detection recall and track purity against the demo ground truth |
| `node tests/clip.mjs <video> [--from s --to s --dump]` | a recorded phone clip (as is: rotation, HDR) through calibration, stabiliser, detector, tracker and analysis in Node; lists the shots found (`--dump`: candidates per frame) |
| `tests/realclip.html?dir=out/real&fps=29.97&n=295` | a real clip (frames extracted with `ffmpeg -i clip.mp4 -q:v 3 tests/out/real/f_%04d.jpg`) through calibration, detector, tracker and analysis; lists every track |

`python tests/devserver.py` serves the folder with caching disabled (fresh modules on every reload).
