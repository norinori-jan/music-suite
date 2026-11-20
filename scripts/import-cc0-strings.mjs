import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_REPO = "sgossner/VSCO-2-CE";
const SOURCE_REVISION = "440300901dfe9275fd84e0b7763af1f8443ae62e";
const PACKS = [
  { id: "meta-violin-section", repo: "AEmotionStudio/stringstudio-violin-samples", instrument: "violin", expectedZones: 30, attack: 0.12, release: 0.5 },
  { id: "meta-cello-section", repo: "AEmotionStudio/stringstudio-cello-samples", instrument: "cello", expectedZones: 26, attack: 0.18, release: 0.75 }
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

function inspectWav(buffer, label) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(label + " is not a RIFF/WAVE file");
  }
  let offset = 12, fmt = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22)
      };
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 48000 || fmt.bitsPerSample !== 24) {
    throw new Error(label + " has unexpected WAV format: " + JSON.stringify(fmt));
  }
  return fmt;
}

async function loadPack(pack, dryRun) {
  const apiResponse = await get("https://huggingface.co/api/models/" + pack.repo);
  const api = await apiResponse.json();
  if (!/^[a-f0-9]{40}$/i.test(api.sha || "")) throw new Error("Could not pin Hugging Face revision for " + pack.repo);
  const revision = api.sha;
  const base = "https://huggingface.co/" + pack.repo + "/resolve/" + revision + "/";
  const [manifestResponse, readmeResponse] = await Promise.all([
    get(base + "manifest.json"),
    get(base + "README.md")
  ]);
  const manifestText = await manifestResponse.text();
  const readme = await readmeResponse.text();
  const manifest = JSON.parse(manifestText);
  if (manifest.license !== "CC0-1.0" || manifest.instrument !== pack.instrument ||
      manifest.sampleRate !== 48000 || !Array.isArray(manifest.zones) ||
      manifest.zones.length !== pack.expectedZones) {
    throw new Error("Unexpected or unlicensed manifest for " + pack.id);
  }
  if (!readme.includes("CC0-1.0") || !readme.includes("VSCO 2 Community Edition") ||
      !readme.includes("24-bit PCM WAV")) {
    throw new Error("Source/license/format declaration is missing from " + pack.repo);
  }
  const names = new Set();
  for (const zone of manifest.zones) {
    if (!/^samples\/[0-9]+_v[0-9]+-[0-9]+_rr[0-9]+\.wav$/.test(zone.file) ||
        !/^[a-f0-9]{64}$/i.test(zone.sha256 || "") ||
        !Number.isFinite(zone.rootPitch) || !Number.isFinite(zone.lowPitch) ||
        !Number.isFinite(zone.highPitch) || !Number.isFinite(zone.lowVelocity) ||
        !Number.isFinite(zone.highVelocity) || names.has(zone.file)) {
      throw new Error("Invalid zone or checksum metadata in " + pack.id + ": " + zone.file);
    }
    names.add(zone.file);
  }
  return { pack, revision, manifest, manifestText, readme, base, totalBytes: manifest.zones.reduce((sum, z) => sum + z.sizeBytes, 0), samples: [] };
}

const licenseResponse = await get("https://raw.githubusercontent.com/" + SOURCE_REPO + "/" + SOURCE_REVISION + "/LICENSE");
const sourceLicense = await licenseResponse.text();
if (!sourceLicense.startsWith("CC0 1.0 Universal")) throw new Error("VSCO 2 CE source license is not CC0 1.0");

const plans = [];
for (const pack of PACKS) plans.push(await loadPack(pack, process.argv.includes("--dry-run")));
if (process.argv.includes("--dry-run")) {
  console.log("Verified CC0 string import plan:", JSON.stringify(plans.map(p => ({
    id: p.pack.id, revision: p.revision, zones: p.manifest.zones.length,
    sampleRate: p.manifest.sampleRate, totalBytes: p.totalBytes, dryRun: true
  }))));
  process.exit(0);
}

for (const plan of plans) {
  for (let i = 0; i < plan.manifest.zones.length; i += 5) {
    const batch = plan.manifest.zones.slice(i, i + 5);
    const downloaded = await Promise.all(batch.map(async zone => {
      const response = await get(plan.base + zone.file);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== zone.sizeBytes) throw new Error("Size mismatch: " + plan.pack.id + "/" + zone.file);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual.toLowerCase() !== zone.sha256.toLowerCase()) throw new Error("SHA-256 mismatch: " + plan.pack.id + "/" + zone.file);
      const wav = inspectWav(bytes, plan.pack.id + "/" + zone.file);
      return { zone, bytes, wav };
    }));
    plan.samples.push(...downloaded);
  }
}

for (const plan of plans) {
  const id = plan.pack.id;
  const destination = path.join(ROOT, "audio", "assets", id);
  await mkdir(path.join(destination, "samples"), { recursive: true });
  for (const item of plan.samples) {
    await writeFile(path.join(destination, item.zone.file), item.bytes);
  }
  await writeFile(path.join(destination, "LICENSE"), sourceLicense);
  await writeFile(path.join(destination, "SOURCE-README.md"), plan.readme);
  await writeFile(path.join(destination, "SOURCE-MANIFEST.json"), plan.manifestText);
  await writeFile(path.join(destination, "SOURCE-REVISION.json"), JSON.stringify({
    packRepository: plan.pack.repo,
    packRevision: plan.revision,
    sourceRepository: SOURCE_REPO,
    sourceLicenseRevision: SOURCE_REVISION,
    license: "CC0-1.0",
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 24,
    zoneCount: plan.samples.length
  }, null, 2) + "\n");
  const instrument = {
    license: "CC0-1.0",
    sourceLibrary: "VSCO 2 Community Edition",
    noteOffMode: "sustain",
    velocityGainMinDb: -12,
    attack: plan.pack.attack,
    release: plan.pack.release,
    samples: plan.samples.map(({ zone }) => ({
      url: "../audio/assets/" + id + "/" + zone.file,
      rootMidi: zone.rootPitch,
      keyLow: zone.lowPitch,
      keyHigh: zone.highPitch,
      velocityLow: zone.lowVelocity,
      velocityHigh: zone.highVelocity
    }))
  };
  await writeFile(path.join(ROOT, "audio", id + ".manifest.json"),
    JSON.stringify({ instruments: { [id]: instrument } }, null, 2) + "\n");
}

console.log("Imported and SHA-256 verified CC0 string samples:", JSON.stringify(plans.map(p => ({
  id: p.pack.id, revision: p.revision, zones: p.samples.length,
  totalBytes: p.totalBytes, sha256Verified: true, wavFormat: "PCM mono 48 kHz / 24-bit"
}))));
