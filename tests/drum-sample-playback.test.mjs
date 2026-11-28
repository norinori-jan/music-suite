import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('apps/beat-lab.html', root), 'utf8');
const importer = await readFile(new URL('scripts/import-cc0-drums.mjs', root), 'utf8');
const lock = JSON.parse(await readFile(new URL('audio/drums/source-lock.json', root), 'utf8'));

test('BEAT//LAB can load local CC0 drum samples and retain synth fallback', () => {
  assert.match(html, /id="drum-sample-format"/);
  assert.match(html, /option value="wav"/);
  assert.match(html, /option value="ogg"/);
  assert.match(html, /onclick="loadDrumSampleKit\(\)"/);
  assert.match(html, /async function loadDrumSampleKit\(\)/);
  assert.match(html, /decodeAudioData/);
  assert.match(html, /fetch\('\.\.\/audio\/drums\/samples\/'\+id\+'\.'\+format/);
  assert.match(html, /function playDrumSample\(pitch,velocity,when\)/);
  assert.match(html, /if\(playDrumSample\(pitch,safeVel,at\)\)return/);
  assert.match(html, /getKick\(\)\.triggerAttackRelease/);
  assert.match(html, /window\.__drumSampleKitDiagnostics/);
  assert.match(html, /Open and closed hats share a choke group/);
});

test('CC0 drum importer verifies source Git blob IDs and produces 24-bit WAV plus OGG q8', () => {
  assert.match(importer, /function gitBlobSha\(bytes\)/);
  assert.match(importer, /Git blob SHA mismatch/);
  assert.match(importer, /pcm_s24le/);
  assert.match(importer, /libvorbis/);
  assert.match(importer, /-q:a', '8'/);
  assert.match(importer, /sha256/);
  assert.equal(lock.source.license, 'CC0-1.0');
  assert.equal(lock.samples.length, 14);
});
