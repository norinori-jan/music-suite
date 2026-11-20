import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const enginePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "audio", "sample-engine.js");
const { createSampleAudioEngine, chooseSample, chooseSampleLayers, validateManifest } = require(enginePath);

function makeContext() {
  const sources = [];
  const context = {
    currentTime: 10,
    destination: { id: "destination" },
    async decodeAudioData(bytes) {
      return { length: bytes.byteLength / 4, numberOfChannels: 1, duration: 1 };
    },
    createBufferSource() {
      const source = {
        playbackRate: { setValueAtTime(value) { source.rate = value; } },
        connect(target) { source.target = target; },
        disconnect() {},
        start(when) { source.startedAt = when; },
        stop(when) { source.stoppedAt = when; },
        onended: null
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const events = [];
      return {
        gain: {
          value: 1,
          setValueAtTime(...args) { events.push(["set", ...args]); },
          linearRampToValueAtTime(...args) { events.push(["linear", ...args]); },
          cancelScheduledValues(...args) { events.push(["cancel", ...args]); }
        },
        connect(target) { this.target = target; },
        disconnect() {},
        events
      };
    },
    sources
  };
  return context;
}

const manifest = {
  instruments: {
    piano: {
      attack: 0.006,
      release: 0.2,
      samples: [
        { url: "/audio/piano-c4-soft.ogg", rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 1, velocityHigh: 63 },
        { url: "/audio/piano-c4-hard.ogg", rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 64, velocityHigh: 127 }
      ]
    }
  }
};

function fakeFetch() {
  const calls = [];
  return {
    calls,
    async fetch(url) {
      calls.push(url);
      await Promise.resolve();
      return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(400); } };
    }
  };
}

test("sample selection honors note range and velocity layers", () => {
  assert.equal(chooseSample(manifest.instruments.piano.samples, 60, 30).url, "/audio/piano-c4-soft.ogg");
  assert.equal(chooseSample(manifest.instruments.piano.samples, 60, 100).url, "/audio/piano-c4-hard.ogg");
  assert.equal(chooseSample(manifest.instruments.piano.samples, 63, 100), null);
});


test("velocity transitions crossfade adjacent recorded layers without a hard step", () => {
  const layers = [
    { url: "soft", rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 1, velocityHigh: 39, xfoutLovel: 24, xfoutHivel: 39 },
    { url: "medium", rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 24, velocityHigh: 71, xfinLovel: 24, xfinHivel: 39, xfoutLovel: 56, xfoutHivel: 71 },
    { url: "loud", rootMidi: 60, keyLow: 60, keyHigh: 60, velocityLow: 56, velocityHigh: 127, xfinLovel: 56, xfinHivel: 71 }
  ];
  const selected = chooseSampleLayers(layers, 60, 31.5);
  assert.equal(selected.length, 2);
  const power = selected.reduce((sum, item) => sum + item.weight * item.weight, 0);
  assert.ok(Math.abs(power - 1) < 1e-9);
});

test("nylon guitar selects the lowest practical string for first-position fingering", () => {
  const samples = [
    { url: "low-e", string: "LowE", rootMidi: 48, keyLow: 48, keyHigh: 48, velocityLow: 1, velocityHigh: 127, swLast: 24 },
    { url: "a", string: "A", rootMidi: 48, keyLow: 48, keyHigh: 48, velocityLow: 1, velocityHigh: 127, swLast: 24 },
    { url: "d", string: "D", rootMidi: 48, keyLow: 48, keyHigh: 48, velocityLow: 1, velocityHigh: 127, swLast: 24 }
  ];
  const selected = chooseSample(samples, 48, 80, { stringSelection: "guitar-first-position", techniqueSelection: "auto" });
  assert.equal(selected.url, "a");
});

test("manifest rejects invalid sample ranges", () => {
  assert.throws(() => validateManifest({ instruments: { bad: { samples: [{ url: "/x", rootMidi: 60, keyLow: 70, keyHigh: 60, velocityLow: 1, velocityHigh: 127 }] } } }), /Invalid sample mapping/);
});

test("preload deduplicates concurrent requests and decodes once", async () => {
  const context = makeContext();
  const network = fakeFetch();
  const engine = createSampleAudioEngine({ audioContext: context, manifest, fetchImpl: network.fetch });
  const results = await Promise.all([
    engine.preload("piano", [{ midi: 60, velocity: 30 }]),
    engine.preload("piano", [{ midi: 60, velocity: 30 }])
  ]);
  assert.equal(network.calls.length, 1);
  assert.equal(results[0].loaded, 1);
  assert.equal(engine.getStats().cachedSamples, 1);
  assert.equal(engine.getStats().decodedBytes, 400);
});

test("scheduleNote uses the selected real sample, transposes from its root and schedules on the shared clock", async () => {
  const context = makeContext();
  const network = fakeFetch();
  const transpositionManifest = structuredClone(manifest);
  transpositionManifest.instruments.piano.samples.forEach(sample => { sample.keyHigh = 62; });
  const transpositionEngine = createSampleAudioEngine({ audioContext: context, manifest: transpositionManifest, fetchImpl: network.fetch });
  await transpositionEngine.preload("piano", [{ midi: 62, velocity: 100 }]);
  const voice = transpositionEngine.scheduleNote({ instrument: "piano", midi: 62, velocity: 100, when: 10.5, duration: 0.75, gain: 0.4 });
  assert.equal(voice.sampleUrl, "/audio/piano-c4-hard.ogg");
  assert.equal(context.sources[0].startedAt, 10.5);
  assert.ok(Math.abs(context.sources[0].rate - Math.pow(2, 2 / 12)) < 1e-9);
  assert.equal(transpositionEngine.getStats().activeVoices, 1);
  voice.stop(11);
  assert.equal(context.sources[0].stoppedAt, 11.02);
});

test("missing samples and disposed engines fail explicitly rather than silently synthesizing", async () => {
  const context = makeContext();
  const network = fakeFetch();
  const engine = createSampleAudioEngine({ audioContext: context, manifest, fetchImpl: network.fetch });
  assert.throws(() => engine.scheduleNote({ instrument: "piano", midi: 60 }), /not loaded/);
  engine.dispose();
  await assert.rejects(() => engine.preload("piano", [60]), /disposed/);
});


test("imported CC0 piano and nylon guitar assets match every upstream SHA-256", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "audio");
  for (const [id, expectedSamples, expectedRegions] of [
    ["meta-piano", 352, 352],
    ["meta-nylon-guitar", 348, 960]
  ]) {
    const manifest = JSON.parse(await readFile(path.join(root, id + ".manifest.json"), "utf8"));
    const instrument = manifest.instruments?.[id];
    assert.ok(instrument, id + " manifest is missing");
    assert.equal(instrument.license, "CC0-1.0");
    assert.equal(instrument.samples.length, expectedRegions);
    const license = await readFile(path.join(root, "assets", id, "LICENSE"), "utf8");
    assert.match(license.slice(0, 500), /CC0 1\.0 Universal/);
    const sumsText = await readFile(path.join(root, "assets", id, "SOURCE-SHA256SUMS"), "utf8");
    const sums = new Map([...sumsText.matchAll(/^([a-f0-9]{64})\s+\*?(.+)$/gim)].map(match => [match[2].trim(), match[1].toLowerCase()]));
    const files = new Set(instrument.samples.map(sample => sample.url.replace("../audio/assets/" + id + "/", "")));
    assert.equal(files.size, expectedSamples);
    for (const relative of files) {
      const expected = sums.get(relative);
      assert.ok(expected, "missing upstream checksum for " + id + "/" + relative);
      const bytes = await readFile(path.join(root, "assets", id, relative));
      const actual = createHash("sha256").update(bytes).digest("hex");
      assert.equal(actual, expected, "SHA-256 mismatch for " + id + "/" + relative);
    }
  }
});
