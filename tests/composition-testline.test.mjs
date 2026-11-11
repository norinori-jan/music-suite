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


test("TL-23 Canvas receives section-based chord progressions into the paste field", async () => {
  const canvas = await readFile(canvasPath, "utf8");
  assert.match(canvas,/payload\.generatedMusic\?\.chords\|\|payload\.chords/);
  assert.match(canvas,/if\(window\.__lyricMusicSketch\?\.chords\?\.length\)restoreChordProgressionInput/);
  const start = canvas.indexOf("function restoreChordProgressionInput(sketch)");
  const end = canvas.indexOf("function applyChordProgression", start);
  assert.ok(start >= 0 && end > start);
  const fakeInput = { value: "" };
  const fakeStatus = { textContent: "" };
  const fakeOutput = { value: "" };
  const fakePanel = { style: {} };
  const document = { getElementById(id) { return ({ "chord-progression-input":fakeInput,"chord-progression-status":fakeStatus,"lyric-generated-chord-output":fakeOutput,"lyric-generated-chord-panel":fakePanel })[id]||null; } };
  const restore = new Function("document","renderGeneratedChordSections",canvas.slice(start,end)+";return restoreChordProgressionInput;")(document,()=>{});
  restore({chords:{sections:[
    {tag:"Verse",progression:[{chord:"C"},{chord:"G"},{chord:"Am"},{chord:"Em"}]},
    {tag:"Chorus",progression:[{chord:"F"},{chord:"G"},{chord:"C"}]}
  ]}});
  assert.equal(fakeInput.value,"C, G, Am, Em, F, G, C");
  assert.match(fakeStatus.textContent,/受信しました/);
});

test("TL-24 generated chord progression is fully visible and selectable/copyable", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html,/id="lyric-generated-chord-panel"/);
  assert.match(html,/id="lyric-generated-chord-output"/);
  assert.match(html,/onclick="copyAllGeneratedChords\(\)"/);
  assert.match(html,/onclick="selectAllGeneratedChords\(\)"/);
  assert.match(html,/function copyAllGeneratedChords\(\)/);
  assert.match(html,/function selectAllGeneratedChords\(\)/);
  assert.match(html,/generatedOutput\.value=chordText/);
  assert.match(html,/generatedPanel\.style\.display='block'/);
  const start=html.indexOf("function selectAllGeneratedChords()");
  const end=html.indexOf("function copyChordPrompt()",start);
  assert.ok(start>=0&&end>start);
  const fake={value:"C, G, Am, F",focus(){this.focused=true},select(){this.selected=true},setSelectionRange(a,b){this.range=[a,b]}};
  const status={textContent:""};
  const document={getElementById(id){return id==="lyric-generated-chord-output"?fake:status}};
  const select=new Function("document",html.slice(start,end)+";return selectAllGeneratedChords;")(document);
  assert.equal(select(),true);
  assert.deepEqual(fake.range,[0,11]);
});

test("TL-25 lyric chord progression selector exposes ten distinct styles", async () => {
  const html = await readFile(canvasPath, "utf8");
  const selectStart = html.indexOf('<select id="lyric-progression">');
  const selectEnd = html.indexOf("</select>", selectStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  const options = [...html.slice(selectStart, selectEnd).matchAll(/<option value="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(options, ["pop","warm","sad","simple","rock","jazz","rb","cinematic","loop","surprise"]);
  const mapStart = html.indexOf("const LYRIC_PROGRESSIONS=");
  const mapEnd = html.indexOf(";", mapStart);
  const map = new Function(html.slice(mapStart, mapEnd + 1) + ";return LYRIC_PROGRESSIONS;")();
  assert.deepEqual(map.jazz,[2,5,1,6]);
  assert.deepEqual(map.rb,[1,3,6,2]);
  assert.deepEqual(map.rock,[1,4,6,5]);
  assert.deepEqual(map.loop,[1,5,6,3]);
  assert.deepEqual(map.surprise,[1,3,4,4]);
});

test("TL-26 diatonic triads use both third and fifth intervals for chord quality", async () => {
  const html = await readFile(canvasPath, "utf8");
  const scaleStart = html.indexOf("const LYRIC_NOTE_NAMES=");
  const scaleEnd = html.indexOf("function parseChordProgressionText", scaleStart);
  assert.ok(scaleStart >= 0 && scaleEnd > scaleStart);
  const source = html.slice(scaleStart, scaleEnd);
  const helpers = new Function(source + ";return {LYRIC_SCALES,LYRIC_ROOTS,LYRIC_NOTE_NAMES,buildDiatonicTriad};")();
  const cases = [
    ["C",1,"C","",[0,4,7]],["C",2,"D","m",[2,5,9]],["C",7,"B","dim",[11,2,5]],
    ["G",7,"F#","dim",[6,9,0]],["D",7,"C#","dim",[1,4,7]],
    ["A",1,"A","m",[9,0,4]],["A",2,"B","dim",[11,2,5]],["A",5,"E","m",[4,7,11]],
    ["E",2,"F#","dim",[6,9,0]]
  ];
  for (const [key,degree,root,quality,tones] of cases) {
    const chord=helpers.buildDiatonicTriad(key,degree);
    assert.equal(chord.root,root, key+" degree "+degree+" root");
    assert.equal(chord.quality,quality, key+" degree "+degree+" quality");
    assert.deepEqual(chord.tones,tones, key+" degree "+degree+" tones");
  }
  assert.throws(()=>helpers.buildDiatonicTriad("C",8));
});

test("TL-27 A, B, Chorus and Bridge can hold independent chord progressions", async () => {
  const html = await readFile(canvasPath, "utf8");
  for (const id of ["lyric-progression-a","lyric-progression-b","lyric-progression-chorus","lyric-progression-bridge"]) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/chordSections,chords:allSectionChords/);
  const start=html.indexOf("const LYRIC_NOTE_NAMES=");
  const end=html.indexOf("function parseChordProgressionText",start);
  const helpers=new Function(html.slice(start,end)+";return {LYRIC_PROGRESSIONS,buildSectionChordProgressions};")();
  const sections=[
    {role:"A",label:"Mia / A verse",text:"A verse"},
    {role:"B",label:"Ken / B verse",text:"B verse"},
    {role:"DUET",label:"Chorus",text:"Chorus"},
    {role:"DUET",label:"Bridge",text:"Bridge"}
  ];
  const result=helpers.buildSectionChordProgressions("C",sections,"pop",{
    "Mia / A verse":"warm","Ken / B verse":"sad","Chorus":"rock","Bridge":"jazz"
  });
  assert.deepEqual(result.map(s=>s.progression.map(c=>c.degree)),[
    [1,6,4,5],[6,4,1,5],[1,4,6,5],[2,5,1,6]
  ]);
  assert.equal(new Set(result.flatMap(s=>s.progression.map(c=>c.id))).size,16);
  assert.equal(result[2].progression[0].chord,"C");
  assert.equal(result[3].progression[0].chord,"Dm");
});

test("TL-28 generated melody degree follows its own lyric section chord progression", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("const LYRIC_NOTE_NAMES=");
  const end=html.indexOf("function parseChordProgressionText",start);
  const helpers=new Function(html.slice(start,end)+";return {LYRIC_PROGRESSIONS,buildDiatonicTriad,buildSectionChordProgressions,resolveMelodyChordDegree};")();
  const sections=[
    {role:"A",label:"Mia / A verse",text:"A"},
    {role:"B",label:"Ken / B verse",text:"B"},
    {role:"DUET",label:"Chorus",text:"Chorus"}
  ];
  const chords=helpers.buildSectionChordProgressions("C",sections,"pop",{
    "Mia / A verse":"warm","Ken / B verse":"sad","Chorus":"rock"
  });
  assert.deepEqual([0,4,8,12].map(i=>helpers.resolveMelodyChordDegree(chords,"Mia / A verse",i)),[1,6,4,5]);
  assert.deepEqual([0,4,8,12].map(i=>helpers.resolveMelodyChordDegree(chords,"Ken / B verse",i)),[6,4,1,5]);
  assert.deepEqual([0,4,8,12].map(i=>helpers.resolveMelodyChordDegree(chords,"Chorus",i)),[1,4,6,5]);
});

test("TL-29 pasted melody accepts note-only and explicit-duration formats", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function parseNoteSequenceText(raw)");
  const end=html.indexOf("\nfunction stopNoteSequence",start);
  assert.ok(start>=0&&end>start);
  const parser=new Function("noteToMidi",html.slice(start,end)+";return parseNoteSequenceText;")(
    note=>{const m=note.match(/^([A-G]#?)(-?\d+)$/);return m?60:NaN;}
  );
  assert.deepEqual(parser("C4, E4, G4, D4"),[
    {note:"C4",length:1},{note:"E4",length:1},{note:"G4",length:1},{note:"D4",length:1}
  ]);
  assert.deepEqual(parser("C4×4, E4-2, G4*0.5"),[
    {note:"C4",length:4},{note:"E4",length:2},{note:"G4",length:0.5}
  ]);
  assert.deepEqual(parser("C4\nE4\nG4"),[
    {note:"C4",length:1},{note:"E4",length:1},{note:"G4",length:1}
  ]);
  assert.throws(()=>parser("H4"));
});
test("TL-30 generated chord output stays inside the visible copy panel", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/id="lyric-generated-chord-panel"[^>]*style="display:none/);
  assert.match(html,/id="lyric-generated-chord-output"[^>]*wrap="soft"/);
  assert.match(html,/onclick="copyAllGeneratedChords\(\)"/);
  assert.match(html,/onclick="selectAllGeneratedChords\(\)"/);
  assert.match(html,/overflow-wrap:anywhere/);
  assert.match(html,/function generateLyricMusicSketch\(\)[\s\S]*?generatedOutput\)generatedOutput\.value=chordText/);
});

test("TL-31 chord sketch is displayed separately for A, B, Chorus and Bridge", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/id="lyric-generated-chord-breakdown"/);
  assert.match(html,/function renderGeneratedChordSections\(chordSections\)/);
  assert.match(html,/renderGeneratedChordSections\(chordSections\)/);
  assert.match(html,/item\.tones/);
  assert.match(html,/全区間をつないだ1行/);
  assert.match(html,/renderGeneratedChordSections\(restoredSections\)/);
});
test("TL-32 generated lyric melody has non-overlapping one-beat note starts", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/return \{id:makeMelodyNoteId\(i\),note,length:1,[\s\S]*?startBeat:i,/);
  assert.match(html,/const chordIndex=Math\.floor\(Math\.max\(0,localIndex\)\/4\)%section\.progression\.length/);
});
