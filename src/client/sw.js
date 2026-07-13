/* CursorRemote PWA — enables “Install app”; always prefer network. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Required for installability; pass through to network.
  event.respondWith(fetch(event.request));
});
