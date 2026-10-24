// Template: build.mjs substitutes __BUILD_HASH__ and the precache list and writes dist/sw.js. Do not serve this file as is.
// Scope is the folder sw.js is served from, so the root build and /next/ install independent workers.
const HASH = '__BUILD_HASH__';
const PRECACHE = "__PRECACHE__";
const PREFIX = `iron-dominion:${new URL(self.registration.scope).pathname}:`;
const CACHE = PREFIX + HASH;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

// A new worker waits until the page asks it to take over, so a running game is never swapped out from under the player.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) await (await caches.open(CACHE)).put('./', res.clone());
        return res;
      } catch {
        return (await caches.match('./', { cacheName: CACHE })) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = (await caches.match(req, { cacheName: CACHE })) || (await caches.match(req, { cacheName: CACHE, ignoreSearch: true }));
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
