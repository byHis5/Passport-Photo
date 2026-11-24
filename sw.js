// Service worker:
//  1. Offline support - big, versioned files (models, libraries) are cached after the first visit;
//     the app's own pages/scripts are fetched fresh when online so updates show up, cache used offline.
//  2. Adds cross-origin-isolation headers so the browser allows multi-threaded processing
//     (GitHub Pages and similar static hosts can't set these headers themselves).
const CACHE = "ppg-v1";
const HEAVY = /\/(vendor|models)\//;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));

function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (HEAVY.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return isolate(res);
    }));
  } else {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return isolate(res);
    }).catch(() => caches.match(req).then(isolate)));
  }
});
