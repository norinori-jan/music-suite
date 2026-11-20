# Sample audio assets

This directory contains the browser-native sample playback engine and generated instrument manifests.

## Importing the licensed source samples

Run from the repository root:

```sh
node scripts/import-meta-open-sound.mjs
```

The importer downloads the complete Meta Piano (352 OGG samples) and Meta Nylon Guitar (348 OGG samples) collections from the immutable upstream source revision recorded in the script. It verifies each OGG against the upstream `SHA256SUMS` before writing any asset and checks the collection's CC0 1.0 license before importing. Each generated manifest uses the sampler's required `{ instruments: { [instrumentId]: instrument } }` shape, and sample URLs are relative to `apps/composition-canvas.html`.

Expected generated structure:

- `audio/assets/meta-piano/ogg/`
- `audio/assets/meta-nylon-guitar/ogg/`
- `audio/meta-piano.manifest.json`
- `audio/meta-nylon-guitar.manifest.json`

The upstream collections are CC0 1.0. Their source LICENSE, README, SFZ mapping, and checksum files are copied beside the generated audio assets. The official release also supplies 24-bit / 48 kHz WAV masters; the OGG files are the web-preview encodings, and the production format decision remains open pending a representative WAV/OGG comparison. The importer does not include the separate Oculus Audio Pack (CC BY 4.0).

## Runtime

`sample-engine.js` is a dependency-free Web Audio multisample playback module. It uses explicit sample maps, velocity layers, shared AudioContext scheduling, lazy fetch/decode, request deduplication, and a bounded decoded-buffer cache. Missing/unloaded samples throw explicit errors; the engine never silently substitutes an oscillator.

The CC0 import has now completed on the development branch. All 352 Meta Piano OGG files and all 348 Meta Nylon Guitar OGG files are present, together with both generated manifests and the upstream LICENSE, README, SFZ, and SHA256SUMS files. The import job verified every downloaded OGG against the pinned upstream SHA-256 entry before committing the assets. Total encoded sample payload: 65,023,677 bytes (about 62.0 MiB). A regression test now re-reads every imported file and re-computes all 700 SHA-256 digests in CI. This confirms file integrity and local availability; browser playback and musical quality still require separate validation.

## Audio-quality decision (not yet finalized)

The upstream release also offers 24-bit / 48 kHz WAV source packages. The complete piano + nylon WAV sets total about 1,155.8 MB, while the official web OGG packages total about 63.9 MB. OGG is a delivery candidate, not an automatic quality-equivalent replacement for the source WAVs.

The importer currently stages the official OGG collections so the sampler mapping and loading path can be validated. This does **not** approve OGG as the final sound-quality choice. Final selection requires comparing actual rendered music, note attacks and decay tails, and iPhone Safari/PWA performance. If OGG is not good enough, evaluate higher-fidelity local or separately hosted assets with lazy loading rather than reducing the musical quality target.
