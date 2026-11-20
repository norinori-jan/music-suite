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
