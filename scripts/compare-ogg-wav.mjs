#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

function stats(buffer) {
  const count = Math.floor(buffer.length / 4);
  if (!count) throw new Error("Empty decoded audio buffer");
  let sum = 0, sumSq = 0, peak = 0;
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const value = buffer.readFloatLE(i * 4);
    values[i] = value;
    sum += value;
    sumSq += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const mean = sum / count;
  let centeredSq = 0;
  for (const value of values) centeredSq += (value - mean) ** 2;
  return { values, count, mean, rms: Math.sqrt(sumSq / count), centeredRms: Math.sqrt(centeredSq / count), peak };
}

function compare(label, wav, ogg) {
  const a = stats(wav), b = stats(ogg), count = Math.min(a.count, b.count);
  let errorSq = 0, cross = 0, aSq = 0, bSq = 0, peakError = 0;
  let attackErrorSq = 0, attackSignalSq = 0;
  const attackCount = Math.min(count, 4800);
  for (let i = 0; i < count; i++) {
    const av = a.values[i] - a.mean, bv = b.values[i] - b.mean;
    const diff = av - bv;
    errorSq += diff * diff;
    cross += av * bv;
    aSq += av * av;
    bSq += bv * bv;
    peakError = Math.max(peakError, Math.abs(diff));
    if (i < attackCount) {
      attackErrorSq += diff * diff;
      attackSignalSq += av * av;
    }
  }
  const errorRms = Math.sqrt(errorSq / count);
  const snrDb = 20 * Math.log10(Math.sqrt(aSq / count) / Math.max(1e-15, errorRms));
  const correlation = cross / Math.sqrt(Math.max(1e-30, aSq * bSq));
  const attackErrorRms = Math.sqrt(attackErrorSq / attackCount);
  const attackSnrDb = 20 * Math.log10(Math.sqrt(attackSignalSq / attackCount) / Math.max(1e-15, attackErrorRms));
  return {
    label, wavFrames: a.count, oggFrames: b.count, comparedFrames: count,
    wavRms: Number(a.rms.toFixed(7)), oggRms: Number(b.rms.toFixed(7)),
    levelDeltaDb: Number((20 * Math.log10(Math.max(1e-15, b.rms) / Math.max(1e-15, a.rms))).toFixed(3)),
    errorRms: Number(errorRms.toFixed(7)), peakAbsoluteDifference: Number(peakError.toFixed(6)),
    correlation: Number(correlation.toFixed(7)), snrDb: Number(snrDb.toFixed(2)),
    attackWindowMs: Number((attackCount / 48).toFixed(1)), attackSnrDb: Number(attackSnrDb.toFixed(2))
  };
}

const args = process.argv.slice(2);
if (args.length < 4 || args.length % 4 !== 0 || args[0] !== "--pair") {
  throw new Error("Usage: node scripts/compare-ogg-wav.mjs --pair label wav.f32 ogg.f32 [--pair label wav.f32 ogg.f32 ...]");
}
const results = [];
for (let i = 0; i < args.length; i += 4) {
  if (args[i] !== "--pair") throw new Error("Expected --pair at argument " + i);
  results.push(compare(args[i + 1], await readFile(args[i + 2]), await readFile(args[i + 3])));
}
const report = {
  generatedAt: new Date().toISOString(),
  method: "Both files decoded to 48 kHz mono float PCM; stereo WAV downmixed equally to mono; sample-aligned comparison without loudness normalization or time shifting.",
  interpretation: "SNR/correlation quantify codec and channel-conversion differences, not subjective musical acceptability. Listen to the rendered passages before choosing the production format.",
  results
};
console.log(JSON.stringify(report, null, 2));
await writeFile("ogg-wav-comparison.json", JSON.stringify(report, null, 2) + "\n");
