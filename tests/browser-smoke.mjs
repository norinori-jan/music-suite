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
  const consoleWarnings = [];
  const sampleFailures = [];
  const sampleHttpErrors = [];
  const sampleRequests = [];
  page.on("request", request => {
    if (/tonejs-instruments|salamander/i.test(request.url())) sampleRequests.push({ url: request.url(), method: request.method() });
  });
  page.on("requestfailed", request => {
    if (/tonejs-instruments|salamander|Tone\.js/i.test(request.url())) sampleFailures.push({ url: request.url(), error: request.failure()?.errorText });
  });
  page.on("response", response => {
    if (/tonejs-instruments|salamander/i.test(response.url()) && response.status() >= 400) sampleHttpErrors.push({ url: response.url(), status: response.status() });
  });
  page.on("pageerror", error => runtimeErrors.push(error.stack || error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning" && message.text().includes("[music-suite]")) consoleWarnings.push(message.text());
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

  const audioDiagnosticReport = await page.evaluate(async () => {
    const output = await runAudioOutputDiagnostic();
    const tone = await runToneEngineDiagnostic();
    const tracks = await runTrackAudioDiagnostic();
    return { output, tone, tracks, status: document.getElementById("audio-diagnostic-status")?.textContent || "" };
  });
  assert.equal(audioDiagnosticReport.output?.rawState, "running", "Web Audio output context must be running");
  assert.equal(audioDiagnosticReport.tone?.rawState, "running", "Tone.js context must be running");
  assert.deepEqual(audioDiagnosticReport.tracks, ["メロディ", "ピアノ", "ギター", "ベース", "ドラム"], "all five track diagnostics must be callable");
  await page.waitForTimeout(2300);
  const ensembleDiagnosticReport = await page.evaluate(async () => {
    const result = await runSimultaneousAudioDiagnostic();
    return { available: typeof runSimultaneousAudioDiagnostic === "function", meterAvailable: !!masterMeter, result };
  });
  assert.equal(ensembleDiagnosticReport.available, true, "five-track ensemble diagnostic must be available");
  assert.equal(ensembleDiagnosticReport.meterAvailable, true, "master output meter must be initialized");
  assert.deepEqual(ensembleDiagnosticReport.result?.tracks, ["メロディ", "ピアノ", "ギター", "ベース", "ドラム"], "ensemble diagnostic must schedule all five tracks");
  await page.waitForTimeout(5200);
  const audioStateAfterEnsemble = await page.evaluate(() => getAudioPlaybackDiagnostics());
  assert.equal(audioStateAfterEnsemble.meterMonitoring, false, "master meter monitor must stop after ensemble audition");

  const trackReport = await page.evaluate(() => {
    const arrangement = syncActiveArrangementTrackSnapshot();
    const tracks = arrangement?.tracks || {};
    const bassNotes = getPlayableBassNotes({ bass: tracks.bass }, APP.bars, APP.timeSig);
    const bassStarts = new Map();
    for (const note of bassNotes) {
      const key = Number(note.startBeat).toFixed(5);
      bassStarts.set(key, [...(bassStarts.get(key) || []), { id: note.id, pitch: note.pitch }]);
    }
    const duplicateBassStarts = [...bassStarts.entries()].filter(([, notes]) => notes.length > 1);
    return {
      melody: tracks.melody?.notes?.length || 0,
      piano: tracks.piano?.notes?.length || 0,
      guitar: tracks.guitar?.notes?.length || 0,
      bass: tracks.bass?.notes?.length || 0,
      drums: tracks.drums?.notes?.length || 0,
      bassNotes,
      duplicateBassStarts,
      bpm: document.getElementById("bpm-sl")?.value,
      imported: !!window.__compositionBaseProject
    };
  });
  assert.equal(trackReport.imported, true, "Composition Canvas project must reach BEAT//LAB");
  assert.deepEqual(trackReport.duplicateBassStarts, [], "monophonic bass must not schedule simultaneous attacks");
  for (const track of ["melody", "piano", "guitar", "bass", "drums"]) {
    assert.ok(trackReport[track] > 0, track + " track must contain playable notes; report=" + JSON.stringify(trackReport));
  }

  const playedVariants = [];
  for (const variant of ["A", "B", "C"]) {
    await page.locator("#drum-candidate-" + variant).click();
    await page.waitForFunction(expected => APP.activeDrumVariant === expected, variant, { timeout: 5000 });
    const variantTracks = await page.evaluate(() => {
      const tracks = syncActiveArrangementTrackSnapshot()?.tracks || {};
      return Object.fromEntries(["melody", "piano", "guitar", "bass", "drums"].map(name => [name, tracks[name]?.notes?.length || 0]));
    });
    for (const [name, count] of Object.entries(variantTracks)) assert.ok(count > 0, variant + " " + name + " track is empty");
    await page.locator("#play-btn").click();
    await page.waitForFunction(() => APP.playing === true, null, { timeout: 5000 });
    await page.waitForTimeout(700);
    await page.locator("#play-btn").click();
    await page.waitForFunction(() => APP.playing === false, null, { timeout: 5000 });
    playedVariants.push({ variant, tracks: variantTracks });
  }
  await page.locator("#guitar-volume").evaluate(el => { el.value = "55"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  const volumeCheck = await page.evaluate(() => ({ guitar: document.getElementById("guitar-volume").value, mixStatus: document.getElementById("arrangement-mix-status")?.textContent || "" }));
  assert.equal(volumeCheck.guitar, "55", "guitar volume fader must accept live input");
  await page.evaluate(() => { getPianoSampler(); getGuitarSampler(); getElectricGuitarSampler(); getBassSampler(); });
  await page.waitForTimeout(20000);
  const samplerStatus = await page.evaluate(() => ({
    piano: !!pianoSamplerReady,
    acousticGuitar: !!guitarSamplerReady,
    electricGuitar: !!electricGuitarSamplerReady,
    bass: !!bassSamplerReady
  }));

  assert.deepEqual(runtimeErrors, [], "Browser runtime errors detected:\n" + runtimeErrors.join("\n\n"));
  assert.deepEqual(consoleWarnings, [], "Instrument sampler initialization warnings detected:\n" + consoleWarnings.join("\n\n"));
  assert.deepEqual(sampleFailures, [], "Instrument sample requests failed:\n" + JSON.stringify(sampleFailures));
  assert.deepEqual(sampleHttpErrors, [], "Instrument samples returned HTTP errors:\n" + JSON.stringify(sampleHttpErrors));
  assert.deepEqual(samplerStatus, { piano: true, acousticGuitar: true, electricGuitar: true, bass: true }, "all four sample instruments must finish loading");
  console.log("BROWSER_SMOKE_OK " + JSON.stringify({ toneOnBeatLab, audioDiagnosticReport, ensembleDiagnosticReport, audioStateAfterEnsemble, trackReport, playedVariants, volumeCheck, samplerStatus, sampleRequests: sampleRequests.length, sampleFailures, sampleHttpErrors, runtimeErrors: runtimeErrors.length, consoleErrors, consoleWarnings }));
} finally {
  if (browser) await browser.close();
  if (serverListening) await new Promise(resolve => server.close(resolve));
}
