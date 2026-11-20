import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const BASS_REPO = "sfzinstruments/karoryfer.swagbass";
const BASS_REV = "9d10fcae71af1975988ddecd5af1c95d372c7355";
const DRUM_REPO = "sfzinstruments/karoryfer.big-rusty-drums";
const DRUM_REV = "f07ce00df34a46b6b08375be56fe116cf15782bc";
const DRUM_MAPS = [
  { id: "kick", midi: 36, sfz: "Programs/mappings/kick_24/k_kick.sfz" },
  { id: "snare", midi: 38, sfz: "Programs/mappings/snare_14/sn_center_top.sfz" },
  { id: "hat", midi: 42, sfz: "Programs/mappings/hihat_14/ht_tc_cl.sfz" },
  { id: "crash", midi: 49, sfz: "Programs/mappings/crash_17/cr_cl.sfz" }
];

async function get(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 800));
    }
  }
  throw lastError;
}

function sha1GitBlob(bytes) {
  return createHash("sha1").update(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes])).digest("hex");
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function field(text, name, fallback) {
  const match = text.match(new RegExp("^\\s*" + name + "=(\\d+)\\s*$", "m"));
  return match ? Number(match[1]) : fallback;
}
function inspectWav(buffer, label) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error(label + " is not RIFF/WAVE");
  let offset = 12, fmt = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      fmt = { format: buffer.readUInt16LE(offset + 8), channels: buffer.readUInt16LE(offset + 10), sampleRate: buffer.readUInt32LE(offset + 12), bitsPerSample: buffer.readUInt16LE(offset + 22), cbSize: size >= 18 ? buffer.readUInt16LE(offset + 16) : 0, validBits: size >= 24 ? buffer.readUInt16LE(offset + 18) : 0, subFormat: size >= 40 ? buffer.readUInt32LE(offset + 24) : 0, subFormatTail: size >= 40 ? buffer.subarray(offset + 28, offset + 40) : null };
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const extensiblePcm = fmt && fmt.format === 65534 && fmt.cbSize >= 22 && fmt.validBits === 24 && fmt.subFormat === 1 && fmt.subFormatTail.equals(Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]));
  if (!fmt || (fmt.format !== 1 && !extensiblePcm) || fmt.channels !== 1 || fmt.sampleRate !== 48000 || fmt.bitsPerSample !== 24) {
    throw new Error(label + " unexpected WAV format: " + JSON.stringify(fmt));
  }
  return fmt;
}
function convertToWav(source, destination) {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map_metadata", "-1", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", destination], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("ffmpeg conversion failed: " + (result.stderr || result.error || "unknown error"));
}
async function sourceTree(repo, revision) {
  const response = await get("https://api.github.com/repos/" + repo + "/git/trees/" + revision + "?recursive=1");
  const data = await response.json();
  if (data.truncated || !Array.isArray(data.tree)) throw new Error("Could not verify complete pinned source tree: " + repo);
  return new Map(data.tree.filter(item => item.type === "blob").map(item => [item.path, item]));
}
async function fetchVerified(repo, revision, tree, file) {
  const entry = tree.get(file);
  if (!entry || !/^[a-f0-9]{40}$/i.test(entry.sha || "")) throw new Error("Source file is absent from pinned tree: " + repo + "/" + file);
  const response = await get("https://raw.githubusercontent.com/" + repo + "/" + revision + "/" + encodeURI(file));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha1GitBlob(bytes) !== entry.sha) throw new Error("Git blob SHA-1 mismatch: " + repo + "/" + file);
  return { bytes, gitBlobSha1: entry.sha, sourceSha256: sha256(bytes) };
}
function parseBassZones(sfzText) {
  const zones = [];
  for (const group of sfzText.split(/(?=<group>)/i).slice(1)) {
    const header = group.split(/<region>/i)[0];
    const rootMidi = field(header, "pitch_keycenter", NaN);
    const keyLow = field(header, "lokey", NaN), keyHigh = field(header, "hikey", NaN);
    const velocityLow = field(header, "lovel", 1), velocityHigh = field(header, "hivel", 127);
    if (![rootMidi, keyLow, keyHigh].every(Number.isFinite)) continue;
    const regionText = group.split(/<region>/i).slice(1);
    for (const region of regionText) {
      const match = region.match(/^\s*sample=notes(?:\\|\/)([^\r\n]+)/m);
      if (!match || !/_rr1\.wav$/i.test(match[1])) continue;
      zones.push({ sourceFile: "notes/" + match[1].replace(/\\/g, "/"), rootMidi, keyLow, keyHigh, velocityLow, velocityHigh, velocityMode: "sfz" });
    }
  }
  const unique = new Map(zones.map(zone => [zone.sourceFile, zone]));
  return [...unique.values()];
}
function parseDrumZones(id, midi, sfzText) {
  const zones = [];
  for (const group of sfzText.split(/(?=<group>)/i).slice(1)) {
    const velocityLow = field(group, "lovel", 1), velocityHigh = field(group, "hivel", 127);
    const regions = group.split(/<region>/i).slice(1);
    for (const region of regions) {
      const match = region.match(/^\s*sample=\.\.\/Samples\/([^\r\n]+)/m);
      if (!match) continue;
      const sourceFile = "Samples/" + match[1].replace(/\\/g, "/");
      if (!/_rr[1-4]\.flac$/i.test(sourceFile)) continue;
      const rr = Number((sourceFile.match(/_rr([1-4])\.flac$/i) || [])[1]);
      const filename = path.posix.basename(sourceFile);
      zones.push({ instrument: id, midi, rootMidi: midi, keyLow: midi, keyHigh: midi, velocityLow, velocityHigh, roundRobinGroup: id + "-" + velocityLow + "-" + velocityHigh, roundRobinIndex: rr, sourceFile });
    }
  }
  return zones;
}

const dryRun = process.argv.includes("--dry-run");
const bassTree = await sourceTree(BASS_REPO, BASS_REV);
const drumTree = await sourceTree(DRUM_REPO, DRUM_REV);
const [bassLicense, bassSfz, drumLicense] = await Promise.all([
  fetchVerified(BASS_REPO, BASS_REV, bassTree, "LICENSE"),
  fetchVerified(BASS_REPO, BASS_REV, bassTree, "swagbass_clean.sfz"),
  fetchVerified(DRUM_REPO, DRUM_REV, drumTree, "LICENSE")
]);
if (!bassLicense.bytes.toString("utf8").startsWith("Creative Commons Legal Code") || !bassLicense.bytes.toString("utf8").includes("CC0 1.0 Universal")) throw new Error("Swagbass license is not CC0-1.0");
if (!drumLicense.bytes.toString("utf8").startsWith("Creative Commons Legal Code") || !drumLicense.bytes.toString("utf8").includes("CC0 1.0 Universal")) throw new Error("Big Rusty Drums license is not CC0-1.0");
const bassZones = parseBassZones(bassSfz.bytes.toString("utf8"));
if (bassZones.length !== 48) throw new Error("Expected 48 mapped Swagbass velocity zones; found " + bassZones.length);
const drumZones = [];
const drumMapMetadata = [];
for (const map of DRUM_MAPS) {
  const mapping = await fetchVerified(DRUM_REPO, DRUM_REV, drumTree, map.sfz);
  const zones = parseDrumZones(map.id, map.midi, mapping.bytes.toString("utf8"));
  if (!zones.length || zones.some(zone => zone.roundRobinIndex < 1 || zone.roundRobinIndex > 4)) throw new Error("Invalid SFZ mapping: " + map.sfz);
  drumZones.push(...zones);
  drumMapMetadata.push({ id: map.id, midi: map.midi, sfz: map.sfz, gitBlobSha1: mapping.gitBlobSha1, sourceSha256: mapping.sourceSha256, zones: zones.length });
}
if (drumZones.length < 80) throw new Error("Expected multi-velocity, four-round-robin drum maps; found only " + drumZones.length + " zones");

const allZones = [
  ...bassZones.map((zone, index) => ({ ...zone, pack: "bass", sourceRepo: BASS_REPO, revision: BASS_REV, tree: bassTree, outputFile: "samples/bass/" + path.posix.basename(zone.sourceFile).replace(/_rr1\.wav$/i, ".wav"), index })),
  ...drumZones.map((zone, index) => ({ ...zone, pack: "drums", sourceRepo: DRUM_REPO, revision: DRUM_REV, tree: drumTree, outputFile: "samples/drums/" + zone.instrument + "/" + path.posix.basename(zone.sourceFile).replace(/_rr[1-4]\.flac$/i, "_rr" + zone.roundRobinIndex + ".wav"), index }))
];
const totals = { bass: 0, drums: 0 };
for (const zone of allZones) {
  const tree = zone.tree;
  const entry = tree.get(zone.sourceFile);
  if (!entry) throw new Error("Source sample missing from pinned tree: " + zone.sourceFile);
  totals[zone.pack] += entry.size;
}
if (dryRun) {
  console.log("Verified CC0 rhythm import plan:", JSON.stringify({
    bass: { repository: BASS_REPO, revision: BASS_REV, zones: bassZones.length, sourceBytes: totals.bass },
    drums: { repository: DRUM_REPO, revision: DRUM_REV, zones: drumZones.length, sourceBytes: totals.drums, instruments: drumMapMetadata },
    outputFormat: "mono PCM 24-bit / 48 kHz WAV",
    dryRun: true
  }));
  process.exit(0);
}

const imported = { bass: [], drums: [] };
for (const zone of allZones) {
  const source = await fetchVerified(zone.sourceRepo, zone.revision, zone.tree, zone.sourceFile);
  const sourcePath = path.join(ROOT, ".tmp-rhythm", zone.pack, String(zone.index) + ".source" + path.extname(zone.sourceFile));
  const outputPath = path.join(ROOT, ".tmp-rhythm", zone.pack, String(zone.index) + ".wav");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source.bytes);
  convertToWav(sourcePath, outputPath);
  const converted = await readFile(outputPath);
  const format = inspectWav(converted, zone.sourceFile);
  const destination = path.join(ROOT, "audio", "assets", zone.pack === "bass" ? "meta-swagbass" : "meta-big-rusty-drums", zone.outputFile);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, converted);
  imported[zone.pack].push({
    ...Object.fromEntries(Object.entries(zone).filter(([key]) => !["tree", "index", "pack", "sourceRepo", "revision", "outputFile", "velocityMode"].includes(key))),
    file: zone.outputFile,
    sizeBytes: converted.length,
    sha256: sha256(converted),
    sourceSizeBytes: source.bytes.length,
    sourceSha256: source.sourceSha256,
    sourceGitBlobSha1: source.gitBlobSha1,
    outputFormat: format
  });
}

for (const [pack, id, repository, revision, license] of [
  ["bass", "meta-swagbass", BASS_REPO, BASS_REV, bassLicense.bytes],
  ["drums", "meta-big-rusty-drums", DRUM_REPO, DRUM_REV, drumLicense.bytes]
]) {
  const destination = path.join(ROOT, "audio", "assets", id);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "LICENSE"), license);
  const zones = imported[pack];
  await writeFile(path.join(destination, "SOURCE-MANIFEST.json"), JSON.stringify({
    license: "CC0-1.0", repository, revision, zones
  }, null, 2) + "\n");
  await writeFile(path.join(destination, "SOURCE-REVISION.json"), JSON.stringify({
    repository, revision, license: "CC0-1.0", sampleRate: 48000, channels: 1, bitsPerSample: 24,
    zoneCount: zones.length, sourceFilesSHA256Verified: true, sourceGitBlobSHA1Verified: true,
    convertedFilesSHA256Recorded: true
  }, null, 2) + "\n");
}
const bassManifest = {
  id: "meta-swagbass", name: "Karoryfer Swagbass Clean", license: "CC0-1.0", sourceRepository: "https://github.com/" + BASS_REPO,
  sourceCommit: BASS_REV, sampleFormat: "PCM WAV 24-bit / 48 kHz mono", noteOffMode: "release", velocityMode: "layer",
  attack: 0.004, release: 0.18, samples: imported.bass.map(zone => ({
    url: "../audio/assets/meta-swagbass/" + zone.file, rootMidi: zone.rootMidi, keyLow: zone.keyLow, keyHigh: zone.keyHigh,
    velocityLow: zone.velocityLow, velocityHigh: zone.velocityHigh
  }))
};
const drumManifest = {
  id: "meta-big-rusty-drums", name: "Karoryfer Big Rusty Drums", license: "CC0-1.0", sourceRepository: "https://github.com/" + DRUM_REPO,
  sourceCommit: DRUM_REV, sampleFormat: "FLAC source converted to PCM WAV 24-bit / 48 kHz mono",
  noteOffMode: "one-shot", velocityMode: "layer", roundRobin: true, attack: 0.001, release: 0.03,
  samples: imported.drums.map(zone => ({
    url: "../audio/assets/meta-big-rusty-drums/" + zone.file, rootMidi: zone.rootMidi, keyLow: zone.keyLow, keyHigh: zone.keyHigh,
    velocityLow: zone.velocityLow, velocityHigh: zone.velocityHigh,
    roundRobinGroup: zone.roundRobinGroup, roundRobinIndex: zone.roundRobinIndex
  }))
};
await writeFile(path.join(ROOT, "audio/meta-swagbass.manifest.json"), JSON.stringify({ instruments: { "meta-swagbass": bassManifest } }, null, 2) + "\n");
await writeFile(path.join(ROOT, "audio/meta-big-rusty-drums.manifest.json"), JSON.stringify({ instruments: { "meta-big-rusty-drums": drumManifest } }, null, 2) + "\n");
console.log("Imported verified CC0 rhythm samples:", JSON.stringify({
  bass: { zones: imported.bass.length, sourceBytes: totals.bass, outputBytes: imported.bass.reduce((sum, zone) => sum + zone.sizeBytes, 0) },
  drums: { zones: imported.drums.length, sourceBytes: totals.drums, outputBytes: imported.drums.reduce((sum, zone) => sum + zone.sizeBytes, 0) },
  format: "mono PCM 24-bit / 48 kHz WAV", sha256Verified: true, gitBlobSha1Verified: true
}));
