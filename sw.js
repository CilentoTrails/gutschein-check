// Speichert die großen Bibliotheken (OCR ~7 MB) nach dem ersten Laden,
// damit die App danach schnell startet. App-Dateien: zuerst Netz, dann Cache.
const CACHE = 'gc-v8';

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
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request)) || Response.error();
      }
    })
  );
});
