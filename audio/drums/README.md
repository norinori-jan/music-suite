# CC0 Drum Sample Kit

This directory pins a small, auditable subset of Virtuosity Drums for BEAT//LAB.

- Source repository: https://github.com/sfzinstruments/virtuosity_drums
- Pinned source commit: `9f04cf9a734527edfbb0a4eee1f674e45bbf71bc`
- License: CC0 1.0 Universal
- License text: https://github.com/sfzinstruments/virtuosity_drums/blob/9f04cf9a734527edfbb0a4eee1f674e45bbf71bc/LICENSE
- Per-file Git blob IDs and sample roles: [source-lock.json](./source-lock.json)

## Import and encode

Requirements: Node.js 20+ and FFmpeg available on PATH.

From the repository root:

```powershell
node scripts/import-cc0-drums.mjs --format=both
```

The importer downloads only the pinned files, verifies each Git blob SHA before conversion, and writes:

- `audio/drums/samples/*.wav`: 24-bit PCM, 48 kHz, mono
- `audio/drums/samples/*.ogg`: Ogg Vorbis quality 8, 48 kHz, mono
- `audio/drums/samples/manifest.json`: source SHA-256 and generated-output SHA-256 for every file

Use `--format=wav` or `--format=ogg` to generate one format. WAV is retained as the full-quality reference; OGG is provided for an explicit browser/PWA size and decode comparison, not as a replacement for the WAV master.

BEAT//LAB loads the selected local format only after the user presses **CC0ドラム音源を読み込む**. If the assets are not present or cannot be decoded, existing synthesized drums remain active. Do not remove the synth fallback.
