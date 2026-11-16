const CACHE_NAME = 'soulstrike-pwa-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

const OFFLINE_FALLBACK = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SoulStrike Arena — Offline</title>
  <style>
    body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#162032; color:#f8fafc; font-family:system-ui,sans-serif; padding:24px; text-align:center; }
    .card { background:#fffdf6; color:#0f172a; border:3px solid #090e17; border-radius:16px; padding:24px; max-width:360px; box-shadow:0 6px 0 #cbd5e1; }
    h1 { font-size:22px; margin:0 0 8px; }
    p { font-size:14px; color:#475569; margin:0 0 16px; }
    button { background:#0ea5e9; color:#fff; border:2px solid #0369a1; border-radius:10px; padding:10px 18px; font-weight:800; cursor:pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're Offline</h1>
    <p>SoulStrike Arena needs a connection to reach the live match server.</p>
    <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/ws' || url.pathname === '/health') return;

  // Network-first for HTML navigations so fresh hashed bundles are always picked up
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = (await caches.match('/')) || (await caches.match('/index.html'));
          return cached || new Response(OFFLINE_FALLBACK, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        })
    );
    return;
  }

  // Cache-first for content-hashed Vite assets
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Stale-while-revalidate for icons, manifest, and static files
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
