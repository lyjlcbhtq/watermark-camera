// 简单水印相机 - Service Worker
// 使用 Network First 策略，确保始终加载最新版本
self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        return response;
      })
      .catch(function() {
        return new Response('Offline', { status: 503 });
      })
  );
});
