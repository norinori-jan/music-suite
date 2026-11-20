const SHELL_CACHE = "music-suite-shell-v1";
const AUDIO_CACHE = "music-suite-audio-v1";
const SHELL_URLS = [
  "./",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-512.png",
  "./apps/composition-canvas.html",
  "./audio/sample-engine.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith("music-suite-") && name !== SHELL_CACHE && name !== AUDIO_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheAudioRequest(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    try { await cache.put(request, response.clone()); }
    catch (error) { console.warn("Audio sample cache quota/write failure", error); }
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      try { await cache.put(request, response.clone()); }
      catch (error) { console.warn("App shell cache write failure", error); }
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes("/audio/assets/")) {
    event.respondWith(cacheAudioRequest(request));
    return;
  }
  if (/\/audio\/meta-[^/]+\.manifest\.json$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, AUDIO_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});
