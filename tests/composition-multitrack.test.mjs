import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvasPath = path.join(here, "..", "apps", "composition-canvas.html");

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = nextName
    ? source.indexOf(`function ${nextName}(`, start + 1)
    : source.indexOf("\n}", start) + 2;
  assert.ok(end > start, `could not isolate function ${name}`);
  return source.slice(start, end);
}

async function loadCanvas() {
  return readFile(canvasPath, "utf8");
}

const sampleNotes = [
  { id: "n1", note: "C4", startBeat: 0, durationBeats: 0.5, word: "We", lyric: "We will rise", role: "LEAD", section: "Verse" },
  { id: "n2", note: "G4", startBeat: 1.5, durationBeats: 1, word: "rise", lyric: "We will rise", role: "LEAD", section: "Verse" }
];

test("MT-01 executes the lyric generator and creates three independent melody variants from one English source", async () => {
  const html = await loadCanvas();
  const code = extractFunction(html, "generateLyricMusicSketch", "renderCompositionArrangement");
  const values = {
    "lyric-key": "C",
    "lyric-mood": "bright",
    "lyric-progression": "pop",
    "note-sequence-bpm": "96"
  };
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: values[id] || "", style: {}, innerHTML: "" });
      return elements.get(id);
    }
  };
  const source = "We will rise tonight";
  const context = {
    document,
    window: {},
    lyricTextRead: () => source,
    lyricSectionsRead: () => [{ label: "Verse", role: "LEAD", text: source }],
    LYRIC_SCALES: { C: [0, 2, 4, 5, 7, 9, 11] },
    LYRIC_ROOTS: { C: 0 },
    LYRIC_PROGRESSIONS: { pop: [1, 5, 6, 4] },
    LYRIC_NOTE_NAMES: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
    buildSectionChordProgressions: () => [{
      label: "Verse",
      progression: [{ id: "ch-1", chord: "C", beats: 4, tones: [0, 4, 7] }]
    }],
    lyricEstimateSyllables: () => 1,
    resolveMelodyChordDegree: () => 1,
    makeMelodyNoteId: index => "note-" + index,
    renderGeneratedChordSections: () => {},
    renderCompositionArrangement: () => {},
    applySelectedComposition: () => true,
    escapeHtmlCanvas: value => value,
    showToast: () => {},
    Math, Number, String, Array, Object, Map
  };
  vm.runInNewContext(code + "\ngenerateLyricMusicSketch();", context);
  const variants = context.window.__compositionArrangement.melodyVariants;
  assert.deepEqual(Array.from(variants, variant => variant.id), ["hook", "rise", "arch"]);
  assert.equal(new Set(Array.from(variants, variant => variant.notes.map(note => note.note).join(","))).size, 3);
  for (const variant of variants) {
    assert.equal(variant.notes.length, 4);
    assert.deepEqual(Array.from(variant.notes, note => note.word), ["We", "will", "rise", "tonight"]);
    assert.equal(new Set(Array.from(variant.notes, note => note.id)).size, 4);
  }
  assert.equal(context.window.__compositionArrangement.selectedMelody, "hook");
});

test("MT-02 arrangement builds independent melody, chord, bass, drum and lyric tracks", async () => {
  const html = await loadCanvas();
  const code = extractFunction(html, "buildCompositionTracks", "setCompositionTrackMode");
  const context = {
    window: {
      __compositionArrangement: {
        chordSections: [{
          label: "Verse",
          progression: [{ id: "ch-1", chord: "C", beats: 4, tones: [0, 4, 7] }]
        }],
        selectedRhythm: "straight"
      }
    },
    lyricSectionsRead: () => [{ label: "Verse", role: "LEAD", text: "We will rise" }],
    lyricTextRead: () => "We will rise",
    Math, Number, String, Array, Map
  };
  vm.runInNewContext(code + "\nbuildCompositionTracks(" + JSON.stringify(sampleNotes) + ");", context);
  const tracks = context.window.__compositionArrangement.tracks;
  assert.deepEqual(Array.from(tracks, track => track.id), ["melody", "chords", "bass", "drums", "lyrics"]);
  assert.equal(tracks[0].notes.length, 2);
  assert.equal(tracks[1].notes[0].chord, "C");
  assert.equal(tracks[2].notes[0].midi, tracks[1].notes[0].pitches[0] - 12);
  assert.ok(Array.from(tracks[3].notes).some(note => note.kind === "kick"));
  assert.equal(tracks[4].notes[0].text, "We will rise");
});

test("MT-03 track builder preserves note start positions and durations", async () => {
  const html = await loadCanvas();
  const code = extractFunction(html, "buildCompositionTracks", "setCompositionTrackMode");
  const context = {
    window: { __compositionArrangement: { chordSections: [], selectedRhythm: "ballad" } },
    lyricSectionsRead: () => [{ label: "Verse", role: "LEAD", text: "We will rise" }],
    lyricTextRead: () => "We will rise",
    Math, Number, String, Array, Map
  };
  vm.runInNewContext(code + "\nbuildCompositionTracks(" + JSON.stringify(sampleNotes) + ");", context);
  const melody = context.window.__compositionArrangement.tracks[0].notes;
  const actual = Array.from(melody, note => [note.id, note.startBeat, note.durationBeats]);
  assert.deepEqual(actual, [["n1", 0, 0.5], ["n2", 1.5, 1]]);
});

test("MT-04 staff renderer emits five-line treble and bass notation with noteheads", async () => {
  const html = await loadCanvas();
  const positionCode = extractFunction(html, "midiStaffPosition", "renderTrackTimeline");
  const staffCode = extractFunction(html, "renderStaffSvg", "renderCompositionTracks");
  const context = {
    noteToMidi: note => ({ C4: 60, "F#4": 66, C2: 36 }[note] ?? 60),
    Math, Number, String, Array
  };
  vm.runInNewContext(positionCode + "\n" + staffCode, context);
  const melodySvg = vm.runInNewContext(
    "renderStaffSvg({id:'melody',name:'Melody',kind:'pitched',notes:[{note:'C4',startBeat:0,durationBeats:1}]},4)",
    context
  );
  const bassSvg = vm.runInNewContext(
    "renderStaffSvg({id:'bass',name:'Bass',kind:'pitched',notes:[{midi:36,startBeat:0,durationBeats:2}]},4)",
    context
  );
  assert.match(melodySvg, /𝄞/);
  assert.match(bassSvg, /𝄢/);
  assert.ok((melodySvg.match(/<line/g) || []).length >= 5);
  assert.match(melodySvg, /<ellipse/);
  assert.match(bassSvg, /<ellipse/);
});

test("MT-05 every pitched/percussion track gets an independent score lane; lyrics stay a lyric lane", async () => {
  const html = await loadCanvas();
  assert.match(html, /arrangement\.tracks\.forEach\(track=>/);
  assert.match(html, /renderTrackTimeline\(track,arrangement\.totalBeats\|\|4\)/);
  assert.match(html, /if\(track\.kind!=='lyrics'\)/);
  assert.match(html, /renderStaffSvg\(track,arrangement\.totalBeats\|\|4\)/);
  assert.match(html, /setCompositionTrackMode\(track\.id,'mute'\)/);
  assert.match(html, /setCompositionTrackMode\(track\.id,'solo'\)/);
});

test("MT-06 simultaneous playback schedules melody, chords, bass and drums against one shared clock", async () => {
  const html = await loadCanvas();
  const play = extractFunction(html, "playSelectedComposition", "buildCompositionTracks");
  assert.match(play, /start=ctx\.currentTime\+0\.08/);
  assert.match(play, /start\+n\.startBeat\*beatSeconds/);
  assert.match(play, /start\+chord\.startBeat\*beatSeconds/);
  assert.match(play, /start\+hit\.startBeat\*beatSeconds/);
  assert.match(play, /const melody=audible\.find/);
  assert.match(play, /const chords=audible\.find/);
  assert.match(play, /const bass=audible\.find/);
  assert.match(play, /const drums=audible\.find/);
  assert.match(play, /全トラック再生中/);
});

test("MT-07 mute and solo state are applied to the same simultaneous playback mix", async () => {
  const html = await loadCanvas();
  const play = extractFunction(html, "playSelectedComposition", "buildCompositionTracks");
  assert.match(play, /soloTracks=tracks\.filter\(t=>t\.kind!=='lyrics'&&t\.solo&&!t\.muted\)/);
  assert.match(play, /soloTracks\.length\?soloTracks:tracks\.filter\(t=>!t\.muted\)/);
  assert.match(html, /track\.muted=!track\.muted/);
  assert.match(html, /track\.solo=!track\.solo/);
});


test("MT-08 each melody card can select, apply and audition its own variant", async () => {
  const html = await loadCanvas();
  assert.match(html, /▶ この案を試聴/);
  assert.match(html, /previewCompositionVariant\(variant\.id\)/);
  const code = extractFunction(html, "previewCompositionVariant", "buildSelectedCompositionNotes");
  const calls = [];
  const context = {
    window: { __compositionArrangement: { selectedMelody: "hook", melodyVariants: [{ id: "hook" }, { id: "rise" }, { id: "arch" }] } },
    renderCompositionArrangement: () => calls.push("render"),
    applySelectedComposition: () => { calls.push("apply"); return true; },
    playSelectedComposition: async () => { calls.push("play"); },
    showToast: () => {},
    Array
  };
  const result = await vm.runInNewContext(code + "\npreviewCompositionVariant('rise');", context);
  assert.equal(result, true);
  assert.equal(context.window.__compositionArrangement.selectedMelody, "rise");
  assert.deepEqual(calls, ["render", "apply", "play"]);
});