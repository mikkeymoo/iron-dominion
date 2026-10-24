// Template: build.mjs substitutes __BUILD_HASH__ and the precache list and writes dist/sw.js. Do not serve this file as is.
// Scope is the folder sw.js is served from, so the root build and /next/ install independent workers.
const HASH = "2192bb5f627d";
const PRECACHE = ["./","./app.css","./app.js","./icon.svg","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./manifest.webmanifest","./sim-worker.js?v=2192bb5f627d"];
const SCOPE = new URL(self.registration.scope).pathname;
const PREFIX = `iron-dominion:${SCOPE}:`;
const CACHE = PREFIX + HASH;
const NAV_TIMEOUT_MS = 3500;

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
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (req.mode === 'navigate') {
    // Only this scope's own shell is served from and stored in this cache: a nested scope (/next/) must never overwrite it.
    if (url.pathname !== SCOPE && url.pathname !== SCOPE + 'index.html') return;
    event.respondWith((async () => {
      const network = fetch(req).then(async (res) => {
        if (res.ok) {
          const copy = res.clone();
          await (await caches.open(CACHE)).put('./', copy);
        }
        return res;
      });
      event.waitUntil(network.catch(() => undefined));
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS); });
      let res = null;
      try { res = await Promise.race([network, timeout]); } catch { res = null; }
      clearTimeout(timer);
      if (res) return res;
      const hit = await caches.match('./', { cacheName: CACHE });
      if (hit) return hit;
      try { return await network; } catch { return Response.error(); }
    })());
    return;
  }
  event.respondWith((async () => {
    // The sim worker must match the app that asks for it: an exact URL hit, or a failure, never another build's worker.
    const isWorker = url.pathname === SCOPE + 'sim-worker.js';
    const hit = (await caches.match(req, { cacheName: CACHE })) || (!isWorker && (await caches.match(req, { cacheName: CACHE, ignoreSearch: true })));
    if (hit) return hit;
    if (isWorker) return Response.error();
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
