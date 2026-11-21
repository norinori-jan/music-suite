import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    const target = path.resolve(root, "." + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not Found");
  }
});

let browser;
let serverListening = false;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4173, "127.0.0.1", resolve);
  });
  serverListening = true;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const runtimeErrors = [];
  const consoleErrors = [];
  page.on("pageerror", error => runtimeErrors.push(error.stack || error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:4173/apps/composition-canvas.html", { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(url => url.pathname.endsWith("/apps/beat-lab.html") && url.hash.includes("import="), { timeout: 15000 }),
    page.locator('button[onclick="openStandardTestSongInBeatLab()"]').click()
  ]);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => typeof window.Tone === "function" || (window.Tone && typeof window.Tone.start === "function"), null, { timeout: 20000 });
  const toneOnBeatLab = await page.evaluate(() => typeof window.Tone !== "undefined");
  assert.equal(toneOnBeatLab, true, "Tone.js must load on BEAT//LAB");
  await page.waitForFunction(() => document.getElementById("test-route-intro")?.textContent.includes("標準テスト曲を受信"), null, { timeout: 10000 });

  const trackReport = await page.evaluate(() => {
    const tracks = APP.arrangements?.[APP.activeDrumVariant || "A"]?.tracks || APP.arrangements?.A?.tracks || {};
    return {
      melody: tracks.melody?.notes?.length || 0,
      piano: tracks.piano?.notes?.length || 0,
      guitar: tracks.guitar?.notes?.length || 0,
      bass: tracks.bass?.notes?.length || 0,
      drums: tracks.drums?.notes?.length || 0,
      bpm: document.getElementById("bpm-sl")?.value,
      imported: !!window.__compositionBaseProject
    };
  });
  assert.equal(trackReport.imported, true, "Composition Canvas project must reach BEAT//LAB");
  for (const track of ["melody", "piano", "guitar", "bass", "drums"]) {
    assert.ok(trackReport[track] > 0, track + " track must contain playable notes; report=" + JSON.stringify(trackReport));
  }

  await page.locator("#play-btn").click();
  await page.waitForFunction(() => APP.playing === true, null, { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.locator("#play-btn").click();
  await page.waitForFunction(() => APP.playing === false, null, { timeout: 5000 });

  assert.deepEqual(runtimeErrors, [], "Browser runtime errors detected:\n" + runtimeErrors.join("\n\n"));
  console.log("BROWSER_SMOKE_OK " + JSON.stringify({ toneOnBeatLab, trackReport, playbackStartedAndStopped: true, runtimeErrors: runtimeErrors.length, consoleErrors }));
} finally {
  if (browser) await browser.close();
  if (serverListening) await new Promise(resolve => server.close(resolve));
}
