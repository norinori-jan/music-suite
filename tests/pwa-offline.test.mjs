import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("music-suite declares an installable standalone web app", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.webmanifest"), "utf8"));
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /navigator\.serviceWorker\.register\("\.\/sw\.js"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon" href="\.\/icon-512\.png"/);
  assert.equal(manifest.name, "music-suite");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.some(icon => icon.src === "./icon.svg"));
});

test("service worker caches the app shell and only audio samples requested at runtime", async () => {
  const sw = await readFile(path.join(root, "sw.js"), "utf8");
  assert.match(sw, /cache\.addAll\(SHELL_URLS\)/);
  assert.match(sw, /url\.pathname\.includes\("\/audio\/assets\/"\)/);
  assert.match(sw, /cacheAudioRequest\(request\)/);
  assert.match(sw, /cache\.put\(request, response\.clone\(\)\)/);
  assert.match(sw, /networkFirst\(request, AUDIO_CACHE\)/);
  assert.doesNotMatch(sw, /audio\/assets\/\*\*/);
  assert.match(sw, /name\.startsWith\("music-suite-"\)/);
});
