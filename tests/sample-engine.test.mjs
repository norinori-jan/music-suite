import test from "node:test";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
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


test("imported CC0 violin and cello WAV zones match every pinned manifest SHA-256", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "audio");
  for (const [id, expectedZones] of [
    ["meta-violin-section", 30],
    ["meta-cello-section", 26]
  ]) {
    const source = JSON.parse(await readFile(path.join(root, "assets", id, "SOURCE-MANIFEST.json"), "utf8"));
    const revision = JSON.parse(await readFile(path.join(root, "assets", id, "SOURCE-REVISION.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(root, id + ".manifest.json"), "utf8"));
    const instrument = manifest.instruments?.[id];
    assert.equal(source.license, "CC0-1.0");
    assert.equal(revision.license, "CC0-1.0");
    assert.equal(revision.sampleRate, 48000);
    assert.equal(revision.channels, 1);
    assert.equal(revision.bitsPerSample, 24);
    assert.equal(revision.zoneCount, expectedZones);
    assert.equal(instrument.samples.length, expectedZones);
    assert.equal(instrument.license, "CC0-1.0");
    const license = await readFile(path.join(root, "assets", id, "LICENSE"), "utf8");
    assert.match(license.slice(0, 500), /CC0 1\.0 Universal/);
    const sourceZones = new Map(source.zones.map(zone => [zone.file, zone]));
    for (const sample of instrument.samples) {
      const relative = sample.url.replace("../audio/assets/" + id + "/", "");
      const zone = sourceZones.get(relative);
      assert.ok(zone, "missing source manifest zone " + id + "/" + relative);
      const bytes = await readFile(path.join(root, "assets", id, relative));
      assert.equal(bytes.length, zone.sizeBytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), zone.sha256);
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
      const wavFormat = bytes.readUInt16LE(20);
      assert.ok(wavFormat === 1 || (wavFormat === 65534 && bytes.readUInt32LE(44) === 1), "must be PCM or WAVE_FORMAT_EXTENSIBLE PCM");
      if (wavFormat === 65534) assert.equal(bytes.readUInt16LE(38), 24, "extensible valid bits must be 24");
      assert.equal(bytes.readUInt16LE(22), 1, "must be mono");
      assert.equal(bytes.readUInt32LE(24), 48000, "must be 48 kHz");
      assert.equal(bytes.readUInt16LE(34), 24, "must be 24-bit");
    }
  }
});

test("round-robin sample groups rotate one recorded take per hit instead of layering every take", async () => {
  const context = makeContext();
  const network = fakeFetch();
  const kit = {
    instruments: {
      drums: {
        noteOffMode: "one-shot",
        samples: [1, 2, 3, 4].map(index => ({
          url: "/audio/drums/kick-rr" + index + ".wav",
          rootMidi: 36, keyLow: 36, keyHigh: 36,
          velocityLow: 1, velocityHigh: 127,
          roundRobinGroup: "kick-main", roundRobinIndex: index
        }))
      }
    }
  };
  const engine = createSampleAudioEngine({ audioContext: context, manifest: kit, fetchImpl: network.fetch });
  await engine.preload("drums", [{ midi: 36, velocity: 90 }]);
  const first = engine.scheduleNote({ instrument: "drums", midi: 36, velocity: 90, when: 10, gain: 0.5 });
  const second = engine.scheduleNote({ instrument: "drums", midi: 36, velocity: 90, when: 10.5, gain: 0.5 });
  const third = engine.scheduleNote({ instrument: "drums", midi: 36, velocity: 90, when: 11, gain: 0.5 });
  assert.deepEqual(first.sampleUrls, ["/audio/drums/kick-rr1.wav"]);
  assert.deepEqual(second.sampleUrls, ["/audio/drums/kick-rr2.wav"]);
  assert.deepEqual(third.sampleUrls, ["/audio/drums/kick-rr3.wav"]);
  assert.equal(network.calls.length, 4);
});

test("imported CC0 Swagbass and Big Rusty Drum WAV assets match pinned SHA-256 and PCM format", async (t) => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "audio");
  try { await access(path.join(root, "assets", "meta-swagbass", "SOURCE-MANIFEST.json")); }
  catch { t.skip("The separate verified asset-import workflow has not committed its files yet."); return; }
  for (const [id, minimumZones] of [["meta-swagbass", 48], ["meta-big-rusty-drums", 80]]) {
    const directory = path.join(root, "assets", id);
    const source = JSON.parse(await readFile(path.join(directory, "SOURCE-MANIFEST.json"), "utf8"));
    const revision = JSON.parse(await readFile(path.join(directory, "SOURCE-REVISION.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(root, id + ".manifest.json"), "utf8"));
    const instrument = manifest.instruments?.[id];
    assert.equal(source.license, "CC0-1.0");
    assert.equal(revision.license, "CC0-1.0");
    assert.equal(revision.sampleRate, 48000);
    assert.equal(revision.channels, 1);
    assert.equal(revision.bitsPerSample, 24);
    assert.equal(revision.sourceFilesSHA256Verified, true);
    assert.equal(revision.sourceGitBlobSHA1Verified, true);
    assert.equal(revision.convertedFilesSHA256Recorded, true);
    assert.ok(source.zones.length >= minimumZones);
    assert.equal(instrument.samples.length, source.zones.length);
    const license = await readFile(path.join(directory, "LICENSE"), "utf8");
    assert.match(license.slice(0, 500), /CC0 1\\.0 Universal/);
    const zones = new Map(source.zones.map(zone => [zone.file, zone]));
    const roundRobins = new Map();
    for (const sample of instrument.samples) {
      const relative = sample.url.replace("../audio/assets/" + id + "/", "");
      const zone = zones.get(relative);
      assert.ok(zone, "missing imported zone " + id + "/" + relative);
      const bytes = await readFile(path.join(directory, relative));
      assert.equal(bytes.length, zone.sizeBytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), zone.sha256);
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
      assert.equal(bytes.readUInt16LE(20), 1, "must be PCM");
      assert.equal(bytes.readUInt16LE(22), 1, "must be mono");
      assert.equal(bytes.readUInt32LE(24), 48000, "must be 48 kHz");
      assert.equal(bytes.readUInt16LE(34), 24, "must be 24-bit");
      if (sample.roundRobinGroup) {
        if (!roundRobins.has(sample.roundRobinGroup)) roundRobins.set(sample.roundRobinGroup, new Set());
        roundRobins.get(sample.roundRobinGroup).add(sample.roundRobinIndex);
      }
    }
    if (id === "meta-big-rusty-drums") {
      assert.ok(roundRobins.size > 0);
      assert.ok([...roundRobins.values()].every(indices => indices.size === 4), "each drum velocity zone must contain four round-robin takes");
    }
  }
});
