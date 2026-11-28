import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(await readFile(new URL('audio/drums/source-lock.json', root), 'utf8'));

test('drum source lock pins CC0 provenance and immutable source identities', () => {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.source.license, 'CC0-1.0');
  assert.match(lock.source.licenseUrl, /virtuosity_drums.*LICENSE/);
  assert.equal(lock.source.commit, '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc');
  assert.ok(lock.samples.length >= 10);
  const ids = new Set();
  for (const sample of lock.samples) {
    assert.ok(!ids.has(sample.id), 'duplicate sample id: ' + sample.id);
    ids.add(sample.id);
    assert.match(sample.gitBlobSha, /^[a-f0-9]{40}$/);
    assert.ok(sample.bytes > 0);
    assert.match(sample.path, /^Samples\//);
    assert.ok(sample.notes.length > 10);
  }
  for (const role of ['kick','snare','closedHat','openHat','crash','ride','highTom','lowTom']) {
    assert.ok(lock.samples.some(sample => sample.role === role), 'missing role ' + role);
  }
});
