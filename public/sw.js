/* Atlas de Bolso — service worker
   Rede primeiro para o app (você sempre recebe a versão nova quando há internet),
   cópia guardada quando está offline. A API nunca passa pelo cache. */
const CACHE = "atlas-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];
const CDN = ["https://cdnjs.cloudflare.com/", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) return;            // IA e câmbio: sempre na rede
    e.respondWith(networkFirst(req));
  } else if (CDN.some(p => req.url.startsWith(p))) {
    e.respondWith(cacheFirst(req));                          // Leaflet e fontes
  }
});
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (req.mode === "navigate" ? cache.match("/") : Response.error());
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
