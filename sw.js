// Speichert die großen Bibliotheken (OCR ~7 MB) nach dem ersten Laden,
// damit die App danach schnell startet. App-Dateien: immer frisch vom Netz (Cache nur offline).
const CACHE = 'gc-v27';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const vendor = url.pathname.includes('/vendor/');
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      if (vendor) {
        const hit = await cache.match(e.request);
        if (hit) return hit;
      }
      try {
        // App-Dateien immer beim Server nachfragen (no-cache = mit ETag prüfen, sonst kurz 304).
        // Sonst mischt der Browser-Cache (GitHub Pages: bis 10 Minuten) alte und neue Dateien.
        const res = vendor ? await fetch(e.request) : await fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' }));
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request)) || Response.error();
      }
    })
  );
});
