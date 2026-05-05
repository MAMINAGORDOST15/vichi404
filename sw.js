const CACHE = 'vichi404-v1';
const ASSETS = ['/', '/index.html', '/images/photo-about.jpg', '/images/photo-insta.jpg', '/images/inklab-screen.jpg', '/images/vichi404-screen.png', '/images/thumb-1.jpg', '/images/thumb-2.jpg', '/images/thumb-3.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
