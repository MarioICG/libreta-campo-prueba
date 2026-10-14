// Service worker: la app funciona sin conexión y guarda las teselas de mapa que ya viste.
const VERSION = 'libreta-v1.1.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/geo.js', 'js/sensors.js', 'js/camera.js', 'js/watermark.js',
  'js/map.js', 'js/capas.js', 'js/export.js', 'js/place.js', 'js/qml.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/jszip.min.js', 'vendor/piexif.js', 'vendor/wmm.js', 'vendor/geoide.js',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
  'fonts/barlow-condensed-latin-500-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon-180.png',
];
const TILES = 'libreta-teselas-v1';
const TILE_HOSTS = ['tile.openstreetmap.org', 'tile.opentopomap.org', 'server.arcgisonline.com', 'www.ign.es', 'tiles.macrostrat.org'];
const MAX_TILES = 6000;      // teselas con CORS (tamaño real)
const MAX_OPAQUE = 400;      // teselas sin CORS: el navegador las cuenta mucho más grandes

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

let puts = 0;
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
}
const opaqueKeys = [];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          if (res.type === 'opaque') {
            opaqueKeys.push(req.url);
            if (opaqueKeys.length > MAX_OPAQUE) cache.delete(opaqueKeys.shift());
          }
          cache.put(req, res.clone()).then(() => { if (++puts % 100 === 0) trim(cache); }).catch(() => {});
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (err) {
        if (req.mode === 'navigate') return caches.match('index.html');
        throw err;
      }
    })());
  }
});
