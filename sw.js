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
const CACHE = "pf-v60";

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

/* ---------------------------------------------------------------------------
 * Push notifications (migration 015)
 *
 * The subscription is registered by the page, which has the Supabase session;
 * the worker only renders what arrives and decides where a tap goes.
 * ------------------------------------------------------------------------- */

self.addEventListener("push", (event) => {
  // `userVisibleOnly: true` is a PROMISE to the browser that every push shows
  // a notification. Break it and Chrome posts its own "this site was updated
  // in the background" notice instead, which is worse than any fallback we
  // could write — so every path below ends in showNotification(), including
  // a push with no data at all or a body that isn't JSON.
  let data = {};
  if (event.data) {
    try {
      data = event.data.json() || {};
    } catch (e) {
      try {
        data = { body: event.data.text() };
      } catch (e2) {
        data = {};
      }
    }
  }

  const title = data.title || "Power Fund";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "A payment is waiting for your review.",
      icon: "/icons/icon-192.png",
      // No `badge`: Android wants a monochrome silhouette there and renders a
      // colour icon as a white blob. Better the platform's own dot than a
      // wrong asset.
      // NOTE FOR WHOEVER WRITES THE SENDER: the app has NO routing — no hash,
      // no history, one `currentView` that starts at "home". So a payload
      // setting `url` to something like "/#review" would reload the app at
      // Home and look broken. Deep-linking a notification to the review
      // screen means adding routing first; until then the only honest value
      // is "/", which is the default below.
      tag: data.tag || "pf-payment",
      // Same tag replaces the previous notice rather than stacking — but
      // renotify so a second payment still buzzes instead of silently
      // swapping the text under a notification already on screen.
      renotify: true,
      timestamp: Date.now(),
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      // Reuse a window that is already open — the treasurer tapping this
      // should land in the app they may already have running, not in a second
      // copy of it with its own session and its own unsaved sheet.
      const open = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const c of open) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(c.url).origin === self.location.origin;
        } catch (e) {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        await c.focus();
        if (url && url !== "/" && "navigate" in c) {
          try {
            await c.navigate(url);
          } catch (e) {
            /* focus already succeeded; the view just doesn't change */
          }
        }
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // A browser may rotate a subscription on its own. THE WORKER CANNOT RE-
  // REGISTER IT: recording a subscription is an authenticated write, and the
  // worker has no Supabase session. The page handles it instead, by comparing
  // the live endpoint against the one it last recorded — this only makes that
  // happen now rather than on the next load.
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      open.forEach((c) => c.postMessage("PUSH_RESUBSCRIBE"));
    })()
  );
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
