(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SampleAudioEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function guitarStringForFirstPosition(midi) {
    if (midi >= 64) return "HighE";
    const strings = [
      ["LowE", 40], ["A", 45], ["D", 50], ["G", 55], ["B", 59]
    ];
    const match = strings.find(([, openMidi]) => midi >= openMidi && midi - openMidi <= 4);
    return match ? match[0] : null;
  }

  function velocityLayerWeight(sample, velocity) {
    let weight = 1;
    if (Number.isFinite(sample.xfinLovel) && Number.isFinite(sample.xfinHivel) &&
        velocity >= sample.xfinLovel && velocity <= sample.xfinHivel) {
      const span = Math.max(1, sample.xfinHivel - sample.xfinLovel);
      const position = clamp((velocity - sample.xfinLovel) / span, 0, 1);
      weight *= Math.sin(position * Math.PI / 2);
    }
    if (Number.isFinite(sample.xfoutLovel) && Number.isFinite(sample.xfoutHivel) &&
        velocity >= sample.xfoutLovel && velocity <= sample.xfoutHivel) {
      const span = Math.max(1, sample.xfoutHivel - sample.xfoutLovel);
      const position = clamp((velocity - sample.xfoutLovel) / span, 0, 1);
      weight *= Math.cos(position * Math.PI / 2);
    }
    return weight;
  }

  function chooseSampleLayers(samples, midi, velocity, instrument) {
    const options = instrument || {};
    let candidates = samples.filter(sample =>
      midi >= sample.keyLow && midi <= sample.keyHigh &&
      velocity >= sample.velocityLow && velocity <= sample.velocityHigh
    );
    if (options.stringSelection === "guitar-first-position") {
      const string = guitarStringForFirstPosition(midi);
      if (!string) return [];
      candidates = candidates.filter(sample => sample.string === string);
    }
    return candidates.map(sample => ({
      sample,
      weight: velocityLayerWeight(sample, velocity)
    })).filter(item => item.weight > 0.0001);
  }

  function chooseSample(samples, midi, velocity, instrument) {
    const layers = chooseSampleLayers(samples, midi, velocity, instrument);
    if (!layers.length) return null;
    layers.sort((a, b) => b.weight - a.weight);
    return layers[0].sample;
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== "object" || !manifest.instruments) {
      throw new TypeError("A manifest with an instruments object is required");
    }
    for (const [id, instrument] of Object.entries(manifest.instruments)) {
      if (!Array.isArray(instrument.samples) || instrument.samples.length === 0) {
        throw new TypeError("Instrument " + id + " has no samples");
      }
      for (const sample of instrument.samples) {
        if (!sample.url || !Number.isFinite(sample.rootMidi) ||
            !Number.isFinite(sample.keyLow) || !Number.isFinite(sample.keyHigh) ||
            !Number.isFinite(sample.velocityLow) || !Number.isFinite(sample.velocityHigh) ||
            sample.keyLow > sample.keyHigh || sample.velocityLow > sample.velocityHigh) {
          throw new TypeError("Invalid sample mapping in instrument " + id);
        }
      }
    }
  }

  function createSampleAudioEngine(options) {
    const opts = options || {};
    const context = opts.audioContext;
    const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const manifest = opts.manifest;
    const maxDecodedBytes = Math.max(1024 * 1024, Number(opts.maxDecodedBytes) || 96 * 1024 * 1024);
    const cache = new Map();
    const pending = new Map();
    const activeVoices = new Set();
    let decodedBytes = 0;
    let disposed = false;

    if (!context || typeof context.createBufferSource !== "function") {
      throw new TypeError("A Web Audio AudioContext is required");
    }
    if (!fetchImpl) throw new TypeError("Fetch is unavailable");
    validateManifest(manifest);

    function assertActive() {
      if (disposed) throw new Error("Sample audio engine has been disposed");
    }

    function touch(entry) {
      entry.lastUsed = Date.now();
    }

    function evictIfNeeded(protectedUrl) {
      if (decodedBytes <= maxDecodedBytes) return;
      const entries = Array.from(cache.entries())
        .filter(([url, entry]) => url !== protectedUrl && entry.refs === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [url, entry] of entries) {
        if (decodedBytes <= maxDecodedBytes) break;
        cache.delete(url);
        decodedBytes -= entry.bytes;
      }
    }

    async function loadBuffer(url) {
      assertActive();
      const cached = cache.get(url);
      if (cached) {
        touch(cached);
        return cached.buffer;
      }
      if (pending.has(url)) return pending.get(url);
      const request = (async () => {
        const response = await fetchImpl(url);
        if (!response || !response.ok) {
          throw new Error("Sample request failed (" + (response ? response.status : "no response") + "): " + url);
        }
        const encoded = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(encoded.slice(0));
        assertActive();
        const bytes = Math.max(1, buffer.length * buffer.numberOfChannels * 4);
        cache.set(url, { buffer, bytes, refs: 0, lastUsed: Date.now() });
        decodedBytes += bytes;
        evictIfNeeded(url);
        return buffer;
      })();
      pending.set(url, request);
      try {
        return await request;
      } finally {
        pending.delete(url);
      }
    }

    async function preload(instrumentId, notes) {
      assertActive();
      const instrument = manifest.instruments[instrumentId];
      if (!instrument) throw new Error("Unknown instrument: " + instrumentId);
      const requested = Array.isArray(notes) && notes.length ? notes : instrument.samples.map(s => s.rootMidi);
      const urls = new Set();
      for (const note of requested) {
        const midi = Number(typeof note === "object" ? note.midi : note);
        const velocity = clamp(Number(typeof note === "object" ? note.velocity : 80) || 80, 1, 127);
        for (const layer of chooseSampleLayers(instrument.samples, midi, velocity, instrument)) {
          urls.add(layer.sample.url);
        }
      }
      await Promise.all(Array.from(urls, loadBuffer));
      evictIfNeeded();
      return { instrumentId, loaded: urls.size, decodedBytes };
    }

    function scheduleNote(params) {
      assertActive();
      const p = params || {};
      const instrument = manifest.instruments[p.instrument];
      if (!instrument) throw new Error("Unknown instrument: " + p.instrument);
      const midi = Number(p.midi);
      const velocity = clamp(Number(p.velocity) || 1, 1, 127);
      const when = Math.max(context.currentTime, Number(p.when) || context.currentTime);
      const duration = Math.max(0.01, Number(p.duration) || 0.25);
      const layers = chooseSampleLayers(instrument.samples, midi, velocity, instrument);
      if (!layers.length) throw new Error("No mapped sample for " + p.instrument + " MIDI " + midi + " velocity " + velocity);
      const missing = layers.find(layer => !cache.has(layer.sample.url));
      if (missing) throw new Error("Sample is not loaded: " + missing.sample.url + ". Call preload() first.");

      const velocityGain = instrument.velocityMode === "layer" ? 1 :
        Number.isFinite(instrument.velocityGainMinDb)
          ? Math.pow(10, (instrument.velocityGainMinDb * (1 - velocity / 127)) / 20)
          : velocity / 127;
      const release = Math.max(0.025, Number(p.release) || Number(instrument.release) || 0.18);
      const noteOff = when + duration;
      const voices = [];

      for (const layer of layers) {
        const sample = layer.sample;
        const cached = cache.get(sample.url);
        touch(cached);
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = cached.buffer;
        source.playbackRate.setValueAtTime(Math.pow(2, (midi - sample.rootMidi) / 12), when);
        const destination = p.destination || context.destination;
        const peak = clamp(Number(p.gain) || 1, 0, 2) * velocityGain * layer.weight;
        const attack = Math.max(0.001, Number(instrument.attack) || 0.006);
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), when + attack);
        gain.gain.setValueAtTime(Math.max(0.0001, peak), Math.max(when + attack, noteOff));
        gain.gain.linearRampToValueAtTime(0.0001, noteOff + release);
        source.connect(gain);
        gain.connect(destination);
        const voice = { source, gain, sampleUrl: sample.url, stopped: false };
        activeVoices.add(voice);
        cached.refs += 1;
        source.onended = () => {
          if (voice.stopped) return;
          voice.stopped = true;
          activeVoices.delete(voice);
          const current = cache.get(sample.url);
          if (current) current.refs = Math.max(0, current.refs - 1);
          try { source.disconnect(); } catch (_) {}
          try { gain.disconnect(); } catch (_) {}
          evictIfNeeded();
        };
        source.start(when);
        voices.push(voice);
      }

      function stop(at) {
        const stopAt = Math.max(context.currentTime, Number(at) || context.currentTime);
        for (const voice of voices) {
          if (voice.stopped) continue;
          try {
            voice.gain.gain.cancelScheduledValues(stopAt);
            voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), stopAt);
            voice.gain.gain.linearRampToValueAtTime(0.0001, stopAt + 0.012);
            voice.source.stop(stopAt + 0.02);
          } catch (_) {}
        }
      }

      return {
        source: voices[0].source,
        gain: voices[0].gain,
        sampleUrl: voices[0].sampleUrl,
        sampleUrls: voices.map(voice => voice.sampleUrl),
        stop
      };
    }

    function stopAll(at) {
      const stopAt = Number.isFinite(Number(at)) ? Number(at) : context.currentTime;
      for (const voice of Array.from(activeVoices)) {
        if (voice.stopped) continue;
        try {
          voice.gain.gain.cancelScheduledValues(stopAt);
          voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), stopAt);
          voice.gain.gain.linearRampToValueAtTime(0.0001, stopAt + 0.012);
          voice.source.stop(stopAt + 0.02);
        } catch (_) {}
      }
    }

    function getStats() {
      return {
        cachedSamples: cache.size,
        pendingLoads: pending.size,
        activeVoices: activeVoices.size,
        decodedBytes,
        maxDecodedBytes
      };
    }

    function dispose() {
      stopAll(context.currentTime);
      disposed = true;
      cache.clear();
      pending.clear();
      decodedBytes = 0;
    }

    return Object.freeze({ preload, scheduleNote, stopAll, getStats, dispose });
  }

  return Object.freeze({ createSampleAudioEngine, chooseSample, chooseSampleLayers, validateManifest });
});
