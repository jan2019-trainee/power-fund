/* ---------------------------------------------------------------------------
 * Power Fund — service worker
 *
 * Scope: the whole site (served from the repo root on Vercel).
 *
 * Design rules (see the PWA plan):
 *   1. Supabase is NEVER intercepted. Every REST / Storage / Realtime request
 *      goes straight to the network. No financial or member data is ever put in
 *      the cache. Offline is not a valid operating mode for fund operations.
 *   2. The app shell (HTML, CSS, JS, the vendored Supabase SDK) is network-first:
 *      an online reload always runs the latest deployed code; the cached copy is
 *      only a fallback for when the network is unreachable.
 *   3. Fonts / icons are cache-first (immutable, content-stable assets).
 *   4. No offline queue, no background sync. Offline == read-only shell that
 *      tells the user to reconnect.
 *
 * Update flow: bump CACHE on every deploy. `install` pre-caches the shell and
 * calls skipWaiting(); `activate` deletes old caches and claims clients, which
 * fires `controllerchange` in the page — js/pwa.js then shows a non-blocking
 * "New version — Reload" prompt. The worker never reloads the page itself.
 * ------------------------------------------------------------------------- */

/* Bump this string on every deploy that should invalidate the shell cache. */
const CACHE = "pf-v37";

const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/css/style.css",
  "/js/config.js",
  "/js/calculations.js",
  "/js/database.js",
  "/js/views/home.js",
  "/js/views/rounds.js",
  "/js/views/members.js",
  "/js/views/menu.js",
  "/js/app.js",
  "/js/pwa.js",
  "/js/vendor/supabase-2.45.4.min.js",
  "/assets/gcash-qr.jpg",
  "/assets/fonts/inter-latin.woff2",
  "/assets/fonts/inter-latin-ext.woff2",
  "/assets/fonts/space-grotesk-latin.woff2",
  "/assets/fonts/space-grotesk-latin-ext.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png",
  "/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Tolerant precache: fetch + put each asset on its own so one failure
      // (or a flaky connection) can't stop the worker from installing.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res && res.ok) await cache.put(url, res.clone());
            else console.warn("[sw] precache bad status", res && res.status, url);
          } catch (err) {
            console.warn("[sw] precache skipped:", url, String(err));
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* Let the page hurry a waiting worker along (used by the "Reload" prompt). */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GET is ever served from cache; everything else is passed through.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // (1) NEVER touch Supabase — REST, Storage, Auth, Realtime. Fund and member
  //     data must always come from the live backend, never from a cache, and
  //     there is deliberately no offline fallback for it.
  if (url.hostname === "supabase.co" || url.hostname.endsWith(".supabase.co")) {
    return; // browser handles it; SW stays out of the way
  }

  // (2) Ignore anything that isn't our own origin (no third-party caching).
  if (url.origin !== self.location.origin) return;

  // (3) Immutable assets: cache-first.
  if (
    url.pathname.startsWith("/assets/fonts/") ||
    url.pathname.startsWith("/icons/") ||
    req.destination === "font"
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // (4) App shell (navigations, scripts, styles, the vendored SDK): network-first.
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return hit || Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Only cache clean same-origin 200s.
    if (res && res.ok && res.type === "basic") {
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // Offline with nothing cached: for a navigation, hand back the app shell so
    // the PWA still opens (it renders its own "offline — reconnect" state).
    if (req.mode === "navigate") {
      const shell =
        (await cache.match("/index.html")) || (await cache.match("/"));
      if (shell) return shell;
    }
    return Response.error();
  }
}
