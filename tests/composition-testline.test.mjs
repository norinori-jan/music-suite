import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "composition-testline-v1.json");
const canvasPath = path.join(here, "..", "apps", "composition-canvas.html");
const beatLabPath = path.join(here, "..", "apps", "beat-lab.html");
function round(value) {
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return round(value);
  return Object.fromEntries(
    Object.keys(value)
      .filter(key => !["exported", "updatedAt", "createdAt"].includes(key))
      .sort()
      .map(key => [key, normalize(value[key])])
  );
}

function compareProjects(before, after) {
  return JSON.stringify(normalize(before)) === JSON.stringify(normalize(after));
}

function validateFixture(project) {
  const errors = [];
  if (project.schemaVersion !== "composition-testline-v1") errors.push("schemaVersion");
  if (project.bpm !== 100 || project.timeSig !== 4 || project.div !== 16 || project.bars !== 32) errors.push("timeline metadata");
  const sections = project.arrangement?.sections || [];
  const expected = [[1,4],[5,12],[13,20],[21,28],[29,32]];
  if (sections.length !== expected.length) errors.push("section count");
  expected.forEach(([start,end], i) => {
    if (sections[i]?.startBar !== start || sections[i]?.endBar !== end) errors.push("section boundary " + i);
  });
  const melody = project.melody?.notes || [];
  const drums = project.drums?.notes || [];
  const melodyIds = melody.map(note => note.id);
  const drumIds = drums.map(note => note.id);
  if (melodyIds.some(id => !id) || new Set(melodyIds).size !== melodyIds.length) errors.push("melody IDs");
  if (drumIds.some(id => !id) || new Set(drumIds).size !== drumIds.length) errors.push("drum IDs");
  const lyricIds = new Set((project.lyrics?.sections || []).map(section => section.id));
  if (melody.some(note => !lyricIds.has(note.lyricId))) errors.push("lyric references");
  for (const [kind, notes] of [["melody", melody], ["drums", drums]]) {
    for (const note of notes) {
      if (!Number.isFinite(note.startBeat) || note.startBeat < 0) errors.push(kind + " startBeat");
      if (!Number.isFinite(note.durationBeats) || note.durationBeats <= 0) errors.push(kind + " durationBeats");
      if (note.startBeat + note.durationBeats > project.bars * project.timeSig) errors.push(kind + " end boundary");
    }
  }
  if (!project.lyrics?.sections?.every(section => section.text.split("\n").length >= 2)) errors.push("lyrics lines");
  return errors;
}

test("TL-01 standard fixture has a valid 32-bar timeline and stable IDs", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.deepEqual(validateFixture(project), []);
});

test("TL-10 JSON stringify/parse roundtrip preserves normalized project data", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  const restored = JSON.parse(JSON.stringify(project));
  assert.equal(compareProjects(project, restored), true);
});

test("TL-11 invalid timeline data is detected before import", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  project.melody.notes[0].startBeat = -1;
  assert.ok(validateFixture(project).includes("melody startBeat"));
});

test("TL-13 final-bar events remain within the 32-bar boundary", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  const lastMelody = project.melody.notes.at(-1);
  const lastDrum = project.drums.notes.at(-1);
  assert.equal(lastMelody.startBeat + lastMelody.durationBeats, 58);
  assert.equal(lastDrum.startBeat + lastDrum.durationBeats, 63.9);
  assert.ok(lastMelody.startBeat + lastMelody.durationBeats <= 128);
  assert.ok(lastDrum.startBeat + lastDrum.durationBeats <= 128);
});

test("TL-17 Canvas to BEAT//LAB payload carries baseline and return comparison", async () => {
  const canvas = await readFile(canvasPath, "utf8");
  const beatLab = await readFile(beatLabPath, "utf8");
  assert.match(canvas, /project\.roundTripBaseline=createCompositionSnapshot\(project\)/);
  assert.match(canvas, /localStorage\.setItem\('compositionRoundTripBaseline'/);
  assert.match(beatLab, /Object\.assign\(\{\},base/);
  assert.match(beatLab, /data\.fromBeatLab=true/);
  assert.match(canvas, /compareCompositionSnapshot\(project\.roundTripBaseline,project,\{allowedChanges:\['drums'\]\}\)/);
  assert.match(canvas, /往復比較OK/);
});

test("TL-18 snapshot comparator checks timeline, note IDs, lyric IDs and chords", async () => {
  const html = await readFile(canvasPath, "utf8");
  const start = html.indexOf("function normalizeCompositionValue");
  const end = html.indexOf("function midiToNoteName", start);
  assert.ok(start >= 0 && end > start, "snapshot normalization and comparison functions must exist");
  const helpers = new Function(html.slice(start,end) + "\nreturn {createCompositionSnapshot,compareCompositionSnapshot};")();
  const base = {
    projectId:"p1", bpm:100, timeSig:4, bars:8, div:16,
    melody:{notes:[{id:"n1",pitch:60,startBeat:0,durationBeats:1,lyricId:"l1"}]},
    lyricProject:{projectId:"p1",notes:[{id:"n1",lyricId:"l1",lyric:"hello",role:"A",section:"Verse"}]},
    chords:[{id:"c1",bar:1,chord:"C",beats:4}]
  };
  const snap = helpers.createCompositionSnapshot(base);
  assert.equal(helpers.compareCompositionSnapshot(snap,base).ok,true);
  const changed = structuredClone(base);
  changed.melody.notes[0].startBeat = 1;
  assert.ok(helpers.compareCompositionSnapshot(snap,changed).errors.includes("melody が保存前と一致しません"));
  const changedChord = structuredClone(base);
  changedChord.chords[0].chord = "Am";
  assert.ok(helpers.compareCompositionSnapshot(snap,changedChord).errors.includes("chords が保存前と一致しません"));
});

test("TL-19 JSON export stores a normalized baseline and import compares restored data", async () => {
  const beatLab = await readFile(beatLabPath, "utf8");
  assert.match(beatLab, /data\.jsonRoundTripBaseline=createJSONRoundTripSnapshot\(data\)/);
  assert.match(beatLab, /compareJSONRoundTripSnapshot\(data\.jsonRoundTripBaseline,restoredProject\)/);
  assert.match(beatLab, /JSON保存前と一致しません/);
  const start = beatLab.indexOf("function normalizeJSONRoundTripValue");
  const end = beatLab.indexOf("function exportJSON", start);
  assert.ok(start >= 0 && end > start, "JSON snapshot helpers must exist");
  const helpers = new Function(beatLab.slice(start,end) + "\nreturn {createJSONRoundTripSnapshot,compareJSONRoundTripSnapshot};")();
  const project = {
    bpm:100,timeSig:4,bars:8,div:16,
    lyrics:"line one\\nline two",
    sections:[{id:"verse",startBar:1,endBar:8}],
    melody:{notes:[{id:"m1",pitch:60,startBeat:0,durationBeats:1,lyricId:"l1"}]},
    drums:{notes:[{pitch:36,startBeat:0,durationBeats:0.2,vel:80}]},
    arrangement:{sections:[{id:"verse",startBar:1,endBar:8,effects:{}}]},
    chords:[{bar:1,chord:"C"}],bass:{notes:[]},rhythmVariations:[]
  };
  const baseline = helpers.createJSONRoundTripSnapshot(project);
  assert.equal(helpers.compareJSONRoundTripSnapshot(baseline,structuredClone(project)).ok,true);
  const changedDrum = structuredClone(project);
  changedDrum.drums.notes[0].vel = 70;
  assert.ok(helpers.compareJSONRoundTripSnapshot(baseline,changedDrum).errors.includes("drums がJSON保存前と一致しません"));
  const changedChord = structuredClone(project);
  changedChord.chords[0].chord = "Am";
  assert.ok(helpers.compareJSONRoundTripSnapshot(baseline,changedChord).errors.includes("chords がJSON保存前と一致しません"));
});

test("TL-20 BEAT//LAB drum edits are allowed but composition data remains unchanged", async () => {
  const html = await readFile(canvasPath, "utf8");
  const start = html.indexOf("function normalizeCompositionValue");
  const end = html.indexOf("function midiToNoteName", start);
  assert.ok(start >= 0 && end > start);
  const helpers = new Function(html.slice(start,end) + "\nreturn {createCompositionSnapshot,compareCompositionSnapshot};")();
  const project = {
    bpm:100,timeSig:4,bars:8,div:16,lyrics:"Verse line",
    sections:[{id:"verse",startBar:1,endBar:8,text:"Verse line"}],
    melody:{notes:[{id:"n1",pitch:60,startBeat:0,durationBeats:1,lyricId:"l1"}]},
    lyricProject:{projectId:"p1",notes:[{id:"n1",lyricId:"l1",lyric:"hello",role:"A",section:"Verse"}]},
    chords:[{id:"c1",bar:1,chord:"C"}],
    drums:{notes:[{pitch:36,startBeat:0,durationBeats:.25,vel:80}]}
  };
  const baseline = helpers.createCompositionSnapshot(project);
  const editedDrums = structuredClone(project);
  editedDrums.drums.notes[0].vel = 55;
  assert.equal(helpers.compareCompositionSnapshot(baseline,editedDrums,{allowedChanges:["drums"]}).ok,true);
  const changedMelody = structuredClone(editedDrums);
  changedMelody.melody.notes[0].pitch = 62;
  assert.ok(helpers.compareCompositionSnapshot(baseline,changedMelody,{allowedChanges:["drums"]}).errors.includes("melody が保存前と一致しません"));
  const changedLyrics = structuredClone(editedDrums);
  changedLyrics.lyrics = "Changed lyric";
  assert.ok(helpers.compareCompositionSnapshot(baseline,changedLyrics,{allowedChanges:["drums"]}).errors.includes("lyrics が保存前と一致しません"));
  const changedChord = structuredClone(editedDrums);
  changedChord.chords[0].chord = "Am";
  assert.ok(helpers.compareCompositionSnapshot(baseline,changedChord,{allowedChanges:["drums"]}).errors.includes("chords が保存前と一致しません"));
  assert.match(html,/allowedChanges:\['drums'\]/);
});

test("TL-21 JSON import retains chord progression from the saved project", async () => {
  const beatLab = await readFile(beatLabPath, "utf8");
  assert.match(beatLab,/window\.__compositionBaseProject=data/);
  assert.match(beatLab,/chords:\s*base\.chords\|\|base\.generatedMusic\?\.chords\|\|null/);
  assert.match(beatLab,/compareJSONRoundTripSnapshot\(data\.jsonRoundTripBaseline,restoredProject\)/);
  const start = beatLab.indexOf("function normalizeJSONRoundTripValue");
  const end = beatLab.indexOf("function exportJSON", start);
  const helpers = new Function(beatLab.slice(start,end) + "\nreturn {createJSONRoundTripSnapshot,compareJSONRoundTripSnapshot};")();
  const saved = {bpm:100,timeSig:4,bars:8,div:16,chords:[{bar:1,chord:"C"},{bar:2,chord:"Am"}]};
  const baseline = helpers.createJSONRoundTripSnapshot(saved);
  const restored = structuredClone(saved);
  assert.equal(helpers.compareJSONRoundTripSnapshot(baseline,restored).ok,true);
  restored.chords[1].chord = "F";
  assert.ok(helpers.compareJSONRoundTripSnapshot(baseline,restored).errors.includes("chords がJSON保存前と一致しません"));
});

test("TL-22 chord progression input wraps long text and provides copy actions", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /<textarea id="chord-progression-input"/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /onclick="copyChordProgression\(\)"/);
  assert.match(html, /async function copyChordText\(text,successMessage\)/);
  assert.match(html, /function copyChordProgression\(\)/);
  assert.match(html, /function parseChordProgressionText\(raw\)/);
});
