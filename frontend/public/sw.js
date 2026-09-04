/* Service worker: app-shell caching for instant repeat loads, plus Web Push.
 *
 * The caching split is the whole safety story:
 *   - /api/*            NEVER cached. This is a live-quotes terminal; a stale
 *                       price served as fresh is worse than a slow one. These
 *                       always go to the network, untouched.
 *   - /_next/static/*,  cache-first. Build assets have content-hashed names, so
 *     icons, manifest   a cached copy can never be the "wrong" version — a new
 *                       build ships new URLs. This is what makes the second
 *                       visit paint instantly.
 *   - navigations       network-first with a cached-shell fallback, so online
 *                       is always current and offline shows the app instead of
 *                       the browser's dinosaur.
 *
 * Bump CACHE_VERSION to invalidate everything on the next activation.
 */
const CACHE_VERSION = "mb-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

self.addEventListener("install", (event) => {
  // Take over as soon as installed rather than waiting for every old tab to
  // close — pair with clients.claim() below.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) =>
      c.addAll(["/manifest.json", "/icon-192.png", "/icon-512.png"]).catch(() => {})),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => !k.startsWith(CACHE_VERSION))
        .map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/")
    || url.pathname === "/manifest.json"
    || /\.(?:png|svg|ico|woff2?|ttf|css|js)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;                      // never touch writes

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;           // let cross-origin pass
  if (url.pathname.startsWith("/api/")) return;              // live data — network only

  // Immutable, content-hashed assets: serve from cache, populate on first miss.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) =>
        hit || fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
      ),
    );
    return;
  }

  // Page navigations: network-first (always current when online), fall back to
  // the last good shell — or a minimal inline page — when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(request)
            .then((hit) => hit || caches.match("/"))
            .then((hit) => hit || new Response(
              "<!doctype html><meta charset=utf-8><meta name=viewport "
              + "content='width=device-width,initial-scale=1'>"
              + "<style>body{background:#070809;color:#9aa0aa;font:14px system-ui;"
              + "display:grid;place-items:center;height:100vh;margin:0;text-align:center}"
              + "b{color:#ffb000}</style><div><b>Motherboard</b><br>"
              + "You're offline. Reconnect and this page will load.</div>",
              { headers: { "Content-Type": "text/html; charset=utf-8" } })),
        ),
    );
  }
});

// ── Web Push (unchanged) ───────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "Motherboard Terminal", body: "Alert triggered", url: "/alerts" };
  try {
    data = { ...data, ...event.data.json() };
  } catch (e) { /* non-JSON payload — use defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/alerts";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    }),
  );
});
