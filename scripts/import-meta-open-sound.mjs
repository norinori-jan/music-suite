#!/usr/bin/env node
/**
 * Imports the complete CC0 Meta Open Sound piano and nylon-guitar OGG sets.
 * Source is pinned to an immutable upstream commit and every OGG is SHA-256
 * checked against that collection's published SHA256SUMS before it is written.
 *
 * Usage: node scripts/import-meta-open-sound.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/514c926efecdb3c7812bf00eedf8e5c8d61dd681";
const SOURCE_REPO = "https://github.com/facebookincubator/Meta-open-sound";
const COLLECTIONS = ["meta-piano", "meta-nylon-guitar"];
const CONCURRENCY = 6;

function parseAttrs(line) {
  const attrs = {};
  for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return attrs;
}

function parseSfz(text) {
  let defaultPath = "";
  let group = {};
  const regions = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("<control>")) continue;
    if (line.startsWith("<group>")) {
      group = parseAttrs(line.slice("<group>".length));
      continue;
    }
    if (line.startsWith("<region>")) {
      const region = parseAttrs(line.slice("<region>".length));
      if (!region.sample) continue;
      const key = Number(region.key ?? region.pitch_keycenter);
      const low = Number(region.lokey ?? region.key);
      const high = Number(region.hikey ?? region.key);
      const velocityLow = Number(region.lovel ?? group.lovel ?? 1);
      const velocityHigh = Number(region.hivel ?? group.hivel ?? 127);
      if (![key, low, high, velocityLow, velocityHigh].every(Number.isFinite)) {
        throw new Error("Unmapped SFZ region: " + line);
      }
      regions.push({
        file: path.posix.join(defaultPath, region.sample),
        rootMidi: key,
        keyLow: low,
        keyHigh: high,
        velocityLow,
        velocityHigh,
        string: region.sample.match(/String(LowE|A|D|G|B|HighE)_/)?.[1] ?? null,
        technique: region.sample.match(/(Finger|Pick)/)?.[1]?.toLowerCase() ?? null,
        group: group.group ? Number(group.group) : null,
        offBy: group.off_by ? Number(group.off_by) : null
      });
      continue;
    }
    if (line.startsWith("<")) continue;
    const control = parseAttrs(line);
    if (control.default_path) defaultPath = control.default_path;
  }
  return regions;
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  return checksums;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return Buffer.from(await response.arrayBuffer());
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function importCollection(id) {
  const sourceDir = "systems/instruments/" + id;
  const [license, readme, sfz, checksumText] = await Promise.all([
    fetchText(SOURCE + "/" + sourceDir + "/LICENSE"),
    fetchText(SOURCE + "/" + sourceDir + "/README.md"),
    fetchText(SOURCE + "/" + sourceDir + "/" + id + ".sfz"),
    fetchText(SOURCE + "/" + sourceDir + "/SHA256SUMS")
  ]);
  if (!/CC0 1\.0 Universal/.test(license.slice(0, 500))) {
    throw new Error("License verification failed for " + id + "; refusing import");
  }
  const regions = parseSfz(sfz);
  const checksums = parseChecksums(checksumText);
  if (!regions.length) throw new Error("No SFZ regions found for " + id);

  const uniqueFiles = [...new Set(regions.map(region => region.file))];
  const destination = path.join(ROOT, "audio", "assets", id);
  const oggDir = path.join(destination, "ogg");
  await mkdir(oggDir, { recursive: true });

  await mapLimit(uniqueFiles, CONCURRENCY, async relativeFile => {
    const expected = checksums.get(relativeFile);
    if (!expected) throw new Error("No upstream SHA-256 for " + id + "/" + relativeFile);
    const bytes = await fetchBytes(SOURCE + "/" + sourceDir + "/" + relativeFile);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error("SHA-256 mismatch: " + id + "/" + relativeFile);
    await writeFile(path.join(destination, relativeFile), bytes);
  });

  await Promise.all([
    writeFile(path.join(destination, "LICENSE"), license),
    writeFile(path.join(destination, "SOURCE-README.md"), readme),
    writeFile(path.join(destination, "SOURCE-SHA256SUMS"), checksumText),
    writeFile(path.join(destination, id + ".sfz"), sfz)
  ]);

  const instrument = {
    id,
    name: id === "meta-piano" ? "Meta Piano" : "Meta Nylon Guitar",
    license: "CC0-1.0",
    sourceRepository: SOURCE_REPO,
    sourceCommit: "514c926efecdb3c7812bf00eedf8e5c8d61dd681",
    sourceDirectory: sourceDir,
    sampleFormat: "OGG Vorbis",
    sourceSpecification: "SFZ",
    sampleCount: uniqueFiles.length,
    samples: regions.map(region => ({
      ...region,
      url: "./assets/" + id + "/" + region.file
    }))
  };
  await writeFile(path.join(ROOT, "audio", id + ".manifest.json"), JSON.stringify(instrument, null, 2) + "\n");
  return { id, samples: uniqueFiles.length, bytes: uniqueFiles.reduce((sum, file) => sum, 0) };
}

const results = [];
for (const id of COLLECTIONS) results.push(await importCollection(id));
console.log("Imported verified CC0 sample collections:", JSON.stringify(results));
