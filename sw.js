/* CampusFlow Service Worker — safe update flow.
   Rules it must keep, always:
   1. Only ever delete caches NAMED BY THIS APP (cf-shell-vN). Never touch other origin caches.
   2. Cache only successful, same-origin or CDN library responses. Never cache Firebase Auth,
      Realtime Database traffic, Identity Toolkit, the AI endpoint, anything with an
      Authorization header, or any URL whose query string carries a key.
   3. Critical entries (the page itself) must succeed or the new worker stays in waiting and the
      OLD version keeps serving. Everything else — the CDN libraries, the manifest, the icon and
      the whole offline reader in ./vendor — is cached best-effort with one retry: a flaky CDN or
      a dropped 3 MB download must never be able to block the app becoming installable offline.
      (This used to make the CDN scripts critical, so one unreachable URL meant no offline shell
      at all — not even the part that had already downloaded.)
   4. No skipWaiting/claim storm. The new worker waits deliberately; the page prompts for a
      controlled reload at a point that cannot interrupt unsaved work. */
const VERSION = "cf-shell-v46";
const CRITICAL = ["./", "./index.html", "./app.css", "./styles/shell.css", "./app.js"];
const OPTIONAL = ["./manifest.webmanifest", "./icon.svg"];
const LIBS = [
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-database-compat.js",
  "https://unpkg.com/@phosphor-icons/web@2.1.1"
];
/* The document reader and the libraries it drives live in ./vendor. They are
   cached best-effort: the reader is the one feature that has to work with no
   connection at all, but a 12 MB precache must never be able to block an app
   update, so a failure here is not fatal. */
const VENDOR = [
  "./vendor/scanner.js",
  "./vendor/attendance.js",
  "./vendor/find.js",
  "./vendor/assistant.js",
  "./vendor/xlsx.full.min.js",
  "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs",
  "./vendor/tesseract.min.js",
  "./vendor/tesseract-worker.min.js",
  "./vendor/tesseract-core-simd-lstm.wasm.js",
  "./vendor/tessdata/eng.traineddata.gz",
  "./vendor/tessdata/sin.traineddata.gz",
  "./vendor/tessdata/tam.traineddata.gz"
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
    /* cache.add() resolves with undefined (it is Promise<void>) and rejects on a
       non-2xx or failed fetch — so the status must be checked by catching, not by
       looking at a return value. The old `if (!res || res.status >= 400)` test was
       true for every URL, which threw on the first asset and meant this worker
       never once reached "installed": no offline shell, and the update prompt
       could never fire. */
    for (const url of CRITICAL) {
      try { await cache.add(url); }
      catch (error) { throw new Error("precache failed for " + url + " — " + (error && error.message)); }
    }
    const failures = [];
    const best = async url => {
      try { await cache.add(url); return; } catch (_) {}
      try { await cache.add(url + (url.includes("?") ? "&" : "?") + "retry=1"); }
      catch (_) { failures.push(url); }
    };
    for (const url of [...LIBS, ...OPTIONAL, ...VENDOR]) await best(url);
    if (failures.length) console.warn("cf-shell: not cached this time:", failures.join(", "));
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
