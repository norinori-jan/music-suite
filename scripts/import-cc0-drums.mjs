#!/usr/bin/env node
// Import pinned CC0 Virtuosity Drums one-shots; verify Git blob IDs before WAV/OGG conversion.
// Requires Node.js 20+ and ffmpeg on PATH.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(ROOT, 'audio/drums/source-lock.json');
const OUTPUT_DIR = resolve(process.argv.find(x => x.startsWith('--output='))?.slice(9) || join(ROOT, 'audio/drums/samples'));
const requested = process.argv.find(x => x.startsWith('--format='))?.slice(9) || 'both';
if (!['wav', 'ogg', 'both'].includes(requested)) throw new Error('Use --format=wav, --format=ogg, or --format=both');
const formats = requested === 'both' ? ['wav', 'ogg'] : [requested];
const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (ffmpeg.error || ffmpeg.status !== 0) throw new Error('ffmpeg is required. Install ffmpeg and make sure it is available on PATH.');
await mkdir(OUTPUT_DIR, { recursive: true });
const tempDir = join(OUTPUT_DIR, '.source-cache');
await mkdir(tempDir, { recursive: true });

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function gitBlobSha(bytes) {
  const header = Buffer.from('blob ' + bytes.length + '\0');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}
function run(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('ffmpeg failed:\n' + (result.stderr || result.stdout || 'unknown error'));
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: lock.source,
  encoding: { wav: '24-bit PCM, 48 kHz, mono', ogg: 'Ogg Vorbis quality 8, 48 kHz, mono' },
  samples: []
};
for (const item of lock.samples) {
  const sourcePath = join(tempDir, item.id + '.flac');
  const url = 'https://raw.githubusercontent.com/' + lock.source.repository + '/' + lock.source.commit + '/' + item.path;
  let source = await readFile(sourcePath).catch(() => null);
  if (!source || gitBlobSha(source) !== item.gitBlobSha) {
    const response = await fetch(url, { headers: { 'User-Agent': 'music-suite-cc0-drum-import/1.0' } });
    if (!response.ok) throw new Error('Download failed (' + response.status + ') for ' + item.path);
    source = Buffer.from(await response.arrayBuffer());
    const actual = gitBlobSha(source);
    if (actual !== item.gitBlobSha) throw new Error('Git blob SHA mismatch for ' + item.path + ': expected ' + item.gitBlobSha + ', got ' + actual);
    await writeFile(sourcePath, source);
  }
  const record = { id: item.id, role: item.role, source: { path: item.path, gitBlobSha: item.gitBlobSha, sha256: sha256(source), bytes: source.length, notes: item.notes }, outputs: {} };
  for (const format of formats) {
    const extension = format === 'wav' ? 'wav' : 'ogg';
    const outputName = item.id + '.' + extension;
    const outputPath = join(OUTPUT_DIR, outputName);
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-map_metadata', '-1', '-ac', '1', '-ar', '48000'];
    const encoding = format === 'wav'
      ? ['-c:a', 'pcm_s24le']
      : ['-c:a', 'libvorbis', '-q:a', '8'];
    run([...common, ...encoding, outputPath]);
    const output = await readFile(outputPath);
    record.outputs[format] = { path: outputName, sha256: sha256(output), bytes: output.length };
    console.log(item.id + '.' + extension + ': ' + output.length.toLocaleString() + ' bytes');
  }
  manifest.samples.push(record);
}
await writeFile(join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await rm(tempDir, { recursive: true, force: true });
console.log('Verified ' + manifest.samples.length + ' CC0 source samples. Formats: ' + formats.join(', ') + '. Manifest: ' + join(OUTPUT_DIR, 'manifest.json'));
