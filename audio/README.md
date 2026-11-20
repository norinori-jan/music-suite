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

The upstream collections are CC0 1.0. Their source LICENSE, README, SFZ mapping, and checksum files are copied beside the generated audio assets. The importer does not include the separate Oculus Audio Pack (CC BY 4.0).

## Runtime

`sample-engine.js` is a dependency-free Web Audio multisample playback module. It uses explicit sample maps, velocity layers, shared AudioContext scheduling, lazy fetch/decode, request deduplication, and a bounded decoded-buffer cache. Missing/unloaded samples throw explicit errors; the engine never silently substitutes an oscillator.

The importer has not been run as part of this commit, so generated OGG assets and instrument manifests are not yet present. Do not report sample playback as enabled until the generated assets are included and loaded successfully.

## Audio-quality decision (not yet finalized)

The upstream release also offers 24-bit / 48 kHz WAV source packages. The complete piano + nylon WAV sets total about 1,155.8 MB, while the official web OGG packages total about 63.9 MB. OGG is a delivery candidate, not an automatic quality-equivalent replacement for the source WAVs.

The importer currently stages the official OGG collections so the sampler mapping and loading path can be validated. This does **not** approve OGG as the final sound-quality choice. Final selection requires comparing actual rendered music, note attacks and decay tails, and iPhone Safari/PWA performance. If OGG is not good enough, evaluate higher-fidelity local or separately hosted assets with lazy loading rather than reducing the musical quality target.
