const CACHE_NAME = 'iskanner-public-1.4.2';
const PARTS_DATABASE_PATH = '/parts-database.js';
const PARTS_DATABASE_JSON_PATH = '/parts-database.json';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/auth.js',
  '/js/camera.js',
  '/js/config.js',
  '/js/ocr.js',
  '/js/ocr-selection.js',
  '/js/ocr-lookup.js',
  '/js/order-mode.js',
  '/js/search-v2.js',
  '/js/ui.js',
  '/js/utils.js',
  '/js/voice-lookup.js',
  '/js/voice.js',
  PARTS_DATABASE_PATH,
  PARTS_DATABASE_JSON_PATH,
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => key !== CACHE_NAME ? caches.delete(key) : undefined))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const accept = event.request.headers.get('accept') || '';
  const isNavigation = event.request.mode === 'navigate' || accept.includes('text/html');

  if (isNavigation) {
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put('/index.html', response.clone()));
      return response;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  if (url.pathname === PARTS_DATABASE_PATH || url.pathname === PARTS_DATABASE_JSON_PATH) {
    const networkRequest = new Request(event.request, { cache: 'no-store' });
    event.respondWith(fetch(networkRequest).then(response => {
      if (!response.ok) throw new Error(`Parts database request failed: ${response.status}`);
      return caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()).catch(() => undefined)).then(() => response);
    }).catch(async error => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw error;
    }));
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    return response;
  })));
});
