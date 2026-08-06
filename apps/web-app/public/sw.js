const CACHE_NAME = "notemarkdown-shell-v3";
const BASE_PATH = new URL("./", self.location.href).pathname;
const CORE_ASSETS = [BASE_PATH, `${BASE_PATH}manifest.webmanifest`, `${BASE_PATH}notemarkdown_renderer.wasm`, `${BASE_PATH}icons/icon-192.png`, `${BASE_PATH}icons/icon-512.png`];

/** Caches the current versioned Vite shell, including hashed entry assets. @returns Nothing after the shell is cached. */
async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(CORE_ASSETS);
  const response = await fetch(BASE_PATH, { cache: "no-store" });
  const html = await response.text();
  const urls = Array.from(html.matchAll(/(?:src|href)="([^"#]+)"/g), (match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith(BASE_PATH))
    .map((url) => url.pathname);
  await Promise.allSettled(urls.map((url) => cache.add(url)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith(BASE_PATH)) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(BASE_PATH, copy));
      return response;
    }).catch(() => caches.match(BASE_PATH).then((response) => response || Response.error())));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
