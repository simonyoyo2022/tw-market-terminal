// service-worker.js
//
// Network-first everywhere: always try to fetch the latest version from
// GitHub Pages first, and only fall back to the cached copy if the network
// request fails (offline). This trades a tiny bit of speed for always
// showing your latest deploy — with cache-first, updated app.js/index.html
// could get stuck showing an old cached version for a long time.
//
// Bump CACHE_VERSION any time you want to force clients to drop old caches.
const CACHE_VERSION = "tif-v8";
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "config.js",
  "manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (FinMind live lookups) pass straight through
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "reload" })
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
