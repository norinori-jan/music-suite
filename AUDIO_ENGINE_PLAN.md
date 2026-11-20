# Audio Engine Plan

## Goal

Replace the current oscillator/noise-only composition preview with a sample-based instrument engine. The target is not merely "notes are audible": piano, guitars, bass, strings, and drums must retain recognizable recorded-instrument attacks, dynamics, decay, and articulation. A/B/C must use different instrument choices and performance behavior while sharing the same lyric source.

The lyric selection/storage pipeline remains independent from audio rendering.

## Current implementation (confirmed in `apps/composition-canvas.html`)

- `playSelectedComposition()` creates oscillators for melody, chords, and bass.
- Drum sounds are generated from a noise buffer plus a kick oscillator.
- All tracks are scheduled against one AudioContext clock.
- Track mute/solo is already applied before scheduling.
- The app currently has no root `package.json`; the composition app is a standalone HTML page with inline JavaScript.
- Therefore, the first engine should be browser-native and easy to load from a classic script, rather than requiring an immediate bundler migration.

## Candidate instrument sources

### Preferred starting source: Meta Open Sound (CC0)

Repository: https://github.com/facebookincubator/Meta-open-sound

- Meta Piano: 352 samples, all 88 keys A0-C8, four velocity layers, 48 kHz / 24-bit source WAV, OGG web previews.
- Meta Nylon Guitar: 348 samples, six string zones, three dynamic/technique layers, E2-B5.
- Meta Steel Guitar: 375 samples, six string zones, three velocity layers, E2-C6.
- The instrument collections are CC0 1.0. The source repository includes collection-specific LICENSE files, manifests, checksums, README design specifications, and SFZ maps.
- Use the supplied SFZ maps as the authoritative note/velocity/string mapping. Do not guess filenames or treat velocity as volume-only when the source layers have different timbres.
- Do not copy all samples blindly. Select the notes/layers needed by the supported composition range and load them on demand.

### Strings candidates

- VSCO 2 Community Edition is CC0 1.0 and contains orchestral instruments, but the complete library is about 2.3 GB. Do not bundle the full archive. Select only the required violin/cello articulations and create a compact instrument subset.
- VCSL is also CC0 but its full collection is 4+ GB; it is not a suitable whole-library app dependency.
- Individual compact CC0 string patches should be evaluated before selecting the final violin/cello source.

### Bass candidates

- Karoryfer Growlybass is CC0 1.0, 310 samples, 24-bit / 44.1 kHz WAV, approximately 160 MB for the full package. Its SFZ mappings include velocity layers, round robins, sustained/staccato and release behavior. Evaluate a reduced subset rather than bundling all 160 MB.
- Also compare a smaller CC0 upright/double-bass source for warm A/C arrangements.

### Drum candidates

- FreePats MuldjordKit is an acoustic kit with velocity layers and randomized/round-robin samples. The published SFZ FLAC package is about 157 MiB and is CC BY 4.0; if selected, include the exact attribution and license text.
- Prefer extracting only kick, snare, closed/open hat, tom and cymbal samples needed by the arrangement.
- Compare smaller CC0 kits/one-shots before deciding. Do not use unverified sample packs or samples with unclear redistribution rights.

## Playback engine decision

Initial direction: a small, project-owned multisample sampler built on native Web Audio nodes, driven by explicit instrument/sample manifests derived from SFZ mappings.

Reasons:
- Meta's strongest candidate piano and guitar samples are supplied as SFZ maps plus web-ready OGG files, not as a single SF2 bank.
- A custom sampler can honor exact key, velocity, string-zone, technique, and sample selection rules without converting the recordings into a monolithic bank.
- It avoids adding a large runtime dependency and avoids GPL-licensed player code.
- It preserves the current common AudioContext scheduling model and existing track mute/solo behavior.

The sampler should expose a narrow interface (load instrument, preload notes, schedule note, cancel notes, release/close) so the playback backend can be replaced if a later benchmark favors a SoundFont engine.

Alternatives reviewed:
- `spessasynth_lib`: Apache-2.0, SF2/SF3/DLS playback, AudioWorklet/Worker modes, but it is a SoundFont engine and does not directly consume the Meta SFZ instrument maps.
- `webaudiofontplayer`: MIT sample-based SF2-JSON player, but it expects converted SF2-JSON presets rather than native SFZ maps.
- `surikov/webaudiofont`: GPL-3.0-or-later; do not adopt without a deliberate GPL compatibility decision.

## Required sampler behavior

1. **Instrument mapping**
   - Exact key ranges and root pitch.
   - Velocity layers with crossfade/selection as defined by the SFZ/source specification.
   - Guitar string selection and finger/pick articulation.
   - Optional round-robin variation and note-off/release samples where the source provides them.
2. **Audio loading**
   - Lazy-load only the required sample files.
   - Deduplicate concurrent requests for the same sample.
   - Decode once and cache AudioBuffers.
   - Bound the in-memory decoded-buffer cache; release least-recently-used buffers when safe.
   - Do not fetch sample files from third-party hosts at playback time in the final app. Package the selected assets locally so playback does not depend on GitHub/CDN availability.
3. **Scheduling**
   - Keep all tracks on the same AudioContext clock.
   - Preserve velocity, note duration, sample start offsets, and release tails.
   - Stop/cancel scheduled notes without leaving nodes or timers behind.
4. **Mixing**
   - Per-track gain and pan.
   - Shared master gain and a conservative limiter/compressor.
   - Reverb send/bus rather than creating a separate reverb for every note.
   - A/B/C-specific instrument choices, articulations, dynamics, and effect sends.
5. **iPhone/PWA constraints**
   - Create/resume AudioContext only from a user gesture.
   - Use compressed web audio assets where Safari supports them; retain a tested fallback format for Safari versions that do not decode the chosen format.
   - Avoid decoding the whole library at startup.
   - Preload only the currently selected arrangement's required notes/instruments.
   - Cache selected assets locally for subsequent offline playback.
   - Provide clear loading/error status and never silently fall back to oscillator sounds while claiming sample playback.
6. **Accessibility and resilience**
   - If a sample is missing or fails to decode, show which instrument/sample failed.
   - Do not claim a track is sample-based unless its samples loaded successfully.
   - Keep a clearly labeled temporary fallback only for development diagnostics.

## A/B/C target palette

- A (warm): felt/soft piano or nylon guitar, warm bass, restrained acoustic drums, light sustained strings.
- B (dramatic): brighter piano/steel guitar where appropriate, stronger bass, fuller drum kit/cymbal accents, wider string ensemble.
- C (bittersweet): softer piano, restrained strings/cello, sparse bass and percussion, longer natural tails and more space.

These are starting palette definitions, not a final mix. The sound must be judged by listening to the same lyric and melody through all three arrangements.

## Implementation stages and acceptance gates

### Stage 1 — Source and engine proof
- Finalize licenses and exact source versions for piano, guitar, strings, bass, and drums.
- Record per-instrument asset sizes, sample counts, formats, checksums, and attributions.
- Implement a minimal sample loader/player with deterministic unit tests.
- Prove sample selection by note and velocity; test cache deduplication, decode errors, and cancellation.
- Do not replace the current playback path yet.

### Stage 2 — Instrument assets and sampler
- Package a compact, local sample subset with source licenses and attribution files.
- Implement SFZ-derived mapping data.
- Add lazy preloading, decoded-buffer cache limits, and offline cache strategy.
- Test the same notes at several velocities and across instrument ranges.

### Stage 3 — Composition integration
- Route melody/chords/bass/drums through the sample engine.
- Keep one shared AudioContext timeline, track mute/solo, and stop behavior.
- Implement piano/guitar/strings/bass/drum buses and per-track gain/pan/effects.
- Keep the lyric source and lyric selection data untouched.

### Stage 4 — A/B/C performance design
- Define instrument, articulation, velocity, rhythm, dynamics, and effect-send profiles per arrangement.
- Ensure A/B/C differ in audible performance, not only metadata or gain values.
- Keep the same lyric and note source for fair comparison.

### Stage 5 — Quality and device verification
- Add automated tests for mappings, loading, cache behavior, schedule timing, cancellation, and offline asset availability.
- Run browser tests on desktop and real iPhone Safari/PWA before calling the sound engine complete.
- Measure initial download size, decoded memory, startup time, concurrent voices, and CPU use.
- Listen for clicks, sample pitch artifacts, unnatural repeated samples, muddiness, clipping, and weak/overlong tails.

## Completion rule

The oscillator/noise preview is not an acceptable final instrument engine. A stage is complete only when its tests pass and its stated acceptance checks are evidenced. Automated tests alone do not prove musical quality; listening and iPhone verification remain separate gates.


## Rights and license compliance gate (mandatory)

No sample asset may be committed, hosted, bundled, transformed, or redistributed until its exact source file and applicable license have been verified.

1. **Source provenance**
   - Record the original repository, release/tag or immutable commit, exact asset path, source checksum, and retrieval date for every adopted asset.
   - A license for a repository, instrument collection, or neighboring folder must not be assumed to cover unrelated assets. Verify the license at the exact collection/file scope.
2. **License allowlist**
   - Prefer CC0 1.0 or another license whose commercial use, modification, and redistribution terms are explicitly compatible with this app.
   - CC BY assets may be used only when attribution, license link, change notices, and any other required notices are included in the app's credits and distribution package.
   - Do not adopt NC, ND, non-redistributable, unclear, or conflicting-license assets for the bundled sample library.
   - Do not treat "free download", "royalty-free", "open source", or public availability as permission to redistribute.
3. **Third-party code is separate from sample licenses**
   - Audit the runtime library's own license independently from the recordings and mappings.
   - Preserve required copyright notices and license texts for code dependencies.
   - Avoid GPL/AGPL dependencies unless compatibility is deliberately reviewed and approved; do not silently introduce copyleft obligations.
4. **Transformations**
   - Format conversion, trimming, normalization, resampling, compression, and derived sample generation are allowed only when the source license permits them.
   - Keep source and derived checksums plus a reproducible transformation record. Never remove required notices or misrepresent the original recording.
5. **Distribution**
   - Bundle only verified assets. Include a third-party notices/credits file and the relevant license texts in the deployed app.
   - Do not hotlink third-party sample URLs as a substitute for permission or as the final production delivery path.
   - If a license or provenance cannot be verified, exclude the asset and find a compliant alternative.
6. **Current verified candidate scope**
   - The Meta Open Sound repository README states that the Meta Piano, Meta Nylon Guitar, and Meta Steel Guitar collections are CC0 1.0; each collection also has its own LICENSE, README, manifest, checksums, and SFZ map. Verify the selected release and individual files/checksums again at asset-import time.
   - The same repository separately identifies the Oculus Audio Pack as CC BY 4.0. Its license must not be confused with the CC0 instrument collections; any Oculus asset requires its own attribution and notice review.
   - A candidate license check is not a final legal opinion. Record exact notices and retain the source license files in the project.

**Hard stop:** if an asset's redistribution rights are uncertain, do not import it. Sound quality targets never override this rule.


## Sample-engine implementation checkpoint (2026-11-20)

- Added `audio/sample-engine.js`: browser-native sample loader/player, explicit map validation, note/velocity selection, equal-power velocity-layer crossfades, first-position nylon-guitar string selection, guitar technique keyswitch selection, shared AudioContext scheduling, request deduplication, decoded-buffer cache, stop/dispose handling, and explicit missing-sample errors.
- Added `scripts/import-meta-open-sound.mjs`: immutable upstream revision, per-file SHA-256 verification, collection-level CC0 check, SFZ-derived mappings, and full piano/nylon OGG import. It also supports `--dry-run`.
- Added automated tests for velocity mapping/crossfades, guitar string selection, request deduplication, sample scheduling/transposition, missing assets, and disposal.
- CI dry-run verified 352 piano samples / 352 SFZ regions and 348 nylon-guitar sample files / 960 SFZ regions. All 94 regression tests passed at the latest verified run.
- The app now loads the sampler module, but it is **not yet the active composition playback backend**. The current oscillator/noise playback remains in place until local assets and instrument manifests are imported and integration is tested.

### Audio fidelity decision is still open

The official Meta Open Sound release publishes both web OGG and source WAV packages:

| Collection | OGG package | 24-bit / 48 kHz WAV package |
| --- | ---: | ---: |
| Meta Piano | 48.2 MB | 752.3 MB |
| Meta Nylon Guitar | 15.7 MB | 403.5 MB |
| Total | 63.9 MB | 1,155.8 MB |

The OGG files are official web-optimized previews; they are not the same source fidelity as the 24-bit / 48 kHz WAVs. Do not choose OGG as the final production format merely because it is smaller. Compare the actual rendered passages, transient quality, tails, CPU, decode memory, and iPhone playback before making the final decision. If OGG does not meet the musical quality target, evaluate lossless/high-quality delivery via separate asset hosting and lazy streaming rather than silently reducing sample quality or sample coverage.


## Composition sampler integration checkpoint (2026-11-21)

- Added a local-manifest loader to Composition Canvas for the Meta Piano and Meta Nylon Guitar collections.
- Added a sampled playback route for the existing melody, chord, and bass tracks. It uses the existing AudioContext clock, preserves track mute/solo selection, preloads the required mapped notes before scheduling, and calls the sampler's global stop path when preview playback is stopped.
- Added arrangement instrument/performance metadata:
  - A: nylon guitar melody + piano chords/bass; finger articulation request and short, warm release.
  - B: piano melody/chords/bass; stronger velocity and a wider/longer chord release.
  - C: soft piano melody/chords/bass; lower velocity and longer release tails.
- Drums are still generated by the existing temporary noise/oscillator preview. Strings, dedicated bass, and recorded drum samples have not yet been integrated. A/B/C therefore are not at the final instrument-palette acceptance gate.
- If local manifests or samples are absent, the current preview explicitly labels itself as a development synth preview and reports the sample-loading error; it does not claim that real samples played.
- Added regression coverage for the A/B/C sampled instrument profiles and the sampled playback route.
- GitHub Actions run for commit `ff1e3a308370dda3d3a491fd192452336209ba95` completed successfully: **96 tests passed, 0 failed**. The CI import step remains a dry run and verified 352 piano samples / 352 regions and 348 nylon-guitar samples / 960 regions. No sample audio files were downloaded or committed by that run.
- Remaining gates: run the checksum-verifying asset import, compare OGG against the 24-bit / 48 kHz WAV sources for actual rendered passages, integrate licensed strings/bass/drums, then validate on iPhone Safari/PWA and offline cache.


## Verified asset import and format-comparison checkpoint (2026-11-21)

- Successfully imported 352 piano OGG files and 348 nylon-guitar OGG files from the pinned CC0 source revision `514c926efecdb3c7812bf00eedf8e5c8d61dd681`.
- The import workflow checked the upstream SHA-256 for every file before writing it to the feature branch. It committed the generated manifests plus original LICENSE, source README, SFZ and checksum files. No asset files were added to `main`.
- Total OGG payload: 65,023,677 bytes (about 62.0 MiB).
- Added a CI regression that checks CC0 license text, manifest mapping counts, local file presence, and every sample's SHA-256 against the copied upstream checksum file. On commit `2a1597ea5fabb4e132ce8431c08012467302c085`, all **97 tests passed**.
- Official release metadata confirms the full-quality WAV masters are 24-bit / 48 kHz; official OGG files are web-preview encodings. A dedicated comparison workflow downloads the matching WAV releases and compares representative piano velocity layers plus nylon-guitar finger/pick layers after decoding both formats to common 48 kHz mono PCM. This technical comparison is not a substitute for listening to complete musical arrangements.
- Still pending: evaluate the WAV/OGG report, choose the delivery format without compromising audible quality, integrate licensed strings/bass/drums, and test real browser playback/offline/iPhone performance.


## OGG versus WAV technical comparison (2026-11-21)

Official Meta release assets identify the WAV masters as 24-bit / 48 kHz and describe OGG Vorbis as the web-preview format. The official piano WAV ZIP is 752,311,261 bytes; the nylon-guitar WAV ZIP is 423,127,309 bytes. The corresponding official OGG ZIPs are 48,182,366 and 16,483,193 bytes.

A GitHub Actions comparison decoded seven matching WAV/OGG sample pairs to 48 kHz mono float PCM and compared equal-length frames without loudness normalization or time shifting:

| Sample group | OGG/WAV level difference | Correlation | Gain-matched SNR |
|---|---:|---:|---:|
| Piano C4, four velocity layers | -0.003 to +0.016 dB | 0.99908–0.99985 | 27.33–35.23 dB |
| Nylon guitar E2, finger/pick layers | about -3.0 dB | 0.99922–0.99956 | 28.04–30.53 dB |

The guitar OGG previews are consistently about 3 dB quieter than the WAV masters in the tested E2 layers. The initial unadjusted SNR (~10.6 dB) includes this level offset; after mathematically matching the OGG gain to the WAV, the residual SNR is about 28–31 dB. This is a derived signal comparison, not a subjective listening result.

**Provisional decision:** OGG remains the current web-delivery candidate because the measured sample correlation is high and the payload is about 18 times smaller than the full WAV packages. It is not yet approved as the final sound-quality choice: compare complete A/B/C rendered passages, assess transient/decay perception, and decide whether the nylon-guitar level calibration is needed. Keep the 24-bit WAV source as the reference master.

## iPhone/PWA readiness audit

- Added `manifest.webmanifest`, PNG/SVG install icons, and root-page service-worker registration.
- Added a service worker that pre-caches only the app shell and sampler module. Instrument manifests use network-first with cached fallback; sample files under `audio/assets/` use cache-first after their first successful online fetch, including the 24-bit string WAVs.
- Cache cleanup is limited to cache names prefixed `music-suite-`, so unrelated PWA caches on the shared `norinori-jan.github.io` origin are preserved.
- Added CI checks for manifest registration, iPhone home-screen icon declaration, runtime-only audio caching, cross-app cache preservation, and imported sample integrity. The post-import regression run completed with **102 passed, 0 failed, 0 skipped**. It verifies all 336 imported bass/drum WAV files, including source licenses, pinned source hashes, converted WAV hashes, PCM headers and four-take round-robin groups.
- Imported CC0-1.0 VSCO 2 CE violin-section (30 zones) and cello-section (26 zones) samples as mono PCM 24-bit / 48 kHz WAV. The pinned source manifest SHA-256 and byte-size values are checked by CI.
- This is implementation and static CI coverage only. Real iPhone installation, first-play download, subsequent offline playback, storage quota behavior, and Safari audio decoding are still **not verified on a physical device**.
- OGG Vorbis support is available in iOS Safari 18.4 and later; older iOS Safari versions have partial or no support. The target device's exact OS and Web Audio `decodeAudioData` behavior must be verified before relying on OGG alone.
- Imported CC0-1.0 Karoryfer Swagbass (192 mapped samples) and Big Rusty Drums (144 mapped samples). All 336 source files were checked against pinned Git blob SHA-1 and SHA-256; all converted mono PCM 24-bit / 48 kHz WAV files have recorded SHA-256 values. The dedicated bass and drum tracks now use the sampled instruments, including four-take round-robin selection for each mapped velocity zone.
- Next: rerun the full regression suite against the committed 336 sample files (the prior run skipped the asset-integrity test because the separate import had not yet committed). Then render the same lyric/melody passage through A/B/C, compare full mixes and refine musical dynamics, articulations and balance. Keep all sample assets runtime-cached rather than precaching the entire library.
