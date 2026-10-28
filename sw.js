// Bump this version whenever an app-shell file changes.
// CacheStorage is shared by every app on an origin, including separate Pages paths.
const CACHE_PREFIX = 'watermark-camera-shell-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE_NAME = CACHE_PREFIX + 'v6';
const APP_SHELL = ['index.html', 'media-store.js', 'location-service.js', 'evidence.js', 'evidence-worker.js', 'verify.html', 'verify.js', 'vendor/noble-hashes/sha2.js', 'vendor/noble-hashes/_md.js', 'vendor/noble-hashes/_u64.js', 'vendor/noble-hashes/utils.js', 'manifest.json', 'icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const shellURL = name => new URL(name, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // addAll commits the complete shell together; a missing asset aborts installation.
      await cache.addAll(APP_SHELL.map(name => new Request(shellURL(name), { cache: 'reload' })));
    } catch (error) {
      // Failed installations must leave the working version and its cache intact.
      try { await caches.delete(CACHE_NAME); } catch (_) { /* Storage may be unavailable. */ }
      throw error;
    }
    // Let existing windows keep their worker until they close. Forcing activation can
    // serve new JavaScript to an old page, or delete files that an old worker still needs.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      // Legacy unscoped caches may still be used by installations at other paths.
      await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    } catch (_) { /* Cleanup is best effort; cached launches must remain available. */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // Only the app shell is cached. Location services remain network requests.
  const navigation = event.request.mode === 'navigate' &&
    (url.pathname === scope.pathname || url.pathname === new URL('index.html', scope).pathname);
  const asset = APP_SHELL.find(name => new URL(name, scope).pathname === url.pathname);
  if (!navigation && !asset) return;
  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(shellURL(navigation ? 'index.html' : asset));
      if (cached) return cached;
    } catch (_) { /* A storage failure must not prevent an online launch. */ }
    return fetch(event.request);
  })());
});
