/**
 * Orange Downloader - Service Worker
 *
 * 缓存策略:
 *   - 导航请求 (HTML)        : network-first（拿不到走离线 index.html）
 *   - 静态资源 (JS/CSS/IMG)  : stale-while-revalidate（首屏快、后台更新）
 *   - /api/ 与 /download/    : 完全 bypass（不缓存、不拦截）
 *   - 非 GET / 跨源请求       : 不拦截，让浏览器原生处理
 */

const VERSION = 'v3-2026-04';
const STATIC_CACHE = 'orange-static-' + VERSION;
const RUNTIME_CACHE = 'orange-runtime-' + VERSION;
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => { /* 单条失败不阻断安装 */ }))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) { /* noop */ }
    }
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function shouldBypass(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/api/')) return true;
  if (url.pathname.startsWith('/download/')) return true;
  if (url.pathname.startsWith('/sw.js')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (shouldBypass(request, url)) return;

  // 导航请求：network-first + 离线兜底
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        const fresh = await fetch(request);
        return fresh;
      } catch (_) {
        const cached = await caches.match('/index.html');
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 其他静态资源：stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const fetchPromise = fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).catch(() => { /* quota errors */ });
        }
        return response;
      })
      .catch(() => cached);
    return cached || fetchPromise;
  })());
});
