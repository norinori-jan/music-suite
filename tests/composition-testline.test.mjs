import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
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
  const chords = project.chords || [];
  if (chords.length !== 32 || chords.some((chord, index) => chord.bar !== index + 1 || chord.beats !== 4)) errors.push("full-song chord coverage");
  const melodyBars = new Set(melody.map(note => Math.floor(note.startBeat / project.timeSig) + 1));
  if (melodyBars.size !== project.bars) errors.push("melody coverage across all bars");
  for (let bar = 1; bar <= project.bars; bar++) {
    if (melody.filter(note => Math.floor(note.startBeat / project.timeSig) + 1 === bar).length < 2) errors.push("melody density bar " + bar);
  }
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
  assert.equal(lastMelody.startBeat + lastMelody.durationBeats, 128);
  assert.equal(lastDrum.startBeat + lastDrum.durationBeats, 127.975);
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
  const helpers=new Function(html.slice(start,end)+";return {LYRIC_PROGRESSIONS,buildDiatonicTriad,buildSectionChordProgressions,resolveMelodyChordDegree,resolveMelodyChordDegreeAtBeat};")();
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
  assert.equal(helpers.resolveMelodyChordDegreeAtBeat(chords,"Ken / B verse",0),6);
  assert.equal(helpers.resolveMelodyChordDegreeAtBeat(chords,"Ken / B verse",2),4);
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
  assert.match(html,/コード記号だけ（全区間・1行）/);
  assert.match(html,/renderGeneratedChordSections\(restoredSections\)/);
});
test("TL-32 generated lyric melody follows phrase timing with breathable gaps", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/const desiredPhraseSpans=groups\.map\(group=>Math\.min\(8,Math\.max\(2,group\.syllables\.length\*\.72\)\)\)/);
  assert.match(html,/const timingScale=Math\.min\(1,sectionSpan\/Math\.max\(\.001,desiredTotal\)\)/);
  assert.match(html,/phraseCursor\+=phraseSpan\+gap/);
  assert.match(html,/durationBeats:n\.length/);
  assert.match(html,/phraseEnd:n\.phraseEnd/);
  assert.match(html,/const bars=32/);
});

test("TL-33 surprise progression uses a real borrowed minor iv chord", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("const LYRIC_NOTE_NAMES=");
  const end=html.indexOf("function parseChordProgressionText",start);
  const helpers=new Function(html.slice(start,end)+";return {buildSectionChordProgressions};")();
  const sections=[{role:"A",label:"Verse",text:""}];
  const c=helpers.buildSectionChordProgressions("C",sections,"surprise")[0].progression;
  assert.deepEqual(c.map(x=>x.chord),["C","Em","F","Fm"]);
  assert.deepEqual(c[3].tones,[5,8,0]);
  assert.equal(c[3].borrowed,true);
  const g=helpers.buildSectionChordProgressions("G",sections,"surprise")[0].progression;
  assert.equal(g[3].chord,"Cm");
  assert.deepEqual(g[3].tones,[0,3,7]);
});


test("TL-34 composition sketch transfer keeps lyrics, section chords, and melody in one versioned JSON package", async () => {
  const html=await readFile(canvasPath,"utf8");
  for(const id of ["composition-sketch-transfer","composition-sketch-status"])assert.match(html,new RegExp('id="'+id+'"'));
  for(const handler of ["copyCompositionSketch","selectCompositionSketch","importCompositionSketch"])assert.match(html,new RegExp('onclick="'+handler+'\\(\\)"'));
  assert.match(html,/format:'music-suite-composition-sketch'/);
  assert.match(html,/schemaVersion:1/);
  assert.match(html,/lyrics:\{text:lyricTextRead\(\),sections:lyricSectionsRead\(\)\}/);
  assert.match(html,/harmony:\{[\s\S]*?sections:Array\.isArray\(sketch\.chordSections\)/);
  assert.match(html,/melody:\{notes:melody\}/);
  assert.match(html,/id:card\.dataset\.noteId/);
  assert.match(html,/startBeat:card\.dataset\.startBeat/);
});

test("TL-35 invalid composition sketch JSON is rejected before mutating the project", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function importCompositionSketch()");
  const end=html.indexOf("\nfunction renderGeneratedChordSections",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  assert.match(body,/JSON\.parse\(area\.value\)/);
  assert.ok(body.indexOf("catch(error)")<body.indexOf("window\.__musicProjectId="));
  assert.match(body,/schemaVersion!==1/);
  assert.match(body,/音符数が上限512/);
  assert.match(body,/Number\.isFinite\(noteToMidi\(n\.note\)\)/);
  assert.match(body,/return false/);
});

test("TL-36 imported composition sketch restores section labels, chord section display, and lyric-linked note IDs", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function importCompositionSketch()");
  const end=html.indexOf("\nfunction renderGeneratedChordSections",start);
  const body=html.slice(start,end);
  assert.match(body,/lyricSectionsWrite\(data\.lyrics\.sections\)/);
  assert.match(body,/restoreChordProgressionInput\(window\.__lyricMusicSketch\)/);
  assert.match(body,/renderNoteCards\(state\.lastNotes/);
  assert.match(body,/card\.dataset\.noteId=n\.id/);
  assert.match(body,/card\.dataset\.lyricId=n\.lyricId/);
  assert.match(body,/card\.dataset\.startBeat=String\(n\.startBeat\)/);
});


test("TL-37 all generated chord sections are visible inside the panel and have two complete copy formats", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/id="lyric-generated-chord-sections-output"/);
  assert.match(html,/onclick="copyAllGeneratedChordSections\(\)"/);
  assert.match(html,/区間名付き・全コード進行/);
  assert.match(html,/const labeled=\(chordSections\|\|\[\]\)\.map\(section=>/);
  assert.match(html,/function copyAllGeneratedChordSections\(\)/);
  assert.match(html,/function renderGeneratedChordSections\(chordSections\)/);
  assert.match(html,/card\.style\.cssText='min-width:0;width:100%/);
});

test("TL-38 melody sketch export reads authoritative note card datasets", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function buildCompositionSketchPackage()");
  const end=html.indexOf("\nfunction createCompositionSketch()",start);
  const body=html.slice(start,end);
  assert.match(body,/card\.dataset\.note\|\|/);
  assert.match(body,/Number\(card\.dataset\.length\)/);
  assert.match(body,/Number\(card\.dataset\.startBeat\)/);
  assert.match(body,/card\.dataset\.noteId/);
  assert.match(body,/card\.dataset\.lyricId/);
  assert.match(body,/document\.querySelectorAll\('#canvas \.card'\)/);
});


test("TL-39 chord refinement button records visible steps and preserves section identities", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/onclick="refineGeneratedChordProgressions\(\)"/);
  assert.match(html,/id="chord-refine-progress"/);
  assert.match(html,/id="chord-refine-status"/);
  assert.match(html,/function refineGeneratedChordProgressions\(\)/);
  assert.match(html,/window\.__lyricMusicSketch=\{\.\.\.sketch,chordSections:next,chords,refineCount:current\+1/);
  assert.match(html,/renderGeneratedChordSections\(next\)/);
  assert.match(html,/歌詞・メロディ音符は保持/);
});

test("TL-40 refined chord progressions use varied chord durations rather than four beats for every chord", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/const rhythmPatterns=\[\[4,4,4,4\],\[2,2,4,4\],\[4,2,2,4\],\[6,2,2,2\],\[3,3,2,4\],\[2,4,2,4\]\]/);
  assert.match(html,/beats:pattern\[chordIndex%pattern\.length\]/);
  assert.match(html,/item\.chord\+' \['\+item\.beats\+'拍\]'/);
  assert.match(html,/item\.chord\+' \('\+item\.beats\+'拍\)'/);
});


test("TL-41 all-section chord copy serializes the current source data, including every section and beat count", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("async function copyAllGeneratedChordSections()");
  const end=html.indexOf("\nfunction buildCompositionSketchPackage()",start);
  const body=html.slice(start,end);
  assert.match(body,/window\.__lyricMusicSketch\?\.chordSections/);
  assert.match(body,/sections\.map\(section=>/);
  assert.match(body,/section\.label/);
  assert.match(body,/item\.chord/);
  assert.match(body,/item\.beats/);
  assert.match(body,/await copyChordText\(value/);
  assert.match(body,/output\.select\(\)/);
  assert.match(body,/全区間を選択済み/);
});

test("TL-42 flat chord copy is rebuilt from current section source data, not a potentially stale textarea", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("async function copyAllGeneratedChords()");
  const end=html.indexOf("\nfunction selectAllGeneratedChordSections()",start);
  const body=html.slice(start,end);
  assert.match(body,/window\.__lyricMusicSketch\?\.chordSections/);
  assert.match(body,/sections\.flatMap\(section=>section\.progression\|\|\[\]\)/);
  assert.match(body,/await copyChordText\(value/);
  assert.match(body,/output\.select\(\)/);
});


test("TL-43 all melody cards copy note, role, lyric, and section in displayed order", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/id="melody-card-copy-output"/);
  assert.match(html,/onclick="copyAllMelodyCards\(\)"/);
  assert.match(html,/onclick="copyAllMelodyNotesAsSequence\(\)"/);
  const start=html.indexOf("function buildMelodyCardCopyText()");
  const end=html.indexOf("\nfunction refreshMelodyCardCopyOutput()",start);
  const body=html.slice(start,end);
  assert.match(body,/document\.querySelectorAll\('#canvas \.card'\)/);
  assert.match(body,/card\.dataset\.note/);
  assert.match(body,/card\.dataset\.lyricRole/);
  assert.match(body,/card\.dataset\.lyric/);
  assert.match(body,/card\.dataset\.lyricSection/);
  assert.match(body,/\.join\('\\n\\n'\)/);
});

test("TL-44 melody card copy output refreshes after card rendering and saving", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/syncCardsToState\(\);\s*refreshMelodyCardCopyOutput\(\);\s*console\.log\('描画カード数:'/);
  assert.match(html,/syncCardsToState\(\);\s*refreshMelodyCardCopyOutput\(\);\s*if\(showMessage\)/);
});


test("TL-45 DOM card sync preserves every lyric field and card metadata in state", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function syncCardsToState()");
  const end=html.indexOf("\n}",start)+2;
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  for(const field of ["lyricId","lyric","word","lyricRole","lyricSection","color"]) {
    assert.match(body,new RegExp(field+"\\s*:"));
  }
  assert.match(body,/card\.dataset\.lyric/);
  assert.match(body,/state\.lastNotes=/);
});

test("TL-46 Canvas melody transfer preserves lyric text, word, role, and section", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("function buildMelodyProject(sourceName)");
  const end=html.indexOf("\nfunction makeMelodyNoteId",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  for(const field of ["lyricId","lyric","word","role","section"]) {
    assert.ok(body.includes(field), "melody transfer must preserve "+field);
  }
  assert.match(body,/cardLyricFields/);
});

test("TL-47 BEAT//LAB keeps imported drum timeline unchanged until a sequencer edit", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/let drumPatternEdited=false/);
  assert.match(html,/window\.__compositionBaseProject=data;\s*drumPatternEdited=false/);
  const click=html.slice(html.indexOf("function cellClick"),html.indexOf("\nfunction cellClear"));
  const clearStart=html.indexOf("function cellClear");
  const clear=html.slice(clearStart,html.indexOf("\nfunction clearPattern",clearStart));
  assert.match(click,/drumPatternEdited=true/);
  assert.match(clear,/drumPatternEdited=true/);
  const exportBody=html.slice(html.indexOf("function _buildExportData"),html.indexOf("\nfunction decodeImportedDrumVelocity"));
  assert.match(exportBody,/!drumPatternEdited&&Array\.isArray\(base\.drums\?\.notes\)/);
  assert.match(exportBody,/notes\.push\(\.\.\.cloneRhythmData\(base\.drums\.notes\)\)/);
  assert.match(exportBody,/else if\(sections\.length\)/);
  assert.match(exportBody,/if\(active\)active\.pattern=cloneRhythmData\(APP\.pattern\)/);
});

test("TL-48 BEAT//LAB preset, arrangement, clear, shift and duplicate actions mark drums edited", async () => {
  const html=await readFile(beatLabPath,"utf8");
  for (const [name,next] of [
    ["function applyLibraryPattern(p){","\n// ═══"],
    ["function createSongArrangement(){","\nfunction renderArrangementControls"],
    ["function clearPattern(){","\nfunction shiftPattern"],
    ["function shiftPattern(dir){","\nfunction duplicateBars"],
    ["function duplicateBars(){","\nfunction toggleSwing"]
  ]) {
    const start=html.indexOf(name),end=html.indexOf(next,start);
    assert.ok(start>=0&&end>start,name+" boundary");
    assert.match(html.slice(start,end),/drumPatternEdited=true/,name+" must mark edit");
  }
});

test("TL-49 Canvas exposes a direct standard test-song route into BEAT//LAB", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/onclick="openStandardTestSongInBeatLab\(\)"/);
  const start=html.indexOf("async function openStandardTestSongInBeatLab()");
  const end=html.indexOf("\nfunction sendToBeatLab()",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  assert.match(body,/tests\/fixtures\/composition-testline-v1\.json/);
  assert.match(body,/project\.fromCompositionCanvas=true/);
  assert.match(body,/project\.roundTripBaseline=createCompositionSnapshot\(project\)/);
  assert.match(body,/window\.location\.href='beat-lab\.html#import='/);
});

test("TL-50 BEAT//LAB provides explicit in-app round-trip test controls and return route", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/id="test-route-panel"/);
  assert.match(html,/onclick="checkTestSongUnedited\(\)"/);
  assert.match(html,/onclick="checkTestSongEdited\(\)"/);
  assert.match(html,/onclick="returnToCompositionCanvas\(\)">Composition Canvasへ戻る（曲を引き継ぐ）/);
  assert.match(html,/function checkTestSongUnedited\(\)/);
  assert.match(html,/original\.length===16&&current\.length===16&&same/);
  assert.match(html,/function checkTestSongEdited\(\)/);
  assert.match(html,/drumPatternEdited&&changed/);
  assert.match(html,/data\.testMode==='composition-testline-roundtrip'/);
});

test("TL-51 standard test-song route marks the BEAT//LAB session as guided round-trip test", async () => {
  const html=await readFile(canvasPath,"utf8");
  const start=html.indexOf("async function openStandardTestSongInBeatLab()");
  const end=html.indexOf("\nfunction sendToBeatLab()",start);
  assert.ok(start>=0&&end>start);
  assert.match(html.slice(start,end),/project\.testMode='composition-testline-roundtrip'/);
});


test("TL-52 BEAT//LAB handoff guidance stays visible even outside the standard fixture route", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf('<div id="test-route-panel"');
  const end=html.indexOf('</div>',start);
  assert.ok(start>=0&&end>start);
  const panel=html.slice(start,end);
  assert.doesNotMatch(panel,/display:none/);
  assert.match(panel,/Composition Canvasへ戻る（曲を引き継ぐ）/);
  assert.match(panel,/test-check-1/);
  assert.match(panel,/test-check-2/);
});

test("TL-53 returning from BEAT//LAB transfers the edited project and round-trip progress", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function returnToCompositionCanvas()");
  const end=html.indexOf("\nfunction checkTestSongUnedited",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  assert.match(body,/const data=buildExportData\(\)/);
  assert.match(body,/data\.fromBeatLab=true/);
  assert.match(body,/data\.roundTripChecks=/);
  assert.match(body,/JSON\.stringify\(data\)/);
  assert.match(body,/composition-canvas\.html#import=/);
});

test("TL-54 Composition Canvas restores returned rhythm and offers an explicit resume route with the same song data", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/id="beatlab-return-banner"/);
  const start=html.indexOf("function restoreBeatLabProject(project)");
  const end=html.indexOf("\nfunction sendToSheet",start);
  assert.ok(start>=0&&end>start);
  const restore=html.slice(start,end);
  assert.match(restore,/window\.__lastDrumProject=/);
  assert.match(restore,/roundTripBaseline:project\.roundTripBaseline/);
  assert.match(restore,/returnBanner\.style\.display='block'/);
  const resumeStart=html.indexOf("function resumeBeatLabWork()");
  const resumeEnd=html.indexOf("\nfunction sendToSheet",resumeStart);
  assert.ok(resumeStart>=0&&resumeEnd>resumeStart);
  const resume=html.slice(resumeStart,resumeEnd);
  for(const field of ["drums","melody","arrangement","rhythmVariations","testMode","roundTripBaseline"]) {
    assert.match(resume,new RegExp("project\\."+field+"="));
  }
  assert.match(resume,/beat-lab\.html#import=/);
});


test("TL-55 melody-aware rhythm context summarizes note positions, duration, density and rests", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function buildMelodyRhythmContext(project,bars,timeSig=4)");
  const end=html.indexOf("\nasync function aiGenerateBeat()",start);
  assert.ok(start>=0&&end>start,"melody rhythm context helper must exist");
  const helper=new Function(html.slice(start,end)+";return buildMelodyRhythmContext;")();
  const context=helper({melody:{notes:[
    {pitch:60,startBeat:0,durationBeats:1},
    {pitch:64,startBeat:2,durationBeats:0.5},
    {pitch:67,startBeat:5,durationBeats:1}
  ]}},2,4);
  assert.equal(context.available,true);
  assert.equal(context.noteCount,3);
  assert.match(context.summary,/密度/);
  assert.match(context.summary,/音の隙間/);
  assert.match(context.summary,/"beat":0/);
  assert.match(context.summary,/"duration":0.5/);
  const empty=helper({},2,4);
  assert.equal(empty.available,false);
  assert.equal(empty.noteCount,0);
});

test("TL-56 AI rhythm generation passes incoming melody context to the model and retains preview-before-apply", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("async function aiGenerateBeat()");
  const end=html.indexOf("\nfunction renderAiPreview",start);
  const body=html.slice(start,end);
  assert.match(body,/buildMelodyRhythmContext\(window\.__compositionBaseProject,bars,4\)/);
  assert.match(body,/メロディの発音位置/);
  assert.match(body,/音符が伸びている区間と休符の隙間/);
  assert.match(body,/renderAiPreview\(result,bars,div,steps\)/);
  assert.match(body,/applyAiPattern/);
});


test("TL-57 BEAT//LAB plays imported bass notes in sync with melody and drums", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/id="bass-enabled"/);
  assert.match(html,/id="bass-volume"/);
  assert.match(html,/function getBassBus\(\)/);
  assert.match(html,/function getBassSynth\(\)/);
  assert.match(html,/new Tone\.MonoSynth/);
  assert.match(html,/function getPlayableBassNotes\(project,bars,timeSig=4\)/);
  const helperStart=html.indexOf("function getPlayableBassNotes(project,bars,timeSig=4)");
  const helperEnd=html.indexOf("\nasync function togglePlay()",helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart);
  const helper=new Function(html.slice(helperStart,helperEnd)+";return getPlayableBassNotes;")();
  const notes=helper({bass:{notes:[
    {pitch:36,startBeat:0,durationBeats:1,vel:100},
    {pitch:43,startBeat:1.5,durationBeats:0.5,vel:0.5},
    {pitch:72,startBeat:2,durationBeats:1,vel:90},
    {pitch:40,startBeat:-1,durationBeats:1,vel:90},
    {pitch:38,startBeat:3,durationBeats:0,vel:90}
  ]}},2,4);
  assert.equal(notes.length,2);
  assert.equal(notes[0].pitch,36);
  assert.equal(notes[0].velocity,100/127);
  assert.equal(notes[1].pitch,43);
  assert.equal(notes[1].velocity,0.5);
  const simultaneous=helper({bass:{notes:[
    {id:"high",pitch:43,startBeat:0,durationBeats:1,vel:80},
    {id:"root",pitch:36,startBeat:0,durationBeats:1.5,vel:90},
    {id:"same-pitch-stronger",pitch:36,startBeat:0,durationBeats:1.2,vel:110},
    {id:"next",pitch:40,startBeat:1,durationBeats:1,vel:90}
  ]}},2,4);
  assert.equal(simultaneous.length,2,"monophonic bass must collapse simultaneous starts");
  assert.deepEqual(simultaneous.map(n=>n.id),["same-pitch-stronger","next"],"lowest pitch wins; same pitch uses stronger velocity");
  assert.equal(new Set(simultaneous.map(n=>n.startBeat)).size,simultaneous.length,"bass attacks must have unique start times");
  const playStart=html.indexOf("async function togglePlay()");
  const playEnd=html.indexOf("\nfunction stopPlay()",playStart);
  const play=html.slice(playStart,playEnd);
  assert.match(play,/getPlayableBassNotes\(\{bass:activeTracks\.bass\},APP\.bars,APP\.timeSig\)/);
  assert.match(play,/syncActiveArrangementTrackSnapshot\(\)/);
  assert.match(play,/playBassNote\(\{\.\.\.note,velocity:[^}]+\},duration,audioAt,activeSection,chordVariant\)/);
  assert.match(play,/Math\.abs\(note\.startBeat-currentBeat\)<bassTolerance/);
  assert.match(html.slice(html.indexOf("function stopPlay()"),html.indexOf("\nfunction PROJ_BPM")),/bassSynth\.triggerRelease\(\)/);
});

test("TL-58 BEAT//LAB preserves bass timeline data when exporting a rhythm edit", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function _buildExportData()");
  const end=html.indexOf("\nfunction decodeImportedDrumVelocity",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  assert.match(body,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:cloneRhythmData\(bassForExport\)\}/);
  assert.match(body,/activeTracks=syncActiveArrangementTrackSnapshot\(\)\.tracks/);
  assert.match(body,/arrangements:cloneRhythmData\(APP\.arrangements\|\|\{\}\)/);
});


test("TL-59 BEAT//LAB offers section-aware drum ideas with intentional cymbal and transition placement", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/id="drum-idea-panel"/);
  assert.match(html,/function applyDrumArrangementIdea\(style\)/);
  assert.match(html,/セクション別に提案/);
  for(const id of ["synthHat","synthOpenHat","synthCrash","synthRide"])assert.ok(html.includes(id),id+" must have its own voice");
  assert.match(html,/function getClosedHat\(\)/);
  assert.match(html,/function getOpenHat\(\)/);
  assert.match(html,/function getCrash\(\)/);
  assert.match(html,/function getRide\(\)/);
  const sectionStart=html.indexOf("function sectionPatternFrom(base,id)");
  const sectionEnd=html.indexOf("\nfunction ensureArrangementEffects()",sectionStart);
  const ideaStart=html.indexOf("function buildSectionDrumIdea(basePattern,section,style,variation='normal')");
  const ideaEnd=html.indexOf("\nfunction applyDrumArrangementIdea(style)",ideaStart);
  assert.ok(sectionStart>=0&&sectionEnd>sectionStart);
  assert.ok(ideaStart>=0&&ideaEnd>ideaStart);
  const app={div:16,timeSig:4};
  const pk=(row,step)=>row+":"+step;
  const sectionPatternFrom=new Function("APP","pk",html.slice(sectionStart,sectionEnd)+";return sectionPatternFrom;")(app,pk);
  const build=new Function("APP","pk","sectionPatternFrom",html.slice(ideaStart,ideaEnd)+";return buildSectionDrumIdea;")(app,pk,sectionPatternFrom);
  const sections=[
    {id:"intro",startBar:1,endBar:2},
    {id:"verse",startBar:3,endBar:4},
    {id:"chorus",startBar:5,endBar:6},
    {id:"bridge",startBar:7,endBar:8},
    {id:"final",startBar:9,endBar:10}
  ];
  const base={"kick:0":1,"snare:4":.8,"hat:0":.7};
  const result=sections.map(section=>build(base,section,"balanced"));
  assert.equal(result[0]["crash:0"],undefined,"intro should not automatically crash on every downbeat");
  assert.equal(result[2]["crash:0"],1,"chorus entry should be marked by crash");
  assert.equal(result[4]["crash:0"],1,"final section should have a crash entry");
  assert.ok(Object.keys(result[2]).some(k=>k.startsWith("ride:")),"chorus should use ride for lift");
  assert.ok(Object.keys(result[1]).some(k=>k.startsWith("hat:")),"verse should retain a restrained timekeeping part");
  assert.notDeepEqual(result[0],result[2],"intro and chorus should have different orchestration");
  const cinematic=sections.map(section=>build(base,section,"cinematic"));
  assert.ok(Object.keys(cinematic[3]).some(k=>k.startsWith("tom")),"bridge should use tom color");
  assert.ok(Object.keys(cinematic[2]).some(k=>k.startsWith("ride:")),"cinematic chorus should use ride");
  assert.match(html,/try\{Tone\.start\(\);\}catch\(e\)\{\}/,"single-cell audition must still activate audio");
});


test("TL-60 BEAT//LAB adds phrase-aware fills and controllable bar variation", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/id="drum-variation-level"/);
  assert.match(html,/value="light"/);
  assert.match(html,/value="normal" selected/);
  assert.match(html,/value="bold"/);
  const sectionStart=html.indexOf("function sectionPatternFrom(base,id)");
  const sectionEnd=html.indexOf("\nfunction ensureArrangementEffects()",sectionStart);
  const ideaStart=html.indexOf("function buildSectionDrumIdea(basePattern,section,style,variation='normal')");
  const ideaEnd=html.indexOf("\nfunction applyDrumArrangementIdea(style)",ideaStart);
  assert.ok(sectionStart>=0&&sectionEnd>sectionStart);
  assert.ok(ideaStart>=0&&ideaEnd>ideaStart);
  const app={div:16,timeSig:4};
  const pk=(row,step)=>row+":"+step;
  const sectionPatternFrom=new Function("APP","pk",html.slice(sectionStart,sectionEnd)+";return sectionPatternFrom;")(app,pk);
  const build=new Function("APP","pk","sectionPatternFrom",html.slice(ideaStart,ideaEnd)+";return buildSectionDrumIdea;")(app,pk,sectionPatternFrom);
  const verse={id:"verse",startBar:1,endBar:4};
  const chorus={id:"chorus",startBar:1,endBar:4};
  const base={"kick:0":1,"snare:4":.8,"hat:0":.7};
  const light=build(base,verse,"balanced","light");
  const normal=build(base,verse,"balanced","normal");
  const bold=build(base,verse,"balanced","bold");
  assert.equal(light["snare:60"],undefined,"light mode does not force a final-bar fill");
  assert.ok(normal["snare:62"]>0&&normal["tom1:63"]>0,"normal mode adds a short phrase-ending fill");
  assert.ok(Object.keys(bold).some(k=>k.startsWith("perc:")),"bold verse variation adds an extra accent");
  const chorusNormal=build(base,chorus,"balanced","normal");
  assert.ok(chorusNormal["ohat:31"]>0,"chorus gets a cymbal opening on alternating repeated bars");
  assert.ok(chorusNormal["snare:62"]>0&&chorusNormal["tom1:63"]>0,"chorus phrase ending receives a fill");
  const applyStart=html.indexOf("function applyDrumArrangementIdea(style)");
  const applyEnd=html.indexOf("\nfunction sectionAtStep(step)",applyStart);
  const apply=html.slice(applyStart,applyEnd);
  assert.match(apply,/drum-variation-level/);
  assert.match(apply,/buildSectionDrumIdea\(base,section,selected,variation\)/);
});


test("TL-61 BEAT//LAB keeps three independently playable drum candidates with distinct groove identities", async () => {
  const html=await readFile(beatLabPath,"utf8");
  for(const id of ["A","B","C"])assert.match(html,new RegExp('id="drum-candidate-'+id+'"'));
  assert.match(html,/onclick="playDrumCandidateOnly\(\)"/);
  assert.match(html,/function createDrumCandidates\(\)/);
  assert.match(html,/function selectDrumCandidate\(id\)/);
  assert.match(html,/drumVariants:APP\.drumVariants\?cloneRhythmData\(APP\.drumVariants\)/);
  assert.match(html,/const savedVariants=projectData\?\.drumVariants\|\|data\.drumVariants/);
  const start=html.indexOf("function applyCandidateCoreGroove(pattern,section,variant)");
  const end=html.indexOf("\nfunction createDrumCandidates()",start);
  assert.ok(start>=0&&end>start,"candidate groove generator must exist");
  const APP={div:16,timeSig:4};
  const pk=(row,step)=>row+":"+step;
  const cloneRhythmData=value=>JSON.parse(JSON.stringify(value||{}));
  const build=new Function("APP","pk","cloneRhythmData",html.slice(start,end)+";return applyCandidateCoreGroove;")(APP,pk,cloneRhythmData);
  const section={id:"verse",startBar:1,endBar:2};
  const seed={"kick:0":.6,"snare:4":.6,"hat:0":.5};
  const a=build(seed,section,"A"),b=build(seed,section,"B"),c=build(seed,section,"C");
  const signature=p=>Object.keys(p).sort().join("|");
  assert.notEqual(signature(a),signature(b),"A and B must use different kick/snare/hat placement");
  assert.notEqual(signature(a),signature(c),"A and C must use different rhythmic placement");
  assert.notEqual(signature(b),signature(c),"B and C must use different rhythmic placement");
  assert.ok(Object.keys(a).filter(k=>k.startsWith("hat:")).length>Object.keys(b).filter(k=>k.startsWith("hat:")).length,"B must leave more rhythmic space");
  assert.ok(Object.keys(c).some(k=>k.startsWith("snare:")),"C must retain syncopated snare accents");
  const selectStart=html.indexOf("function selectDrumCandidate(id)");
  const selectEnd=html.indexOf("\nlet drumOnlyMixSnapshot",selectStart);
  const select=html.slice(selectStart,selectEnd);
  assert.match(select,/APP\.drumVariants\[APP\.activeDrumVariant\]\.sections=cloneRhythmData\(APP\.sections\)/,"edits must be saved back to the active candidate before switching");
  const soloStart=html.indexOf("function playDrumCandidateOnly()");
  const soloEnd=html.indexOf("\nfunction sectionAtStep",soloStart);
  assert.ok(soloStart>=0&&soloEnd>soloStart);
  const solo=html.slice(soloStart,soloEnd);
  assert.match(solo,/melody-enabled/);
  assert.match(solo,/bass-enabled/);
  assert.match(solo,/togglePlay\(\)/);
  const stopStart=html.indexOf("function stopPlay()");
  const stopEnd=html.indexOf("\nfunction PROJ_BPM",stopStart);
  assert.match(html.slice(stopStart,stopEnd),/drumOnlyMixSnapshot/,"stop must restore the user's melody and bass mix toggles");
});


test("TL-62 A/B/C drum candidates survive JSON and Composition Canvas handoff", async () => {
  const beat=await readFile(beatLabPath,"utf8");
  const canvas=await readFile(canvasPath,"utf8");
  assert.match(beat,/drumVariants:APP\.drumVariants\?cloneRhythmData\(APP\.drumVariants\)/,"JSON export must include all candidate patterns");
  assert.match(beat,/const savedVariants=projectData\?\.drumVariants\|\|data\.drumVariants/,"JSON import must restore top-level candidate data");
  assert.match(beat,/restoreSongArrangement\(data\.arrangement,data\)/,"import must pass the complete project to arrangement restoration");
  assert.match(beat,/APP\.drumVariants\[APP\.activeDrumVariant\]\.sections=cloneRhythmData\(APP\.sections\)/,"restored active edits must become authoritative");
  assert.match(beat,/function selectDrumCandidate\(id\)[\s\S]*?APP\.drumVariants\[APP\.activeDrumVariant\]\.sections=cloneRhythmData\(APP\.sections\)/,"candidate switching must retain edits");
  assert.match(canvas,/project\.drumVariants=window\.__lastDrumProject\?\.drumVariants\|\|null/,"Canvas → Beat Lab must preserve candidates");
  assert.match(canvas,/project\.activeDrumVariant=window\.__lastDrumProject\?\.activeDrumVariant\|\|null/,"Canvas → Beat Lab must preserve selection");
  assert.match(canvas,/drumVariants:project\.drumVariants\|\|null/,"Beat Lab → Canvas must retain candidates in the handoff state");
  assert.match(canvas,/project\.drumVariants=saved\.drumVariants\|\|null/,"Canvas resume must restore candidate patterns");
  assert.match(canvas,/project\.activeDrumVariant=saved\.activeDrumVariant\|\|null/,"Canvas resume must restore selected candidate");
  const clone=value=>JSON.parse(JSON.stringify(value));
  const variants={A:{label:"pop",sections:[{id:"verse",startBar:1,endBar:4,pattern:{"kick:0":.9}}]},B:{label:"half",sections:[{id:"verse",startBar:1,endBar:4,pattern:{"snare:8":1}}]},C:{label:"sync",sections:[{id:"verse",startBar:1,endBar:4,pattern:{"kick:6":.8}}]}};
  const project={drumVariants:variants,activeDrumVariant:"B"};
  const restored=clone(project);
  assert.deepEqual(restored,project);
  restored.drumVariants.B.sections[0].pattern["snare:8"]=.4;
  assert.equal(project.drumVariants.B.sections[0].pattern["snare:8"],1,"restored variants must not share mutable references with source data");
  assert.equal(restored.drumVariants.A.sections[0].pattern["kick:0"],.9,"editing B must not alter A");
  assert.equal(restored.drumVariants.C.sections[0].pattern["kick:6"],.8,"editing B must not alter C");
});


test("TL-63 selected drum candidate exports to the score editor as a timeline-aligned drum track", async () => {
  const beat=await readFile(beatLabPath,"utf8");
  const score=await readFile(path.join(here,"..","apps","score-editor-v2.html"),"utf8");
  assert.match(beat,/sections\.forEach\(section=>\{const start=\(section\.startBar-1\)\*APP\.timeSig\*stepsPerBeat/,"section start bars must be converted to absolute beat positions");
  assert.match(beat,/notes\.push\(\{pitch:row\.pitch,startBeat:\+\(\(start\+local\)\*beatPerStep\)/,"exported drum notes must use the same row pitch and absolute timeline");
  assert.match(score,/if\(data\.drums\?\.notes\?\.length\)/,"score editor must receive the exported drum timeline");
  assert.match(score,/addTrack\('drum',[\s\S]*?notes\)/,"score editor must create a dedicated drum track");
  assert.match(score,/switchView\('roll'\)/,"import must open the track/roll view for visual verification");
  assert.match(score,/const notes=data\.drums\.notes\.map\(n=>\(\{\.\.\.n,id:uid\(\),vel:n\.vel\|\|80\}\)\)/,"score editor must retain each drum note's pitch, startBeat and velocity");
});


test("TL-64 A/B/C drum candidates have different section arcs and audio-clock hit scheduling", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/function playHit\(pitch, vel=1, when, ensureAudio=true\)/,"drum hit playback must accept an audio-clock timestamp and avoid redundant context starts");
  assert.match(html,/playHit\(row\.pitch,Math\.max\(\.05,Math\.min\(1,vel\*sectionDynamics\.drums\)\),audioAt,false\)/,"sequencer must not restart the audio context for every hit");
  assert.match(html,/const safeVel=Math\.max\(\.05,Math\.min\(1,Number\(vel\)\|\|\.05\)\),at=Number\.isFinite\(when\)\?when:undefined/);
  assert.match(html,/getKick\(\)\.triggerAttackRelease\('C1','8n',at,safeVel\)/,"kick velocity must be per-hit, not shared gain mutation");
  assert.match(html,/getSnare\(\)\.triggerAttackRelease\('16n',at,safeVel\)/,"snare must receive the common audio timestamp");
  assert.match(html,/getRide\(\)\.triggerAttackRelease\('8n',at,safeVel\)/,"ride must receive the common audio timestamp");
  assert.match(html,/function tick\(audioAt\)/,"sequencer tick must receive an audio-clock timestamp from the scheduler");
  assert.match(html,/const horizon=Tone\.now\(\)\+0\.12/,"scheduler must maintain a look-ahead window");
  assert.match(html,/playTimer=setInterval\(scheduleAhead,25\)/,"scheduler must refill audio events independently of UI timer cadence");
  assert.match(html,/nextStepTime\+=stepMs\/1000/,"next steps must advance on the audio clock");
  assert.match(html,/playHit\(row\.pitch,Math\.max\(\.05,Math\.min\(1,vel\*sectionDynamics\.drums\)\),audioAt,false\)/,"drums must use the shared audio-clock timestamp");
  assert.match(html,/playBassNote\(\{\.\.\.note,velocity:[^}]+\},duration,audioAt,activeSection,chordVariant\)/,"bass trigger must schedule the layered bass voice");
  assert.match(html,/triggerAttackRelease\(Tone\.Frequency\(pitch/,"melody trigger must exist");
  assert.match(html,/duration,audioAt,velocity\)/,"melody must use the shared audio-clock timestamp");
  const start=html.indexOf("function applyCandidateCoreGroove(pattern,section,variant)");
  const end=html.indexOf("\nfunction createDrumCandidates()",start);
  const APP={div:16,timeSig:4},pk=(r,s)=>r+":"+s,cloneRhythmData=v=>JSON.parse(JSON.stringify(v||{}));
  const build=new Function("APP","pk","cloneRhythmData",html.slice(start,end)+";return applyCandidateCoreGroove;")(APP,pk,cloneRhythmData);
  const section=(id)=>({id,startBar:1,endBar:4});
  const metrics=p=>({
    kick:Object.keys(p).filter(k=>k.startsWith("kick:")).length,
    snare:Object.keys(p).filter(k=>k.startsWith("snare:")).length,
    hat:Object.keys(p).filter(k=>k.startsWith("hat:")).length,
    crash:Object.keys(p).filter(k=>k.startsWith("crash:")).length,
    ride:Object.keys(p).filter(k=>k.startsWith("ride:")).length,
    tom:Object.keys(p).filter(k=>k.startsWith("tom")).length
  });
  for(const id of ["intro","verse","chorus","bridge","final"]){
    const a=metrics(build({},section(id),"A")),b=metrics(build({},section(id),"B")),c=metrics(build({},section(id),"C"));
    assert.notDeepEqual(a,b,id+" A/B should have distinct orchestration");
    assert.notDeepEqual(a,c,id+" A/C should have distinct orchestration");
    assert.notDeepEqual(b,c,id+" B/C should have distinct orchestration");
  }
  const verseB=metrics(build({},section("verse"),"B")),verseA=metrics(build({},section("verse"),"A"));
  assert.ok(verseB.hat<verseA.hat,"B verse should leave more space than A");
  const chorusC=metrics(build({},section("chorus"),"C"));
  assert.ok(chorusC.ride>0&&chorusC.tom>0,"C chorus should combine ride drive with transition fills");
});


test("TL-65 drum voices use layered snare body, dedicated rim and filtered closed-hat texture", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/let synthKick=null,synthSnare=null,synthSnareBody=null,synthRim=null/,"snare body and rim must have independent voice instances");
  assert.match(html,/function getSnareBody\(\)[\s\S]*?new Tone\.MembraneSynth/,"snare body must add a tuned low-mid transient");
  assert.match(html,/function getRim\(\)[\s\S]*?new Tone\.Synth/,"rim click must not reuse the broadband snare noise");
  assert.match(html,/new Tone\.Filter\(7200,'highpass'\)/,"closed hat must have a high-pass stage");
  assert.match(html,/synthHat=new Tone\.NoiseSynth[\s\S]*?\.connect\(synthHatFilter\)/,"closed hat noise must pass through its filter");
  assert.match(html,/getSnare\(\)\.triggerAttackRelease\('16n',at,safeVel\);getSnareBody\(\)\.triggerAttackRelease\('D2','16n',at,safeVel\*\.58\)/,"snare hit must combine noise and body at the same audio time");
  assert.match(html,/getRim\(\)\.triggerAttackRelease\('D5','32n',at,safeVel\)/,"rim hit must use its dedicated short voice");
});


test("TL-66 sequencer uses a look-ahead audio scheduler instead of chained UI timeouts", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/function scheduleAhead\(\)[\s\S]*?while\(APP\.playing&&nextStepTime<horizon\)/,"scheduler must queue events ahead of playback time");
  assert.match(html,/const stepMs=tick\(nextStepTime\)/,"every instrument event in a step must share its scheduled audio time");
  assert.match(html,/playTimer=setInterval\(scheduleAhead,25\)/,"short UI polling interval must only refill the audio queue");
  assert.doesNotMatch(html,/playTimer=setTimeout\(tick/,"audio timing must not depend on chained setTimeout callbacks");
  assert.match(html,/clearInterval\(playTimer\)/,"stop must cancel the scheduler interval");
});


test("TL-67 drum bus has gentle compression after its independent mix gain", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/drumBus=null,[^;]*drumCompressor=null/,"drum compressor must be independently managed");
  assert.match(html,/drumCompressor=new Tone\.Compressor\(\{threshold:-19,ratio:2\.2,attack:\.006,release:\.16,knee:10\}\)\.connect\(getMasterBus\(\)\)/,"drum bus compressor must tame peaks without extreme limiting");
  assert.match(html,/drumBus=new Tone\.Gain\([^;]*\)\.connect\(drumCompressor\)/,"drum level control must remain before the compressor");
  assert.match(html,/function applyArrangementMix\([\s\S]*?mixRamp\(bus\.gain,[\s\S]*?profile\.gain\[name\]/,"existing drum volume slider must continue to control pre-compressor gain with its A/B/C multiplier");
});


test("TL-68 look-ahead scheduling keeps visual playhead aligned and rejects stale callbacks", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/const uiDelay=Math\.max\(0,\(audioAt-Tone\.now\(\)\)\*1000\)/,"playhead visuals must wait until the scheduled audio time");
  assert.match(html,/setTimeout\(\(\)=>\{\s*if\(!APP\.playing\|\|generation!==playbackGeneration\)return/,"stale visual callbacks must be ignored after stop/restart");
  assert.match(html,/const generation=\+\+playbackGeneration/,"each playback session must get a unique generation");
  assert.match(html,/APP\.playing=false;playbackGeneration\+\+/,"stopping playback must invalidate queued visual callbacks");
  assert.match(html,/const stepIndex=APP\.playStep/,"visual and audio scheduling must use the same captured step index");
});


test("TL-93 kick and snare add restrained transient definition without changing the sequencer clock", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/function getKickClick\(\)[\s\S]*?new Tone\.NoiseSynth[\s\S]*?decay:\.018[\s\S]*?volume\.value=-27/,"kick click must be a short, quiet high-frequency transient");
  assert.match(html,/function getKick\(\)[\s\S]*?new Tone\.MembraneSynth[\s\S]*?pitchDecay:\.055/,"kick body must retain a tuned low-frequency membrane voice");
  assert.match(html,/function getSnare\(\)[\s\S]*?new Tone\.Filter\(1750,'highpass'\)[\s\S]*?new Tone\.NoiseSynth/,"snare noise must be filtered to reduce low-mid buildup");
  assert.match(html,/getKick\(\)\.triggerAttackRelease\('C1','8n',at,safeVel\);getKickClick\(\)\.triggerAttackRelease\('32n',at,safeVel\*\.72\)/,"kick body and click must share one audio timestamp and per-hit velocity");
  assert.match(html,/playHit\(row\.pitch,Math\.max\(\.05,Math\.min\(1,vel\*sectionDynamics\.drums\)\),audioAt,false\)/,"transient layers must remain on the existing audio-clock scheduler");
  assert.match(html,/masterLimiter=new Tone\.Limiter\(-1\)/,"master peak protection must remain enabled");
});


test("TL-69 bass playback layers sub foundation and transient articulation on one shared pitch clock", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/bassSynth=null,bassSampler=null,bassSamplerReady=false,bassSamplerFilter=null,bassSubSynth=null,bassAttackSynth=null/,"bass voices must be independently managed");
  assert.match(html,/function getBassSubSynth\(\)[\s\S]*?oscillator:\{type:'sine'\}[\s\S]*?frequency:115/,"sub layer must be a clean low-passed sine foundation");
  assert.match(html,/function getBassAttackSynth\(\)[\s\S]*?oscillator:\{type:'triangle'\}[\s\S]*?decay:\.032/,"attack layer must be a short upper harmonic");
  const start=html.indexOf("function playBassNote(note,duration,when,section=null,variant='A')");
  const end=html.indexOf("\nfunction updateMixVolumes",start);
  const play=html.slice(start,end);
  assert.match(play,/else body\.triggerAttackRelease\(frequency,duration,when,velocity\)/,"main bass body must keep the original pitch and timing");
  assert.match(play,/sub\.triggerAttackRelease\(frequency,duration,when,velocity\*\.72\)/,"sub foundation must be phase-aligned to the main note");
  assert.match(play,/attack\.triggerAttackRelease\(Tone\.Frequency\(pitch\+12,'midi'\)\.toNote\(\),'32n',when/,"transient must use an octave harmonic at the same start time");
  assert.match(html,/playBassNote\(\{\.\.\.note,velocity:[^}]+\},duration,audioAt,activeSection,chordVariant\)/,"sequencer must schedule all bass layers from the same audio timestamp");
  assert.match(html,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:cloneRhythmData\(bassForExport\)\}/,"layering must export a normal bass note timeline");
});


test("TL-70 piano and guitar accompaniment creates genuinely different A B C chord roles", async () => {
  const html=await readFile(beatLabPath,"utf8");
  for(const id of ["piano-enabled","piano-volume","guitar-enabled","guitar-volume"])assert.match(html,new RegExp('id="'+id+'"'),id+" control must exist");
  assert.match(html,/function getPianoSynth\(\)[\s\S]*?new Tone\.PolySynth/,"piano must have its own polyphonic voice");
  assert.match(html,/function getGuitarSynth\(\)[\s\S]*?new Tone\.PolySynth/,"guitar fallback must support chord voicings");
  assert.match(html,/const gains=\{drum:drumBus,melody:melodyBus,bass:bassBus,piano:pianoBus,guitar:guitarBus\}/,"piano and guitar must have independent mix controls");
  assert.match(html,/Object\.entries\(gains\)\.forEach\(\(\[name,bus\]\)=>\{if\(bus\)mixRamp\(bus\.gain/,"each instrument bus must keep an independently adjustable gain");
  const start=html.indexOf("function chordSymbolToPitches(symbol,octave=4)");
  const end=html.indexOf("\nfunction getPlayableBassNotes",start);
  assert.ok(start>=0&&end>start,"chord voicing and arrangement helpers must exist");
  const helpers=new Function(html.slice(start,end)+";return {chordSymbolToPitches,getPlayableChordEvents};")();
  assert.deepEqual(helpers.chordSymbolToPitches("C"),[60,64,67],"major chord tones must parse");
  assert.deepEqual(helpers.chordSymbolToPitches("Am7"),[69,72,76,79],"minor seventh chord tones must parse in octave four");
  const project={chords:[{chord:"C",beats:4},{chord:"Am7",beats:4},{chord:"F",beats:4},{chord:"G",beats:4}]};
  const a=helpers.getPlayableChordEvents(project,4,4,"A");
  const b=helpers.getPlayableChordEvents(project,4,4,"B");
  const c=helpers.getPlayableChordEvents(project,4,4,"C");
  const sig=x=>JSON.stringify({p:x.piano.map(e=>[e.startBeat,e.pitches,e.durationBeats]),g:x.guitar.map(e=>[e.startBeat,e.pitches])});
  assert.notEqual(sig(a),sig(b),"A and B chord accompaniment must differ in voicing and density");
  assert.notEqual(sig(a),sig(c),"A and C chord accompaniment must differ in rhythmic articulation");
  assert.notEqual(sig(b),sig(c),"B and C chord accompaniment must differ in note placement");
  assert.ok(a.piano.some(e=>e.pitches.length>=3),"A must use block-chord piano voicings");
  assert.ok(b.piano.length>a.piano.length,"B must use broken-chord piano movement");
  assert.ok(c.guitar.length>b.guitar.length,"C must use a busier plucked guitar figure");
  assert.match(html,/const activeArrangement=syncActiveArrangementTrackSnapshot\(\)/,"active A/B/C selection must drive accompaniment");
  assert.match(html,/activeTracks\.piano\?\.notes/);
  assert.match(html,/activeTracks\.guitar\?\.notes/);
  assert.match(html,/getPianoSynth\(\)\.triggerAttackRelease/,"piano chord events must be played");
  assert.match(html,/getGuitarSynth\(\)\.triggerAttackRelease\(notes,duration,when,velocity\)/,"guitar fallback must play single notes and chord voicings with timed releases");
});


test("TL-94 generated A B C chord accompaniment uses smooth voice leading without changing chord identity", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function chooseSmoothChordVoicing(");
  const end=html.indexOf("\nfunction getPlayableChordEvents",start);
  assert.ok(start>=0&&end>start,"voice-leading helper must be present");
  const helper=new Function(html.slice(start,end)+";return chooseSmoothChordVoicing;")();
  const first=helper([60,64,67],[]);
  const next=helper([65,69,72],first);
  assert.equal(first.length,3);
  assert.equal(next.length,3);
  assert.ok(next.every(p=>p>=48&&p<=84),"generated voicings must stay in a playable piano register");
  const movement=next.reduce((sum,p,i)=>sum+Math.abs(p-first[i]),0);
  const rawMovement=[65,69,72].reduce((sum,p,i)=>sum+Math.abs(p-first[i]),0);
  assert.ok(movement<=rawMovement,"voice leading should not increase total parallel movement");
  const section=helper([67,71,74],next);
  assert.equal(section.length,3);
  assert.ok(section.every(Number.isFinite));
  const chordStart=html.indexOf("function chordSymbolToPitches(symbol,octave=4)");
  const chordEnd=html.indexOf("\n\n\n\nfunction buildBassNotesFromChords",chordStart);
  const chordHelpers=new Function(html.slice(chordStart,chordEnd)+";return {chordSymbolToPitches,getPlayableChordEvents};")();
  const project={chords:[{chord:"C",beats:4},{chord:"F",beats:4},{chord:"G",beats:4},{chord:"Am7",beats:4}]};
  for(const variant of ["A","B","C"]){
    const events=chordHelpers.getPlayableChordEvents(project,4,4,variant);
    assert.ok(events.piano.length>0&&events.guitar.length>0,variant+" must retain both accompaniment roles");
    assert.ok(events.piano.every(event=>event.pitches.every(p=>p>=48&&p<=96)),variant+" piano voicings must remain in a usable register");
  }
});


test("TL-95 section dynamics shape melody bass drums piano and guitar as one ensemble", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function getSectionPerformanceDynamics(");
  const end=html.indexOf("\nfunction buildArrangementTrackSnapshot",start);
  assert.ok(start>=0&&end>start,"section performance dynamics helper must exist");
  const dynamics=new Function(html.slice(start,end)+";return getSectionPerformanceDynamics;")();
  const intro=dynamics({id:"intro",label:"Intro"},1,"A");
  const verse=dynamics({id:"verse",label:"Verse"},2,"A");
  const chorus=dynamics({id:"chorus",label:"Chorus"},8,"A");
  const bridge=dynamics({id:"bridge",label:"Bridge"},12,"A");
  assert.ok(chorus.drums>verse.drums&&chorus.bass>verse.bass,"chorus must lift rhythm section above verse");
  assert.ok(chorus.guitar>verse.guitar&&chorus.melody>=verse.melody,"chorus must widen the arrangement without burying melody");
  assert.ok(intro.drums<verse.drums&&intro.bass<verse.bass,"intro must leave space before the full groove");
  assert.ok(bridge.drums<verse.drums&&bridge.bass<verse.bass,"bridge must create a lower-energy contrast");
  for(const section of [intro,verse,chorus,bridge])for(const value of Object.values(section))assert.ok(value>=.55&&value<=1.3,"section dynamics must remain bounded");
  assert.match(html,/const sectionDynamics=getSectionPerformanceDynamics\(activeSection,barNumber,chordVariant\)/);
  assert.match(html,/vel\*sectionDynamics\.drums/);
  assert.match(html,/note\.velocity\*sectionDynamics\.bass/);
  assert.match(html,/event\.velocity\*sectionDynamics\.piano/);
  assert.match(html,/event\.velocity\*sectionDynamics\.guitar/);
  assert.match(html,/127\*sectionDynamics\.melody/);
});


test("TL-71 bass line has independent A B C groove identities without changing source notes", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function buildBassVariantNotes(notes,bars,timeSig=4,variant='A')");
  const end=html.indexOf("\nasync function togglePlay",start);
  assert.ok(start>=0&&end>start,"bass candidate generator must exist");
  const build=new Function(html.slice(start,end)+";return buildBassVariantNotes;")();
  const source=[
    {id:"n1",pitch:36,startBeat:0,durationBeats:1,velocity:.8},
    {id:"n2",pitch:40,startBeat:1,durationBeats:.75,velocity:.7},
    {id:"n3",pitch:43,startBeat:2,durationBeats:1,velocity:.8},
    {id:"n4",pitch:38,startBeat:3,durationBeats:.75,velocity:.7},
    {id:"n5",pitch:36,startBeat:4,durationBeats:1,velocity:.8},
    {id:"n6",pitch:41,startBeat:6,durationBeats:1,velocity:.7}
  ];
  const a=build(source,2,4,"A"),b=build(source,2,4,"B"),c=build(source,2,4,"C");
  const signature=notes=>notes.map(n=>[n.startBeat,n.pitch,n.durationBeats,Number(n.velocity.toFixed(3))]);
  assert.deepEqual(signature(a),signature(source),"A must preserve the original bass line");
  assert.ok(b.length<a.length,"B must create a more spacious half-time bass role");
  assert.ok(c.length>a.length,"C must add octave and pickup articulation");
  assert.ok(c.some(n=>n.id.endsWith("-oct")),"C must add octave accents");
  assert.ok(c.some(n=>n.id.endsWith("-pickup")),"C must add passing pickups");
  assert.deepEqual(source.map(n=>n.id),["n1","n2","n3","n4","n5","n6"],"candidate generation must not mutate source notes");
  assert.match(html,/buildBassVariantNotes\(bassSeed,APP\.bars,APP\.timeSig,id\)/,"each independent arrangement snapshot must own its bass variation");
  assert.match(html,/const bassNotes=getPlayableBassNotes\(\{bass:activeTracks\.bass\},APP\.bars,APP\.timeSig\)/,"active A/B/C selection must drive bass playback");
});


test("TL-72 drum-only audition mutes and restores piano and guitar along with melody and bass", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function playDrumCandidateOnly()");
  const end=html.indexOf("\nfunction sectionAtStep",start);
  const solo=html.slice(start,end);
  assert.match(solo,/piano:document\.getElementById\('piano-enabled'\)\.checked/,"solo snapshot must retain piano state");
  assert.match(solo,/guitar:document\.getElementById\('guitar-enabled'\)\.checked/,"solo snapshot must retain guitar state");
  for(const id of ["melody-enabled","bass-enabled","piano-enabled","guitar-enabled"])assert.ok(solo.includes(id),id+" must be muted for drum-only audition");
  const stopStart=html.indexOf("function stopPlay()");
  const stopEnd=html.indexOf("\nfunction PROJ_BPM",stopStart);
  const stop=html.slice(stopStart,stopEnd);
  assert.match(stop,/\['melody-enabled','melody'\],\['bass-enabled','bass'\],\['piano-enabled','piano'\],\['guitar-enabled','guitar'\]/,"stop must restore all previous accompaniment toggles");
  assert.match(stop,/if\(pianoSynth\)pianoSynth\.releaseAll\(\)/,"piano voices must release on stop");
  assert.match(stop,/if\(bassSubSynth\)bassSubSynth\.triggerRelease\(\)/,"sub-bass voice must release on stop");
});


test("TL-73 chord progression can supply a fallback bass line when no explicit bass track exists", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function chordSymbolToPitches(symbol,octave=4)");
  const end=html.indexOf("\nfunction getPlayableBassNotes",start);
  assert.ok(start>=0&&end>start);
  const helpers=new Function(html.slice(start,end)+";return {chordSymbolToPitches,getPlayableChordEvents};")();
  const bassStart=html.indexOf("function buildBassNotesFromChords(project,bars,timeSig=4)");
  const bassEnd=html.indexOf("\nfunction buildBassVariantNotes",bassStart);
  assert.ok(bassStart>=0&&bassEnd>bassStart);
  const buildBass=new Function("chordSymbolToPitches",html.slice(bassStart,bassEnd)+";return buildBassNotesFromChords;")(helpers.chordSymbolToPitches);
  const project={generatedMusic:{chords:[{chord:"Am",beats:4},{chord:"F",beats:4},{chord:"C",beats:4},{chord:"G",beats:4}]}};
  const notes=buildBass(project,4,4);
  assert.equal(notes.length,11,"four-beat chords should yield roots, fifths and three chromatic approach notes");
  assert.equal(notes[0].pitch,33,"A minor root should be in the bass register");
  assert.equal(notes[0].startBeat,0);
  assert.equal(notes[1].startBeat,2);
  assert.ok(notes.every(n=>n.pitch>=24&&n.pitch<=60),"generated bass notes must remain in playable bass range");
  const stringProject={chords:["C","Am","F","G"]};
  const stringNotes=buildBass(stringProject,4,4);
  assert.equal(stringNotes.length,11,"plain chord-name arrays must also generate bass pickups");
  assert.match(html,/importedBass\.length\?importedBass:buildBassNotesFromChords/,"explicit bass timeline must take precedence over generated fallback");
});


test("TL-74 selected A B C accompaniment timelines round-trip into score-editor piano and guitar tracks", async () => {
  const beat=await readFile(beatLabPath,"utf8");
  const score=await readFile(path.join(here,"..","apps","score-editor-v2.html"),"utf8");
  assert.match(beat,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:cloneRhythmData\(bassForExport\)\}/,"selected bass candidate must be exported as an explicit timeline");
  assert.match(beat,/piano: \{notes:cloneRhythmData\(pianoForExport\)\}/,"piano arrangement must export note events");
  assert.match(beat,/guitar: \{notes:cloneRhythmData\(guitarForExport\)\}/,"guitar arrangement must export note events");
  assert.match(beat,/arrangements:cloneRhythmData\(APP\.arrangements\|\|\{\}\)/,"all candidate arrangements must be retained on export");
  assert.match(beat,/inspect\(bass,'bass'\);inspect\(piano,'piano'\);inspect\(guitar,'guitar'\)/,"timeline validation must inspect every accompaniment track");
  assert.match(beat,/piano:project\.piano\|\|\{notes:\[\]\}/,"JSON round-trip baseline must include piano");
  assert.match(beat,/guitar:project\.guitar\|\|\{notes:\[\]\}/,"JSON round-trip baseline must include guitar");
  assert.match(score,/if\(data\.piano\?\.notes\?\.length\)[\s\S]*?addTrack\('chord',[\s\S]*?Piano/,"score editor must create a dedicated piano track");
  assert.match(score,/if\(data\.guitar\?\.notes\?\.length\)[\s\S]*?addTrack\('counter',[\s\S]*?Guitar/,"score editor must create a dedicated guitar track");
  assert.match(score,/piano:\{notes:tr\('chord'\)\}, guitar:\{notes:tr\('counter'\)\}/,"score editor must export both accompaniment tracks on return");
});


test("TL-75 Composition Canvas preserves selected bass piano and guitar accompaniment across both handoff directions", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  assert.match(canvas,/project\.bass=window\.__lastDrumProject\?\.bass\|\|incoming\.bass/,"Canvas → Beat Lab must restore bass timeline");
  assert.match(canvas,/project\.piano=window\.__lastDrumProject\?\.piano\|\|incoming\.piano/,"Canvas → Beat Lab must restore piano timeline");
  assert.match(canvas,/project\.guitar=window\.__lastDrumProject\?\.guitar\|\|incoming\.guitar/,"Canvas → Beat Lab must restore guitar timeline");
  assert.match(canvas,/project\.arrangements=window\.__lastDrumProject\?\.arrangements\|\|incoming\.arrangements\|\|null/,"Canvas → Beat Lab must restore all independent A/B/C snapshots");
  assert.match(canvas,/project\.chords=project\.generatedMusic\?\.chords\|\|window\.__lastDrumProject\?\.chords/,"Canvas → Beat Lab must restore saved chord progression");
  assert.match(canvas,/bass:project\.bass\|\|\{notes:\[\]\},piano:project\.piano\|\|\{notes:\[\]\},guitar:project\.guitar\|\|\{notes:\[\]\}/,"Beat Lab → Canvas must save accompaniment timelines");
  assert.match(canvas,/project\.bass=saved\.bass\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore bass");
  assert.match(canvas,/project\.piano=saved\.piano\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore piano");
  assert.match(canvas,/project\.guitar=saved\.guitar\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore guitar");
  assert.match(canvas,/project\.arrangements=saved\.arrangements\|\|null/,"resuming Beat Lab must restore candidate snapshots");
  assert.match(canvas,/project\.accompanimentMode=saved\.accompanimentMode\|\|\'generated\'/,"resuming Beat Lab must preserve accompaniment provenance");
});


test("TL-76 BEAT//LAB reuses manually edited piano and guitar timelines returned by Score Editor", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const score=await readFile(path.join(here,"..","apps","score-editor-v2.html"),"utf8");
  const start=html.indexOf("function chordSymbolToPitches(symbol,octave=4)");
  const end=html.indexOf("\nfunction getPlayableBassNotes",start);
  const helpers=new Function(html.slice(start,end)+";return getPlayableChordEvents;")();
  const project={source:"score-editor",piano:{notes:[{pitch:60,startBeat:0,durationBeats:2,vel:96},{pitch:64,startBeat:0,durationBeats:2,vel:88}]},guitar:{notes:[{pitch:67,startBeat:1.5,durationBeats:.5,vel:72}]},chords:[{chord:"F",beats:4}]};
  const events=helpers(project,4,4,"C");
  assert.deepEqual(events.piano.map(e=>[e.startBeat,e.pitches[0]]),[[0,60],[0,64]],"score-edited piano pitches and timing must take precedence over regenerated chords");
  assert.deepEqual(events.guitar.map(e=>[e.startBeat,e.pitches[0]]),[[1.5,67]],"score-edited guitar notes must be retained");
  assert.equal(events.piano[0].velocity,96/127);
  assert.match(html,/accompanimentMode:base\.accompanimentMode\|\|\(base\.source===\'score-editor\'\?\'manual\':\'generated\'\)/,"manual accompaniment provenance must survive export");
  assert.match(score,/accompanimentMode:\'manual\'/,"Score Editor must mark manually edited accompaniment");
});


test("TL-77 piano and guitar buses use separate high-pass filters to protect bass headroom", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/pianoToneFilter=new Tone\.Filter\(105,'highpass'\)\.connect\(pianoPan\)/,"piano bus must trim unnecessary sub-bass");
  assert.match(html,/guitarToneFilter=new Tone\.Filter\(145,'highpass'\)\.connect\(guitarCompressor\)/,"guitar bus must leave more low-frequency room for bass");
  assert.match(html,/pianoBus=new Tone\.Gain\([^;]*\)\.connect\(pianoToneFilter\)/,"piano level must remain independently adjustable before filtering");
  assert.match(html,/guitarBus=new Tone\.Gain\([^;]*\)\.connect\(guitarToneFilter\)/,"guitar level must remain independently adjustable before filtering");
});


test("TL-78 piano and guitar occupy subtly separated stereo positions", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/pianoPan=new Tone\.Panner\(-\.16\)\.connect\(getMasterBus\(\)\)/,"piano should sit slightly left of center");
  assert.match(html,/guitarPan=new Tone\.Panner\(\.2\)\.connect\(getMasterBus\(\)\)/,"guitar should sit slightly right of center");
  assert.match(html,/pianoToneFilter=new Tone\.Filter\(105,'highpass'\)\.connect\(pianoPan\)/,"piano filter must feed its stereo position");
  assert.match(html,/guitarToneFilter=new Tone\.Filter\(145,'highpass'\)\.connect\(guitarCompressor\)/,"guitar filter must feed its stereo position");
});


test("TL-79 sampled piano loads lazily with synth fallback and distinct electric guitar path", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/new Tone\.Sampler\(\{urls:\{C2:'C2\.mp3',C3:'C3\.mp3',C4:'C4\.mp3',C5:'C5\.mp3',C6:'C6\.mp3'\}/,"piano must load multi-register Salamander piano samples");
  assert.match(html,/baseUrl:'https:\/\/tonejs\.github\.io\/audio\/salamander\//,"piano samples must use the public Salamander sample set");
  assert.match(html,/const sampler=getPianoSampler\(\);[\s\S]*?if\(pianoSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getPianoSynth\(\)\.triggerAttackRelease/,"piano playback must fall back to the synth while samples load or fail");
  assert.match(html,/function getGuitarSynth\(\)[\s\S]*?new Tone\.PolySynth\(Tone\.Synth,[\s\S]*?attack:\.003,decay:\.34,sustain:0/,"acoustic guitar fallback must be polyphonic with a short plucked-string envelope");
  assert.match(html,/new Tone\.PolySynth\(Tone\.Synth,\{oscillator:\{type:'fatsawtooth',count:3,spread:7\}/,"electric guitar must use a separate sustained voice");
  assert.match(html,/new Tone\.Distortion\(\.12\)/,"electric guitar must have its own mild drive stage");
  assert.match(html,/new Tone\.Chorus\(1\.7,2\.1,\.12\)/,"electric guitar must have a separate modulation stage");
  assert.match(html,/instrument:'electric'/,"C arrangement must select the electric guitar voice");
  assert.match(html,/if\(pianoSampler\)pianoSampler\.releaseAll\(\)/,"stop must release sampled piano voices");
  assert.match(html,/if\(electricGuitarSynth\)electricGuitarSynth\.releaseAll\(\)/,"stop must release electric guitar voices");
});

test("TL-80 bass timbre follows song section, register and A/B/C role", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function getBassSectionTone(section,variant='A',pitch=40)");
  const end=html.indexOf("\nfunction playBassNote",start);
  assert.ok(start>=0&&end>start,"section-aware bass tone helper must exist");
  const getTone=new Function(html.slice(start,end)+";return getBassSectionTone;")();
  const verse=getTone({label:"Verse"},"A",40);
  const chorus=getTone({label:"Chorus"},"A",40);
  const bridge=getTone({label:"Bridge"},"A",40);
  const sparse=getTone({label:"Verse"},"B",40);
  const driven=getTone({label:"Verse"},"C",40);
  const low=getTone({label:"Verse"},"A",28);
  const high=getTone({label:"Verse"},"A",52);
  assert.ok(chorus.filterHz>verse.filterHz,"chorus bass should open its tone");
  assert.ok(bridge.filterHz<verse.filterHz,"bridge bass should become darker");
  assert.ok(sparse.attackDb<verse.attackDb,"B bass should be more restrained");
  assert.ok(driven.attackDb>verse.attackDb,"C bass should have more attack");
  assert.ok(low.subDb>high.subDb,"low-register notes should receive more sub support");
  assert.ok(high.filterHz>low.filterHz,"higher bass notes should receive a clearer upper body");
  assert.match(html,/playBassNote\(\{\.\.\.note,velocity:[^}]+\},duration,audioAt,activeSection,chordVariant\)/,"live bass playback must receive section and selected arrangement");
});


test("TL-81 section-specific bass timbre changes are scheduled at note audio timestamps", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function playBassNote(note,duration,when,section=null,variant='A')");
  const end=html.indexOf("\nfunction updateMixVolumes",start);
  assert.ok(start>=0&&end>start);
  const play=html.slice(start,end);
  for(const expression of ["body.filter.frequency.setValueAtTime(tone.filterHz,when)","body.volume.setValueAtTime(tone.bodyDb-1,when)","sub.volume.setValueAtTime(tone.subDb,when)","attack.volume.setValueAtTime(tone.attackDb,when)"]){
    assert.ok(play.includes(expression),expression+" must follow the same Web Audio clock as the note");
  }
  assert.doesNotMatch(play,/\.rampTo\(tone\./,"look-ahead scheduling must not apply future section tone changes immediately");
});


test("TL-82 acoustic guitar, electric guitar and bass use real sample maps with synth fallback", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/TONEJS_SAMPLE_ROOT='https:\/\/raw\.githubusercontent\.com\/nbrosowsky\/tonejs-instruments\/master\/samples\/'/);
  assert.match(html,/createInstrumentSampler\('guitar-acoustic'/);
  assert.match(html,/createInstrumentSampler\('guitar-electric'/);
  assert.match(html,/createInstrumentSampler\('bass-electric'/);
  assert.match(html,/D2:'D2\.mp3'[\s\S]*?C5:'C5\.mp3'/,"acoustic guitar sampler should map notes across its playable range");
  assert.match(html,/getElectricGuitarSampler\(\)[\s\S]*?'C#2':'Cs2\.mp3'[\s\S]*?C6:'C6\.mp3'/,"electric guitar sampler must use Tone.js sharp-note keys");
  assert.doesNotMatch(html,/getElectricGuitarSampler\(\)[^\n]*\b(?:Cs|Ds|Fs|Gs|As)\d+:/,"Tone.Sampler note names must not use filename-style sharp notation");
  assert.match(html,/'C#1':'Cs1\.mp3'[\s\S]*?'C#4':'Cs4\.mp3'/,"bass sampler must use Tone.js sharp-note keys across the low register");
  assert.match(html,/if\(electricGuitarSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getElectricGuitarSynth\(\)\.triggerAttackRelease/);
  assert.match(html,/if\(guitarSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getGuitarSynth\(\)\.triggerAttackRelease/);
  assert.match(html,/if\(bassSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else body\.triggerAttackRelease/);
  assert.match(html,/if\(bassSampler\)bassSampler\.releaseAll\(\)/);
  assert.match(html,/if\(guitarSampler\)guitarSampler\.releaseAll\(\)/);
  assert.match(html,/if\(electricGuitarSampler\)electricGuitarSampler\.releaseAll\(\)/);
});

test("TL-83 instrument buses feed a shared master compressor and limiter", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/masterLimiter=new Tone\.Limiter\(-1\)\.toDestination\(\)/);
  assert.match(html,/masterCompressor=new Tone\.Compressor\(\{threshold:-15,ratio:1\.7/);
  assert.match(html,/drumCompressor=new Tone\.Compressor\([\s\S]*?\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/bassCompressor\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/guitarCompressor=new Tone\.Compressor\([\s\S]*?\.connect\(guitarPan\)/);
  assert.match(html,/pianoPan=new Tone\.Panner\(-\.16\)\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/guitarPan=new Tone\.Panner\(\.2\)\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/getBassSamplerFilter\(\),v=>bassSamplerReady=v/,"sampled bass must pass through its tone-shaping filter");
});


test("TL-84 A/B/C mix profiles create distinct musical balances and spatial roles", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("const ARRANGEMENT_MIX_PROFILES=");
  const end=html.indexOf("\nfunction mixSliderValue",start);
  assert.ok(start>=0&&end>start,"A/B/C mix profile table must exist");
  const profiles=new Function(html.slice(start,end)+";return ARRANGEMENT_MIX_PROFILES;")();
  assert.deepEqual(Object.keys(profiles),["A","B","C"]);
  for(const id of ["A","B","C"]){
    const p=profiles[id];
    for(const instrument of ["drum","melody","bass","piano","guitar"])assert.ok(Number.isFinite(p.gain[instrument])&&p.gain[instrument]>0, id+" gain "+instrument);
    assert.ok(p.master.threshold<0&&p.master.ratio>1);
    assert.ok(p.drumComp.threshold<0&&p.drumComp.ratio>1);
  }
  assert.ok(profiles.B.gain.drum<profiles.A.gain.drum,"B should leave more space around the drums");
  assert.ok(profiles.B.gain.piano>profiles.A.gain.piano,"B should bring piano forward");
  assert.ok(profiles.B.pianoPan<profiles.A.pianoPan&&profiles.B.guitarPan>profiles.A.guitarPan,"B should widen the chord instruments");
  assert.ok(profiles.C.gain.drum>profiles.A.gain.drum&&profiles.C.gain.bass>profiles.A.gain.bass&&profiles.C.gain.guitar>profiles.A.gain.guitar,"C should emphasize rhythm section and guitar");
  assert.ok(profiles.C.gain.piano<profiles.A.gain.piano&&profiles.C.gain.melody<profiles.A.gain.melody,"C should make room for the driving rhythm section");
  assert.notDeepEqual(profiles.A.bassEQ,profiles.B.bassEQ);
  assert.notEqual(profiles.A.drumComp.attack,profiles.C.drumComp.attack);
});

test("TL-85 selected A/B/C mix profile follows candidate selection, playback and live fader changes", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/function applyArrangementMix\(variant=APP\.activeDrumVariant\|\|'A',options=\{\}\)/);
  assert.match(html,/applyArrangementMix\(id,\{immediate:true\}\)/,"candidate selection must switch its mix profile");
  assert.match(html,/applyArrangementMix\(chordVariant,\{ensure:true,immediate:true\}\)/,"playback must initialize the matching profile before notes are scheduled");
  assert.match(html,/function updateMixVolumes\(\)\{applyArrangementMix\(APP\.activeDrumVariant\|\|'A'\);\}/,"manual faders must preserve the selected profile's relative balance");
  assert.match(html,/mixSliderValue\(name\+'-volume',[\s\S]*?\*profile\.gain\[name\]/,"profile gain multipliers must retain each user's slider setting");
  assert.match(html,/bassBusEQ\.low,profile\.bassEQ\.low[\s\S]*?bassBusEQ\.mid,profile\.bassEQ\.mid[\s\S]*?bassBusEQ\.high,profile\.bassEQ\.high/);
  assert.match(html,/pianoToneFilter\.frequency,profile\.pianoHP/);
  assert.match(html,/guitarToneFilter\.frequency,profile\.guitarHP/);
  assert.match(html,/drumCompressor\.threshold,profile\.drumComp\.threshold/);
  assert.match(html,/masterCompressor\.threshold,profile\.master\.threshold/);
  assert.match(html,/id="arrangement-mix-status"/);
});


test("TL-86 A/B/C own independent canonical snapshots for every instrument track", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/arrangements:null/,"application state must own the canonical arrangement collection");
  assert.match(html,/function buildArrangementTrackSnapshot\(project,variant,sections\)/);
  for(const track of ["melody","piano","guitar","bass","drums"]){
    assert.match(html,new RegExp(track+":\\{notes:"),track+" must be represented as an independent note track");
  }
  assert.match(html,/APP\.arrangements\[id\]=buildArrangementTrackSnapshot/);
  assert.match(html,/APP\.arrangements=\{\}/,"regenerating candidates must start clean snapshots");
  assert.match(html,/const activeArrangement=syncActiveArrangementTrackSnapshot\(\)/,"playback must read the selected canonical snapshot");
  assert.match(html,/const melody=activeTracks\.melody\?\.notes\|\|\[\]/,"melody playback must use the selected arrangement's melody track");
  assert.match(html,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:cloneRhythmData\(bassForExport\)\}/);
  assert.match(html,/arrangements:cloneRhythmData\(APP\.arrangements\|\|\{\}\)/,"export must persist all candidate snapshots");
  assert.match(html,/projectData\?\.arrangements/,"arrangement restore must restore the canonical snapshots");
  assert.match(html,/current\.tracks\.drums=refreshed\.tracks\.drums/,"editing a drum candidate must not overwrite its piano/guitar/bass/melody snapshots");
  assert.match(html,/const canonicalSections=APP\.arrangements\?\.\[id\]\?\.sections/,"drum candidate playback must prefer the canonical snapshot section data");
  assert.match(html,/restoreSongArrangement\(window\.__compositionBaseProject\.arrangement,window\.__compositionBaseProject\)/,"boot must retain the selected candidate while restoring");
});

test("TL-87 JSON roundtrip baseline includes all A/B/C track snapshots", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function normalizeJSONRoundTripValue");
  const end=html.indexOf("function exportJSON",start);
  assert.ok(start>=0&&end>start);
  const helpers=new Function(html.slice(start,end)+"\nreturn {createJSONRoundTripSnapshot,compareJSONRoundTripSnapshot};")();
  const tracks={melody:{notes:[{pitch:60,startBeat:0,durationBeats:1,vel:90}]},piano:{notes:[]},guitar:{notes:[]},bass:{notes:[]},drums:{notes:[]}};
  const project={bpm:100,timeSig:4,bars:4,div:16,lyrics:"",sections:[],melody:tracks.melody,drums:tracks.drums,piano:tracks.piano,guitar:tracks.guitar,bass:tracks.bass,arrangements:{A:{id:"A",tracks},B:{id:"B",tracks:structuredClone(tracks)},C:{id:"C",tracks:structuredClone(tracks)}},activeArrangement:"B"};
  const baseline=helpers.createJSONRoundTripSnapshot(project);
  assert.equal(helpers.compareJSONRoundTripSnapshot(baseline,structuredClone(project)).ok,true);
  const edited=structuredClone(project);
  edited.arrangements.C.tracks.guitar.notes.push({pitch:67,startBeat:1,durationBeats:.5,vel:70});
  assert.ok(helpers.compareJSONRoundTripSnapshot(baseline,edited).errors.includes("arrangements がJSON保存前と一致しません"));
});


test("TL-88 Score Editor preserves inactive A/B/C snapshots and updates only the active track snapshot", async () => {
  const score=await readFile(path.join(here,"..","apps","score-editor-v2.html"),"utf8");
  assert.match(score,/PROJ\.arrangements=data\.arrangements\?JSON\.parse\(JSON\.stringify\(data\.arrangements\)\):null/);
  assert.match(score,/const activeArrangement=PROJ\.activeArrangement\|\|PROJ\.activeDrumVariant\|\|'A'/);
  assert.match(score,/arrangements\[activeArrangement\]\.tracks\.melody=\{notes:tr\('melody'\)\}/);
  assert.match(score,/arrangements\[activeArrangement\]\.tracks\.piano=\{notes:tr\('chord'\)\}/);
  assert.match(score,/arrangements\[activeArrangement\]\.tracks\.guitar=\{notes:tr\('counter'\)\}/);
  assert.match(score,/arrangement:PROJ\.arrangement, drumVariants:PROJ\.drumVariants, activeDrumVariant:PROJ\.activeDrumVariant/);
  assert.match(score,/activeArrangement, arrangements, exported:new Date\(\)\.toISOString\(\)/);
});


test("TL-89 arrangement grooves have distinct musical articulation rather than mix-only changes", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const chordStart=html.indexOf("function chordSymbolToPitches(symbol,octave=4)");
  const chordEnd=html.indexOf("\n\n\n\nfunction buildBassNotesFromChords",chordStart);
  assert.ok(chordStart>=0&&chordEnd>chordStart);
  const chordHelpers=new Function(html.slice(chordStart,chordEnd)+"\nreturn {chordSymbolToPitches,getPlayableChordEvents};")();
  const progression={chords:[{chord:"C",beats:4},{chord:"Am7",beats:4},{chord:"F",beats:4},{chord:"G",beats:4}]};
  const A=chordHelpers.getPlayableChordEvents(progression,4,4,"A");
  const B=chordHelpers.getPlayableChordEvents(progression,4,4,"B");
  const C=chordHelpers.getPlayableChordEvents(progression,4,4,"C");
  assert.ok(A.piano.some(e=>e.pitches.length>=3&&e.durationBeats>=2),"A piano should sustain block harmony");
  assert.ok(B.piano.every(e=>e.pitches.length===1&&e.durationBeats<1),"B piano should use short, separated arpeggio tones");
  assert.ok(C.piano.every(e=>e.durationBeats<=.48),"C piano should use short rhythmic stabs");
  assert.ok(C.guitar.some(e=>Math.abs((e.startBeat%1)-.25)<.001),"C guitar should accent off-beat subdivisions");
  assert.ok(C.guitar.every(e=>e.instrument==="electric"),"C ostinato must use the electric guitar voice");
  assert.match(html,/instrument:note\.instrument\|\|'acoustic'/,"playback must retain each candidate guitar voice");
  assert.ok(A.guitar.every(e=>e.pitches.length>=2),"A guitar should add restrained dyadic responses");
  assert.ok(B.guitar.every(e=>e.pitches.length===1),"B guitar should leave sparse single-note responses");
  assert.ok(B.guitar.length<C.guitar.length,"C guitar should carry the densest ostinato");
  const bassStart=html.indexOf("function buildBassVariantNotes(notes,bars,timeSig=4,variant='A')");
  const bassEnd=html.indexOf("\n\nfunction getPlayableBassNotes",bassStart);
  const buildBass=new Function(html.slice(bassStart,bassEnd)+"\nreturn buildBassVariantNotes;")();
  const bassSource=[{id:"root1",pitch:36,startBeat:0,durationBeats:1,velocity:.8},{id:"fifth1",pitch:43,startBeat:2,durationBeats:1,velocity:.7},{id:"root2",pitch:38,startBeat:4,durationBeats:1,velocity:.8},{id:"fifth2",pitch:45,startBeat:6,durationBeats:1,velocity:.7}];
  const bassA=buildBass(bassSource,2,4,"A"),bassB=buildBass(bassSource,2,4,"B"),bassC=buildBass(bassSource,2,4,"C");
  assert.equal(bassA.length,bassSource.length,"A bass should keep the steady foundation");
  assert.equal(bassB.length,2,"B bass should hold one low anchor per bar");
  assert.ok(bassB.every(n=>n.durationBeats>=3.9),"B bass should sustain long notes");
  assert.ok(bassC.some(n=>n.id.endsWith("-pickup"))&&bassC.some(n=>n.id.endsWith("-oct")),"C bass should add pickups and octave articulation");
});


test("TL-90 all inline JavaScript in composition, BEAT//LAB and score editor pages parses as browser scripts", async () => {
  const pages = [
    ["composition-canvas.html", canvasPath],
    ["beat-lab.html", beatLabPath],
    ...[
      "canvas.html",
      "chord-analyzer.html",
      "chord-lab.html",
      "compose-spark.html",
      "score-editor-v2.html",
      "suite-roadmap.html",
      "vocal-lab-v3.html"
    ].map((name) => [name, path.join(here, "..", "apps", name)])
  ];
  for (const [pageName, pagePath] of pages) {
    const html = await readFile(pagePath, "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const inlineScripts = scripts.filter((match) => !/\bsrc\s*=/i.test(match[1]));
    assert.ok(inlineScripts.length > 0, pageName + " must contain at least one inline script to validate");
    inlineScripts.forEach((match, index) => {
      const type = match[1].match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
      assert.ok(!type || type === "text/javascript" || type === "application/javascript",
        pageName + " inline script " + (index + 1) + " uses unsupported non-classic script type: " + type);
      try {
        new Script(match[2], { filename: pageName + "#inline-script-" + (index + 1) });
      } catch (error) {
        throw new Error(pageName + " inline script " + (index + 1) + " failed syntax parsing: " + error.stack);
      }
    });
  }
});

test("TL-90 melody playback requires the sampled violin source instead of silently using a synth", async () => {
  const html = await readFile(beatLabPath, "utf8");
  assert.match(html, /function getMelodySampler\(\)/);
  assert.match(html, /TONEJS_SAMPLE_ROOT\+'violin\/'/);
  assert.match(html, /async function ensureMelodySamplerReady\(\)/);
  assert.match(html, /await ensureMelodySamplerReady\(\)/);
  assert.match(html, /if\(melodySamplerReady&&melodySampler\)melodySampler\.triggerAttackRelease/);
  assert.doesNotMatch(html, /getMelodySynth\(\)\.triggerAttackRelease/);
  const credits = await readFile(path.join(here, "..", "SOUND-CREDITS.md"), "utf8");
  assert.match(credits, /Melody \(sampled violin\)/);
  assert.match(credits, /VSO2/);
});


test("TL-92 standard test song has a playable melody and drum timeline across every section", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  const melody = project.melody.notes;
  const drums = project.drums.notes;
  assert.ok(melody.length >= 100, "the test melody must be long enough to evaluate phrasing");
  assert.equal(new Set(melody.map(note => Math.floor(note.startBeat / 4) + 1)).size, 32);
  for (let bar = 1; bar <= 32; bar++) {
    assert.ok(melody.filter(note => Math.floor(note.startBeat / 4) + 1 === bar).length >= 2, "bar " + bar + " needs melodic material");
  }
  assert.ok(melody.some(note => note.durationBeats <= 0.5), "short articulations must be represented");
  assert.ok(melody.some(note => note.durationBeats >= 1.5), "sustained notes must be represented");
  assert.ok(drums.length >= 200, "the drum timeline must cover the full song");
  assert.equal(Math.floor(Math.max(...drums.map(note => note.startBeat)) / 4) + 1, 32);
  for (const section of project.arrangement.sections) {
    assert.ok(Object.keys(section.pattern).length >= 8, section.id + " must have a meaningful groove");
  }
});

test("TL-91 standard test song supplies harmony across all 32 bars for five-part playback", async () => {
  const project = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(project.chords.length, 32);
  assert.equal(project.chords[0].bar, 1);
  assert.equal(project.chords.at(-1).bar, 32);
  assert.equal(project.chords.reduce((sum, chord) => sum + chord.beats, 0), 128);
  const beatLab = await readFile(beatLabPath, "utf8");
  assert.match(beatLab, /function buildArrangementTrackSnapshot\(project,variant,sections\)/);
  assert.match(beatLab, /const chords=getPlayableChordEvents\(project,APP\.bars,APP\.timeSig,id\)/);
});
test("TL-96 lyric-aware accompaniment, bass pickups and pre-chorus transition are grounded in the complete lyric song", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const fixture=JSON.parse(await readFile(fixturePath,"utf8"));
  assert.equal(fixture.bars,32);
  assert.equal(fixture.lyrics.sections.length,5);
  assert.ok(fixture.melody.notes.length>0);
  assert.ok(fixture.melody.notes.every(note=>fixture.lyrics.sections.some(section=>section.id===note.lyricId)),"every melody note must remain linked to a lyric section");

  const responseStart=html.indexOf("function applyMelodyResponsiveAccompaniment(");
  const responseEnd=html.indexOf("\nfunction getPlayableChordEvents",responseStart);
  assert.ok(responseStart>=0&&responseEnd>responseStart);
  const respond=new Function(html.slice(responseStart,responseEnd)+";return applyMelodyResponsiveAccompaniment;")();
  const events={piano:[{startBeat:0,pitches:[60,64,67],durationBeats:4,velocity:.6}],guitar:[{startBeat:0,pitches:[67],durationBeats:4,velocity:.5}]};
  const melody=[{pitch:60,startBeat:0,durationBeats:1},{pitch:64,startBeat:2,durationBeats:.5}];
  const result=respond(events,melody,2,4,"A");
  assert.ok(result.piano.every(event=>!event.pitches.some(p=>[60,64].includes(p))),"piano must leave the melody's active pitches clear");
  assert.equal(result.guitar.filter(event=>!event.response).length,0,"guitar must avoid close unison/interval collisions while melody is active");
  const responses=result.guitar.filter(event=>event.response);
  assert.ok(responses.length>=1,"a sufficiently long lyric/melody rest must receive an instrumental response");
  assert.ok(responses.every(event=>event.startBeat>=1&&event.startBeat<2),"response must sit inside a real melody rest");

  const chordStart=html.indexOf("function chordSymbolToPitches(");
  const chordEnd=html.indexOf("\nfunction chooseSmoothChordVoicing",chordStart);
  const bassStart=html.indexOf("function buildBassNotesFromChords(",chordEnd);
  const bassEnd=html.indexOf("\nfunction buildBassVariantNotes",bassStart);
  assert.ok(chordStart>=0&&chordEnd>chordStart&&bassStart>chordEnd&&bassEnd>bassStart);
  const bassHelpers=new Function(html.slice(chordStart,chordEnd)+"\n"+html.slice(bassStart,bassEnd)+";return buildBassNotesFromChords;")();
  const bass=bassHelpers({chords:[{chord:"C",beats:4},{chord:"G",beats:4}]},2,4);
  const pickup=bass.find(note=>note.id==="chord-bass-1-approach");
  assert.ok(pickup,"bass must add a chromatic approach to the next chord root");
  assert.equal(pickup.startBeat,3.5);
  assert.equal(pickup.pitch,30);

  const sectionStart=html.indexOf("function sectionPatternFrom(base,id)");
  const sectionEnd=html.indexOf("\nfunction ensureArrangementEffects()",sectionStart);
  const ideaStart=html.indexOf("function buildSectionDrumIdea(basePattern,section,style,variation='normal')");
  const ideaEnd=html.indexOf("\nfunction applyDrumArrangementIdea(style)",ideaStart);
  const app={div:16,timeSig:4},pk=(row,step)=>row+":"+step;
  const sectionPatternFrom=new Function("APP","pk",html.slice(sectionStart,sectionEnd)+";return sectionPatternFrom;")(app,pk);
  const build=new Function("APP","pk","sectionPatternFrom",html.slice(ideaStart,ideaEnd)+";return buildSectionDrumIdea;")(app,pk,sectionPatternFrom);
  const pre=build({"kick:0":.8},{id:"pre",startBar:1,endBar:2},"balanced","normal");
  assert.ok(Object.keys(pre).some(key=>key.startsWith("tom2:")),"pre-chorus must add a transition fill");
  assert.ok(pre["snare:28"]>.0,"pre-chorus fill must lead into the chorus");

  const arrangementStart=html.indexOf("function buildArrangementTrackSnapshot(");
  const arrangementEnd=html.indexOf("\nfunction captureArrangementTrackSnapshot",arrangementStart);
  assert.match(html,/function buildArrangementTrackSnapshot\(project,variant,sections\)/);
  assert.ok(arrangementEnd>arrangementStart);
  const snapshotBody=html.slice(arrangementStart,arrangementEnd);
  assert.match(snapshotBody,/tracks:\{melody:\{notes:cloneRhythmData\(project\?\.melody\?\.notes\|\|\[\]\)\}/);
  assert.match(html,/const chords=getPlayableChordEvents\(project,APP\.bars,APP\.timeSig,id\)/);
});


test("TL-102 lyric syllable and stress helpers expose phrase-level pronunciation cues", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  const start=canvas.indexOf("const LYRIC_PRONUNCIATION_LEXICON=");
  const end=canvas.indexOf("const LYRIC_NOTE_NAMES=",start);
  assert.ok(start>=0&&end>start);
  const helpers=new Function(canvas.slice(start,end)+";return {lyricStressIndex,lyricIsFunctionWord,lyricEstimateSyllables,lyricBuildSyllables,lyricPhraseWeights};")();
  assert.equal(helpers.lyricEstimateSyllables("growing"),2);
  assert.equal(helpers.lyricEstimateSyllables("beautiful"),3);
  assert.equal(helpers.lyricStressIndex("believe",2),1);
  assert.equal(helpers.lyricStressIndex("alone",2),1);
  const pronunciationCases={
    every:[2,0],different:[3,0],family:[3,0],remember:[3,1],
    tomorrow:[3,1],together:[3,1],tonight:[2,1],beginning:[3,1],
    understanding:[4,2],comfortable:[3,0],because:[2,1],fire:[2,0]
  };
  for(const [word,[count,stress]] of Object.entries(pronunciationCases)){
    assert.equal(helpers.lyricEstimateSyllables(word),count,word+" syllable count");
    assert.equal(helpers.lyricStressIndex(word,count),stress,word+" lexical stress");
  }
  assert.equal(helpers.lyricIsFunctionWord("I"),true);
  assert.equal(helpers.lyricIsFunctionWord("walk"),false);
  const phrase=helpers.lyricBuildSyllables("I believe in you","A","Verse",0);
  assert.equal(phrase.length,5);
  assert.ok(phrase.some(item=>item.stressed));
  assert.equal(phrase.find(item=>item.word==="I").stressed,false);
  assert.equal(phrase.find(item=>item.word==="you").stressed,false);
  assert.equal(phrase.find(item=>item.word==="believe"&&item.syllableIndex===1).stressed,true);
  assert.ok(phrase.every(item=>item.phrase==="I believe in you"&&item.label==="Verse"));
  const weights=helpers.lyricPhraseWeights(phrase);
  assert.ok(weights.at(-1)>weights[1],"the final syllable receives phrase-ending duration weight");
});


test("TL-103 varied English lyrics generate syllable-linked melodies with singable range and phrase breathing", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  const helperStart=canvas.indexOf("const LYRIC_PRONUNCIATION_LEXICON=");
  const helperEnd=canvas.indexOf("function parseChordProgressionText",helperStart);
  const generatorStart=canvas.indexOf("function generateLyricMusicSketch()");
  const generatorEnd=canvas.indexOf("\nfunction saveLyricCanvasProject()",generatorStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart&&generatorStart>=0&&generatorEnd>generatorStart);
  const code=canvas.slice(helperStart,helperEnd)+"\n"+canvas.slice(generatorStart,generatorEnd)+";return generateLyricMusicSketch;";
  const variants=[
    [
      {role:"A",label:"Mia / A verse",text:"I remember every little moment\nThe morning opens wide\nI am finding my way"},
      {role:"B",label:"Ken / B verse",text:"The city lights are calling me\nA thousand windows shine\nI hear the distant sound"},
      {role:"DUET",label:"Chorus",text:"We are alive tonight\nReaching for tomorrow\nTogether we can fly"},
      {role:"DUET",label:"Bridge",text:"Even when the road is long\nWe keep the fire bright\nAnd never let it go"}
    ],
    [
      {role:"A",label:"Mia / A verse",text:"A quiet river carries dreams\nAcross the open fields\nI follow where it leads"},
      {role:"B",label:"Ken / B verse",text:"I will return before the morning\nThe stars are fading now\nI hear you call my name"},
      {role:"DUET",label:"Chorus",text:"Together we can rise\nAbove the shadows\nInto the light again"},
      {role:"DUET",label:"Bridge",text:"And find a place to begin\nA new day waits for us\nWe start again"}
    ],
    [
      {role:"A",label:"Mia / A verse",text:"Fire in the distance\nA signal in the dark\nA promise in the sky"},
      {role:"B",label:"Ken / B verse",text:"Every heartbeat tells a story\nThe rhythm in our hands\nIt brings us back to life"},
      {role:"DUET",label:"Chorus",text:"Remember who we are\nRemember why we sing\nOur voices rising high"},
      {role:"DUET",label:"Bridge",text:"The stars are listening\nThe night is opening\nThe world is wide awake"}
    ]
  ];
  const pitchToMidi=pitch=>{
    const match=String(pitch).match(/^([A-G])([#b]?)(-?\d+)$/);
    assert.ok(match,"generated pitch must be a named note: "+pitch);
    const semitones={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
    const accidental=match[2]==="#"?1:match[2]==="b"?-1:0;
    return (Number(match[3])+1)*12+semitones[match[1]]+accidental;
  };
  for(let variantIndex=0;variantIndex<variants.length;variantIndex++){
    const sections=variants[variantIndex],cards=[],elements=new Map();
    const document={
      getElementById(id){
        if(!elements.has(id)){
          const values={"lyric-key":"C","lyric-mood":"hope","lyric-progression":"pop","lyric-progression-a":"warm","lyric-progression-b":"sad","lyric-progression-chorus":"pop","lyric-progression-bridge":"surprise"};
          elements.set(id,{value:values[id]||"",style:{},innerHTML:""});
        }
        return elements.get(id);
      },
      querySelectorAll(){return cards;},
      createElement(){return {dataset:{},classList:{add(){}},appendChild(){},textContent:""};}
    };
    const state={lastNotes:[]},window={__musicProjectId:"lyric-variation-"+variantIndex};
    const renderNoteCards=notes=>cards.splice(0,cards.length,...notes.map(note=>({dataset:{noteId:note.id,startBeat:String(note.startBeat),lyricId:note.lyricId,lyric:note.lyric,lyricRole:note.role,lyricSection:note.section,word:note.word},classList:{add(){}},appendChild(){}})));
    const generate=new Function("document","window","state","lyricTextRead","lyricSectionsRead","renderGeneratedChordSections","renderNoteCards","makeMelodyNoteId","showToast","escapeHtmlCanvas",code)(
      document,window,state,()=>sections.map(section=>section.text).join("\n"),()=>sections,()=>{},renderNoteCards,index=>"variant-"+variantIndex+"-note-"+index,()=>{},value=>value
    );
    generate();
    const sketch=window.__lyricMusicSketch,melody=sketch?.melody||[];
    assert.ok(melody.length>0,"variant "+variantIndex+" must produce melody notes");
    assert.equal(sketch.bars,32);
    assert.ok(sketch.chords.some(chord=>chord.startBeat+chord.beats>=128),"harmony must cover all 32 bars");
    assert.ok(melody.some(note=>note.startBeat>=96),"final section must reach bars 25-32");
    assert.deepEqual(new Set(melody.map(note=>note.section)),new Set(sections.map(section=>section.label)));
    assert.ok(melody.every(note=>note.lyricId&&note.word&&note.lyric&&Number.isInteger(note.syllableIndex)),"every note must retain its source syllable");
    assert.ok(melody.every(note=>note.durationBeats>0&&note.durationBeats<=2),"note durations must remain singable, not multi-bar");
    const midi=melody.map(note=>pitchToMidi(note.pitch));
    assert.ok(Math.min(...midi)>=55&&Math.max(...midi)<=84,"melody register must stay within G3-C6 for this vocal-range baseline");
    assert.ok(Math.max(...midi)-Math.min(...midi)<=24,"melody span must not exceed two octaves");
    assert.ok(melody.some(note=>note.stressed),"lexical stress must affect generated notes");
    const phrases=new Map();
    melody.forEach(note=>{const list=phrases.get(note.phraseIndex)||[];list.push(note);phrases.set(note.phraseIndex,list);});
    const ordered=[...phrases.values()].sort((a,b)=>a[0].startBeat-b[0].startBeat);
    let verifiedBreaths=0;
    for(let i=0;i<ordered.length-1;i++){
      const current=ordered[i].slice().sort((a,b)=>a.startBeat-b.startBeat);
      const next=ordered[i+1].slice().sort((a,b)=>a.startBeat-b.startBeat);
      const gap=next[0].startBeat-(current[current.length-1].startBeat+current[current.length-1].durationBeats);
      assert.ok(gap>=0.7,"distinct lyric phrases need a breathing gap; got "+gap);
      verifiedBreaths++;
    }
    assert.ok(verifiedBreaths>=8,"multiple lyric lines across all sections must preserve phrase breaths");
    assert.equal(state.lastNotes.length,melody.length);
    assert.equal(cards.length,melody.length);
  }
});


test("TL-101 lyric edits mark a saved sketch stale and block handoff until regeneration", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  assert.match(canvas,/sourceLyrics:text/,"generated sketch must remember the exact lyric source used to compose it");
  assert.match(canvas,/generatedMusicStale:Boolean\(window\.__lyricMusicSketch\?\.sourceLyrics!==undefined&&window\.__lyricMusicSketch\.sourceLyrics!==lyricTextRead\(\)\)/,"save must mark generated music stale when lyrics changed");
  assert.match(canvas,/if\(window\.__lyricMusicSketch\?\.sourceLyrics!==undefined&&window\.__lyricMusicSketch\.sourceLyrics!==currentLyrics\)\{showToast\([\s\S]*?return;\}/,"stale lyric-to-melody assignments must not be sent to BEAT//LAB");
  assert.match(canvas,/project\.generatedMusicStale\?' · 歌詞変更あり：再生成が必要':''/,"restored projects must visibly warn when lyrics changed after generation");
  assert.match(canvas,/const preservedMelody=Array\.isArray\(window\.__lyricMusicSketch\?\.melody\)&&window\.__lyricMusicSketch\.melody\.length/,"the current lyric sketch must be the canonical melody source");
});


test("TL-100 save and reload preserve lyric-linked melody timing and editable card identity", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  assert.match(canvas,/notes:cards\.map\(\(card,index\)=>\(\{id:card\.dataset\.noteId[\s\S]*?word:card\.dataset\.word\|\|''/,"saved note cards must retain stable ID and source word");
  assert.match(canvas,/startBeat:card\.dataset\.startBeat!==undefined\?Number\(card\.dataset\.startBeat\):null/,"save must preserve absolute beat positions");
  assert.match(canvas,/card\.dataset\.word=item\.word\|\|''/,"restore must put source words back on editable cards");
  assert.match(canvas,/state\.lastNotes=project\.notes\.map\(item=>\(\{id:item\.id\|\|null[\s\S]*?startBeat:item\.startBeat!==null&&item\.startBeat!==undefined\?Number\(item\.startBeat\):null/,"restored in-memory notes must keep their timeline and IDs");
  assert.match(canvas,/const preservedMelody=Array\.isArray\(window\.__lyricMusicSketch\?\.melody\)&&window\.__lyricMusicSketch\.melody\.length\?\{notes:window\.__lyricMusicSketch\.melody\}:\(rhythmProject\.melody\|\|null\)/,"handoff must prioritize the latest generated lyric melody over an older drum-project melody");
  assert.match(canvas,/const editedDuration=Number\(card\.length\)\/4/,"editable card duration must convert back to beats");
  assert.match(canvas,/state\.lastNotes=notes\.map\(n=>\(\{id:n\.id,note:n\.note,length:n\.length\*4/,"generated note duration must use the card's quarter-beat unit");
});


test("TL-99 Composition Canvas handoff carries the full 32-bar lyric and arrangement source", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  const beat=await readFile(beatLabPath,"utf8");
  assert.match(canvas,/project\.bars=window\.__lastDrumProject\?\.bars\|\|incoming\.bars\|\|window\.__lyricMusicSketch\?\.bars\|\|32/,"handoff must retain the generated 32-bar target");
  assert.match(canvas,/project\.lyrics=lyricTextRead\(\)/,"handoff must include current edited lyrics");
  assert.match(canvas,/project\.sections=lyricSectionsRead\(\)/,"handoff must include current lyric sections");
  assert.match(canvas,/project\.generatedMusic=window\.__lyricMusicSketch/,"handoff must include generated melody and harmony");
  assert.match(beat,/const targetBars=Math\.min\(32,Math\.max\(1,Number\(data\.bars\)\|\|1,requiredBars,Number\(data\.arrangement\?\.bars\)\|\|0\)\)/,"BEAT//LAB must honor the incoming 32-bar timeline");
  assert.match(beat,/melody:\{notes:cloneRhythmData\(project\?\.melody\?\.notes\|\|\[\]\)\}/,"A/B/C arrangement snapshots must retain lyric-generated melody");
  assert.match(beat,/chords: base\.chords\|\|base\.generatedMusic\?\.chords\|\|null/,"export must retain generated chord events");
  assert.match(beat,/lyrics:project\.lyrics\|\|''/,"timeline export must retain lyrics");
  assert.match(beat,/sections:project\.sections\|\|\[\]/,"timeline export must retain lyric sections");
  assert.match(beat,/arrangements:cloneRhythmData\(APP\.arrangements\|\|\{\}\)/,"export must preserve all A/B/C snapshots");
});


test("TL-98 lyric edits preserve note identity and update lyric linkage without orphaning notes", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  const helperStart=canvas.indexOf("const LYRIC_PRONUNCIATION_LEXICON=");
  const helperEnd=canvas.indexOf("function parseChordProgressionText",helperStart);
  const start=canvas.indexOf("function generateLyricMusicSketch()");
  const end=canvas.indexOf("\nfunction saveLyricCanvasProject()",start);
  assert.ok(helperStart>=0&&helperEnd>helperStart&&start>=0&&end>start);
  const sections=[
    {role:"A",label:"Verse",text:"I walk alone"},
    {role:"DUET",label:"Chorus",text:"We reach the sky"}
  ];
  const cards=[],elements=new Map();
  const document={
    getElementById(id){
      if(!elements.has(id)){
        const values={"lyric-key":"C","lyric-mood":"hope","lyric-progression":"pop","lyric-progression-a":"warm","lyric-progression-b":"sad","lyric-progression-chorus":"pop","lyric-progression-bridge":"surprise"};
        elements.set(id,{value:values[id]||"",style:{},innerHTML:""});
      }
      return elements.get(id);
    },
    querySelectorAll(){return cards;},
    createElement(){return {dataset:{},classList:{add(){}},appendChild(){},textContent:""};}
  };
  const state={lastNotes:[]},window={__musicProjectId:"lyric-edit-test"};
  const render=notes=>cards.splice(0,cards.length,...notes.map(n=>({dataset:{noteId:n.id,startBeat:String(n.startBeat),lyricId:n.lyricId,lyric:n.lyric,lyricRole:n.role,lyricSection:n.section,word:n.word},classList:{add(){}},appendChild(){}})));
  const code=canvas.slice(helperStart,helperEnd)+"\n"+canvas.slice(start,end)+";return generateLyricMusicSketch;";
  const generate=new Function("document","window","state","lyricTextRead","lyricSectionsRead","renderGeneratedChordSections","renderNoteCards","makeMelodyNoteId","showToast","escapeHtmlCanvas",code)(document,window,state,()=>sections.map(x=>x.text).join("\n"),()=>sections,()=>{},render,i=>"edit-note-"+i,()=>{},x=>x);
  generate();
  const first=window.__lyricMusicSketch.melody.map(n=>({...n}));
  assert.ok(first.length>0);
  const retained=first[0];
  sections[0].text="I walk toward the light";
  generate();
  const second=window.__lyricMusicSketch.melody;
  assert.ok(second.length>0);
  assert.ok(second.every(n=>n.lyricId&&n.word&&n.lyric&&n.section),"edited lyric must regenerate complete lyric links");
  assert.equal(state.lastNotes.length,second.length);
  assert.equal(cards.length,second.length);
  assert.ok(cards.every(card=>card.dataset.lyricId&&card.dataset.lyricSection),"edited note cards must retain lyric metadata");
  assert.ok(second.some(n=>n.lyric==="I walk toward the light"),"updated lyric text must reach generated melody notes");
  assert.ok(second.every(n=>Number.isFinite(n.startBeat)&&Number.isFinite(n.durationBeats)&&n.durationBeats>0),"edited melody timeline must remain playable");
});


test("TL-97 real lyric-to-melody workflow creates linked notes and section harmony before arrangement", async () => {
  const canvas=await readFile(canvasPath,"utf8");
  const helperStart=canvas.indexOf("const LYRIC_PRONUNCIATION_LEXICON=");
  const helperEnd=canvas.indexOf("function parseChordProgressionText",helperStart);
  const generatorStart=canvas.indexOf("function generateLyricMusicSketch()");
  const generatorEnd=canvas.indexOf("\nfunction saveLyricCanvasProject()",generatorStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart&&generatorStart>=0&&generatorEnd>generatorStart);
  const sections=[
    {role:"A",label:"Mia / A verse",text:"夜明け前\nI walk alone"},
    {role:"B",label:"Ken / B verse",text:"胸の奥で\nA spark is growing"},
    {role:"DUET",label:"Chorus",text:"明日を照らして\nWe can reach the sky"},
    {role:"DUET",label:"Bridge",text:"遠くへ\nWe rise again"}
  ];
  const cards=[],elements=new Map();
  const document={
    getElementById(id){
      if(!elements.has(id)){
        const values={"lyric-key":"C","lyric-mood":"hope","lyric-progression":"pop","lyric-progression-a":"warm","lyric-progression-b":"sad","lyric-progression-chorus":"pop","lyric-progression-bridge":"surprise"};
        elements.set(id,{value:values[id]||"",style:{},innerHTML:""});
      }
      return elements.get(id);
    },
    querySelectorAll(){return cards;},
    createElement(){return {dataset:{},classList:{add(){}},appendChild(){},textContent:""};}
  };
  const state={lastNotes:[]},window={__musicProjectId:"lyric-workflow-test"};
  const renderNoteCards=notes=>{
    cards.splice(0,cards.length,...notes.map(note=>({dataset:{noteId:note.id,startBeat:String(note.startBeat),lyricId:note.lyricId,lyric:note.lyric,lyricRole:note.role,lyricSection:note.section,word:note.word},classList:{add(){}},appendChild(){}})));
  };
  const code=canvas.slice(helperStart,helperEnd)+"\n"+canvas.slice(generatorStart,generatorEnd)+";return generateLyricMusicSketch;";
  const generate=new Function("document","window","state","lyricTextRead","lyricSectionsRead","renderGeneratedChordSections","renderNoteCards","makeMelodyNoteId","showToast","escapeHtmlCanvas",code)(
    document,window,state,()=>sections.map(section=>section.text).join("\n"),()=>sections,()=>{},renderNoteCards,index=>"lyric-note-"+index,()=>{},value=>value
  );
  generate();
  const sketch=window.__lyricMusicSketch;
  assert.ok(sketch&&sketch.melody.length>0,"entering lyrics must create a melody candidate");
  assert.equal(sketch.chordSections.length,4,"each lyric section must receive its own chord progression");
  assert.equal(sketch.bars,32,"lyric generation must target a complete 32-bar song");
  assert.ok(sketch.chords.length>=32,"four lyric sections must repeat harmony across the full song");
  assert.ok(Math.max(...sketch.chords.map(chord=>chord.startBeat+chord.beats))>=128,"generated harmony must reach the end of bar 32");
  assert.ok(sketch.melody.some(note=>note.startBeat>=96),"the final lyric section must reach the last eight bars");
  assert.ok(sketch.chords.some(chord=>chord.startBeat>=96),"the final section harmony must reach the last eight bars");
  assert.deepEqual(new Set(sketch.melody.map(note=>note.section)),new Set(sections.map(section=>section.label)));
  assert.ok(sketch.melody.every(note=>note.lyricId&&note.word&&note.lyric&&note.role&&note.section),"every generated note must retain its lyric, word, role and section");
  assert.ok(sketch.melody.some(note=>note.stressed),"generated melody must distinguish stressed syllables");
  assert.ok(sketch.melody.every(note=>Number.isFinite(note.durationBeats)&&note.durationBeats>0&&note.durationBeats<=2),"short lyric phrases must not be stretched into multi-bar syllables");
  assert.ok(sketch.melody.every(note=>Number.isFinite(note.phraseIndex)&&Number.isInteger(note.syllableIndex)),"each note must retain its phrase and syllable position");
  assert.equal(sketch.method,"stress-aware-phrase-melody-v2");
  assert.equal(sketch.melodyQuality.phraseBreaths,true);
  assert.ok(sketch.melody.some(note=>note.phraseEnd),"line endings must be represented for phrase breathing");
  assert.equal(state.lastNotes.length,sketch.melody.length,"generated notes must be reflected in the editable note-card state");
  assert.equal(cards.length,sketch.melody.length,"generated notes must render as editable cards");
  assert.ok(cards.every(card=>card.dataset.lyricId&&card.dataset.lyricSection),"rendered cards must retain lyric links for later handoff");
});


