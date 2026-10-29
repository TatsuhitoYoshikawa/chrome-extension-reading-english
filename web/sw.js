'use strict';

// オフラインでも読めるようにするための Service Worker。
// 通信できるときは常に最新を取りに行き（network first）、取れなければ保存済みの物を使う。
const CACHE = 'bilingual-reader-v2';
const PRECACHE = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png',
  'texts/index.json', 'texts/common.json', 'texts/lemmas.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
