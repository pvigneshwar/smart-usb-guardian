const CACHE = "smart-usb-guardian-performance-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/three-d.css",
  "/config.js",
  "/app.js",
  "/experience.js",
  "/assets/logo.svg",
  "/assets/apple-touch-icon.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(
        APP_SHELL.map((asset) => cache.add(new Request(asset, { cache: "reload" }))),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Do not proxy API calls or large downloads through the service worker.
  // Native browser streaming is more reliable for APK, EXE and ZIP files,
  // especially on Android and low-memory Windows systems.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/downloads/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () =>
          (await caches.match("/index.html")) ||
          new Response("Smart USB Guardian is temporarily offline.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        ),
    );
    return;
  }

  // Stale-while-revalidate for small static assets. The cached asset appears
  // immediately while the newest deployed copy is refreshed in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/#logs";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing) {
        existing.navigate(targetUrl).catch(() => {});
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
