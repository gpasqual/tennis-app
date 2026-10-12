// App-shell service worker: network-first for our own files (always fresh when online, still works
// offline), pass-through for anything else.
const VERSION = 'serve-ng-v1.5.0';
const SHELL = [
  './', 'index.html', 'css/app.css',
  'js/app.js', 'js/i18n.js', 'js/storage.js', 'js/lenses.js', 'js/camera.js', 'js/linalg.js', 'js/court.js', 'js/courtdetect.js',
  'js/physics.js', 'js/trajectory.js', 'js/detector.js', 'js/tracker.js', 'js/overlay.js', 'js/calib.js', 'js/sources.js',
  'js/sim.js', 'js/simscene.js', 'js/worker.js', 'js/results.js', 'js/device.js', 'js/stabilizer.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
