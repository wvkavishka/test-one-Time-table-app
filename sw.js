/* CampusFlow Service Worker — safe update flow.
   Rules it must keep, always:
   1. Only ever delete caches NAMED BY THIS APP (cf-shell-vN). Never touch other origin caches.
   2. Cache only successful, same-origin or CDN library responses. Never cache Firebase Auth,
      Realtime Database traffic, Identity Toolkit, the AI endpoint, anything with an
      Authorization header, or any URL whose query string carries a key.
   3. Critical entries (the page and the Firebase libraries) must succeed or the new worker
      stays in waiting and the OLD version keeps serving. Optional assets (manifest, icon) are
      cached best-effort so a missing icon can never block the update.
   4. No skipWaiting/claim storm. The new worker waits deliberately; the page prompts for a
      controlled reload at a point that cannot interrupt unsaved work. */
const VERSION = "cf-shell-v32";
const CRITICAL = ["./", "./index.html", "./app.css"];
const OPTIONAL = ["./manifest.webmanifest", "./icon.svg", "./icon"];
const LIBS = [
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js",
  "https://unpkg.com/@phosphor-icons/web@2.1.1"
];
const NEVER_CACHE = [
  "firebasedatabase.app", "firebaseio.com", "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com", "firebaseinstallations.googleapis.com",
  "generativelanguage.googleapis.com"
];
const APP_CACHE = name => name.startsWith("cf-shell-");
const hasKeyInQuery = url => /[?&](key|api_?key|token|access_token)=/i.test(url);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    for (const url of [...CRITICAL, ...LIBS]) {
      /* cache.add() resolves with undefined (it is Promise<void>) and rejects on a
         non-2xx or failed fetch — so the status must be checked by catching, not by
         looking at a return value. The old `if (!res || res.status >= 400)` test was
         true for every URL, which threw on the first asset and meant this worker
         never once reached "installed": no offline shell, and the update prompt
         could never fire. */
      try { await cache.add(url); }
      catch (error) { throw new Error("precache failed for " + url + " — " + (error && error.message)); }
    }
    for (const url of OPTIONAL) {
      try { await cache.add(url); } catch (_) { /* optional: missing file must not block install */ }
    }
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => APP_CACHE(k) && k !== VERSION)
      .map(k => caches.delete(k)));
    /* Do NOT clients.claim() — that takeover is what interrupted in-flight work. */
  })());
});

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const url = e.request.url;
  if (e.request.method !== "GET") return;
  if (NEVER_CACHE.some(b => url.includes(b))) return;
  if (hasKeyInQuery(url)) return;
  if (e.request.headers.get("authorization")) return;

  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(e.request);
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(VERSION);
          cache.put("./index.html", fresh.clone());
        }
        return fresh;
      } catch (_) {
        const cache = await caches.open(VERSION);
        return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    /* Exact match only: ignoreSearch could serve a response cached for a different query. */
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then(res => {
      if (res && res.status === 200 && (res.type === "basic" || res.type === "opaque")) {
        try { cache.put(e.request, res.clone()); } catch (_) {}
      }
      return res;
    }).catch(() => cached);
    return cached || fresh || Response.error();
  })());
});
