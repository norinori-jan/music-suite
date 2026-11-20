(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SampleAudioEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function chooseSample(samples, midi, velocity) {
    const candidates = samples.filter(sample =>
      midi >= sample.keyLow && midi <= sample.keyHigh &&
      velocity >= sample.velocityLow && velocity <= sample.velocityHigh
    );
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aDistance = Math.abs(midi - a.rootMidi);
      const bDistance = Math.abs(midi - b.rootMidi);
      if (aDistance !== bDistance) return aDistance - bDistance;
      const aCenter = (a.velocityLow + a.velocityHigh) / 2;
      const bCenter = (b.velocityLow + b.velocityHigh) / 2;
      return Math.abs(velocity - aCenter) - Math.abs(velocity - bCenter);
    });
    return candidates[0];
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
        const sample = chooseSample(instrument.samples, midi, velocity);
        if (sample) urls.add(sample.url);
      }
      await Promise.all(Array.from(urls, loadBuffer));
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
      const sample = chooseSample(instrument.samples, midi, velocity);
      if (!sample) throw new Error("No mapped sample for " + p.instrument + " MIDI " + midi + " velocity " + velocity);
      const cached = cache.get(sample.url);
      if (!cached) throw new Error("Sample is not loaded: " + sample.url + ". Call preload() first.");
      touch(cached);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = cached.buffer;
      source.playbackRate.setValueAtTime(Math.pow(2, (midi - sample.rootMidi) / 12), when);
      const destination = p.destination || context.destination;
      const peak = clamp(Number(p.gain) || 1, 0, 2) * (velocity / 127);
      const attack = Math.max(0.001, Number(instrument.attack) || 0.006);
      const release = Math.max(0.025, Number(p.release) || Number(instrument.release) || 0.18);
      const noteOff = when + duration;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), when + attack);
      gain.gain.setValueAtTime(Math.max(0.0001, peak), Math.max(when + attack, noteOff));
      gain.gain.linearRampToValueAtTime(0.0001, noteOff + release);
      source.connect(gain);
      gain.connect(destination);
      const voice = { source, gain, sampleUrl: sample.url, stopped: false };
      activeVoices.add(voice);
      const cacheEntry = cache.get(sample.url);
      cacheEntry.refs += 1;
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
      return {
        source,
        gain,
        sampleUrl: sample.url,
        stop(at) {
          if (voice.stopped) return;
          const stopAt = Math.max(context.currentTime, Number(at) || context.currentTime);
          try {
            gain.gain.cancelScheduledValues(stopAt);
            gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), stopAt);
            gain.gain.linearRampToValueAtTime(0.0001, stopAt + 0.012);
            source.stop(stopAt + 0.02);
          } catch (_) {}
        }
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

  return Object.freeze({ createSampleAudioEngine, chooseSample, validateManifest });
});
