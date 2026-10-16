// Caches the app shell + remembers poster images. API and stream requests always go to the network.
const CACHE = 'syncanime-shell-v10';
const IMG = 'syncanime-img-v1';
const IMG_MAX = 200;
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.json', '/icon-192.png', '/hero-bg.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimImages(cache) {
  const keys = await cache.keys();
  if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)));
}
// Posters: show the saved copy instantly, refresh it in the background.
async function posterRequest(req) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).then(() => trimImages(cache));
      return res;
    })
    .catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(posterRequest(e.request));
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network-first so updates show up, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.pathname.startsWith('/anime/')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
