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
  assert.match(html,/コード記号だけ（全区間・1行）/);
  assert.match(html,/renderGeneratedChordSections\(restoredSections\)/);
});
test("TL-32 generated lyric melody has non-overlapping one-beat note starts", async () => {
  const html=await readFile(canvasPath,"utf8");
  assert.match(html,/return \{id:makeMelodyNoteId\(i\),note,length:1,[\s\S]*?startBeat:i,/);
  assert.match(html,/const chordIndex=Math\.floor\(Math\.max\(0,localIndex\)\/4\)%section\.progression\.length/);
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
  const playStart=html.indexOf("async function togglePlay()");
  const playEnd=html.indexOf("\nfunction stopPlay()",playStart);
  const play=html.slice(playStart,playEnd);
  assert.match(play,/getPlayableBassNotes\(baseProject,APP\.bars,APP\.timeSig\)/);
  assert.match(play,/playBassNote\(note,duration,audioAt,activeSection,chordVariant\)/);
  assert.match(play,/Math\.abs\(note\.startBeat-currentBeat\)<bassTolerance/);
  assert.match(html.slice(html.indexOf("function stopPlay()"),html.indexOf("\nfunction PROJ_BPM")),/bassSynth\.triggerRelease\(\)/);
});

test("TL-58 BEAT//LAB preserves bass timeline data when exporting a rhythm edit", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function _buildExportData()");
  const end=html.indexOf("\nfunction decodeImportedDrumVelocity",start);
  assert.ok(start>=0&&end>start);
  const body=html.slice(start,end);
  assert.match(body,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:bassForExport\.map/);
  assert.match(body,/bassForExport=buildBassVariantNotes/);
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
  assert.match(html,/playHit\(row\.pitch,vel,audioAt,false\)/,"sequencer must not restart the audio context for every hit");
  assert.match(html,/const safeVel=Math\.max\(\.05,Math\.min\(1,Number\(vel\)\|\|\.05\)\),at=Number\.isFinite\(when\)\?when:undefined/);
  assert.match(html,/getKick\(\)\.triggerAttackRelease\('C1','8n',at,safeVel\)/,"kick velocity must be per-hit, not shared gain mutation");
  assert.match(html,/getSnare\(\)\.triggerAttackRelease\('16n',at,safeVel\)/,"snare must receive the common audio timestamp");
  assert.match(html,/getRide\(\)\.triggerAttackRelease\('8n',at,safeVel\)/,"ride must receive the common audio timestamp");
  assert.match(html,/function tick\(audioAt\)/,"sequencer tick must receive an audio-clock timestamp from the scheduler");
  assert.match(html,/const horizon=Tone\.now\(\)\+0\.12/,"scheduler must maintain a look-ahead window");
  assert.match(html,/playTimer=setInterval\(scheduleAhead,25\)/,"scheduler must refill audio events independently of UI timer cadence");
  assert.match(html,/nextStepTime\+=stepMs\/1000/,"next steps must advance on the audio clock");
  assert.match(html,/playHit\(row\.pitch,vel,audioAt,false\)/,"drums must use the shared audio-clock timestamp");
  assert.match(html,/playBassNote\(note,duration,audioAt,activeSection,chordVariant\)/,"bass trigger must schedule the layered bass voice");
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
  assert.match(html,/drumCompressor=new Tone\.Compressor\(\{threshold:-18,ratio:2\.6,attack:\.004,release:\.13,knee:10\}\)\.toDestination\(\)/,"drum bus compressor must tame peaks without extreme limiting");
  assert.match(html,/drumBus=new Tone\.Gain\([^;]*\)\.connect\(drumCompressor\)/,"drum level control must remain before the compressor");
  assert.match(html,/if\(drumBus\)drumBus\.gain\.rampTo/,"existing drum volume slider must continue to control pre-compressor gain");
});


test("TL-68 look-ahead scheduling keeps visual playhead aligned and rejects stale callbacks", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/const uiDelay=Math\.max\(0,\(audioAt-Tone\.now\(\)\)\*1000\)/,"playhead visuals must wait until the scheduled audio time");
  assert.match(html,/setTimeout\(\(\)=>\{\s*if\(!APP\.playing\|\|generation!==playbackGeneration\)return/,"stale visual callbacks must be ignored after stop/restart");
  assert.match(html,/const generation=\+\+playbackGeneration/,"each playback session must get a unique generation");
  assert.match(html,/APP\.playing=false;playbackGeneration\+\+/,"stopping playback must invalidate queued visual callbacks");
  assert.match(html,/const stepIndex=APP\.playStep/,"visual and audio scheduling must use the same captured step index");
});


test("TL-69 bass playback layers sub foundation and transient articulation on one shared pitch clock", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/bassSynth=null,bassSubSynth=null,bassAttackSynth=null/,"bass voices must be independently managed");
  assert.match(html,/function getBassSubSynth\(\)[\s\S]*?oscillator:\{type:'sine'\}[\s\S]*?frequency:115/,"sub layer must be a clean low-passed sine foundation");
  assert.match(html,/function getBassAttackSynth\(\)[\s\S]*?oscillator:\{type:'triangle'\}[\s\S]*?decay:\.032/,"attack layer must be a short upper harmonic");
  const start=html.indexOf("function playBassNote(note,duration,when,section=null,variant='A')");
  const end=html.indexOf("\nfunction updateMixVolumes",start);
  const play=html.slice(start,end);
  assert.match(play,/body\.triggerAttackRelease\(frequency,duration,when,velocity\)/,"main bass body must keep the original pitch and timing");
  assert.match(play,/sub\.triggerAttackRelease\(frequency,duration,when,velocity\*\.72\)/,"sub foundation must be phase-aligned to the main note");
  assert.match(play,/attack\.triggerAttackRelease\(Tone\.Frequency\(pitch\+12,'midi'\)\.toNote\(\),'32n',when/,"transient must use an octave harmonic at the same start time");
  assert.match(html,/playBassNote\(note,duration,audioAt,activeSection,chordVariant\)/,"sequencer must schedule all bass layers from the same audio timestamp");
  assert.match(html,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:bassForExport\.map/,"layering must export a normal bass note timeline");
});


test("TL-70 piano and guitar accompaniment creates genuinely different A B C chord roles", async () => {
  const html=await readFile(beatLabPath,"utf8");
  for(const id of ["piano-enabled","piano-volume","guitar-enabled","guitar-volume"])assert.match(html,new RegExp('id="'+id+'"'),id+" control must exist");
  assert.match(html,/function getPianoSynth\(\)[\s\S]*?new Tone\.PolySynth/,"piano must have its own polyphonic voice");
  assert.match(html,/function getGuitarSynth\(\)[\s\S]*?new Tone\.PluckSynth/,"guitar must have a plucked voice");
  assert.match(html,/function updateMixVolumes\(\)[\s\S]*?pianoBus\.gain\.rampTo[\s\S]*?guitarBus\.gain\.rampTo/,"piano and guitar must have independent mix controls");
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
  assert.match(html,/getPlayableChordEvents\(baseProject,APP\.bars,APP\.timeSig,chordVariant\)/,"active A/B/C selection must drive accompaniment");
  assert.match(html,/getPianoSynth\(\)\.triggerAttackRelease/,"piano chord events must be played");
  assert.match(html,/getGuitarSynth\(\)\.triggerAttack/,"guitar plucks must be played");
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
  assert.match(html,/const bassNotes=buildBassVariantNotes\(bassSeed,APP\.bars,APP\.timeSig,chordVariant\)/,"active A/B/C selection must drive bass arrangement");
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
  assert.equal(notes.length,8,"each four-beat chord should yield root and fifth bass notes");
  assert.equal(notes[0].pitch,33,"A minor root should be in the bass register");
  assert.equal(notes[0].startBeat,0);
  assert.equal(notes[1].startBeat,2);
  assert.ok(notes.every(n=>n.pitch>=24&&n.pitch<=60),"generated bass notes must remain in playable bass range");
  const stringProject={chords:["C","Am","F","G"]};
  const stringNotes=buildBass(stringProject,4,4);
  assert.equal(stringNotes.length,8,"plain chord-name arrays must also generate bass notes");
  assert.match(html,/importedBass\.length\?importedBass:buildBassNotesFromChords/,"explicit bass timeline must take precedence over generated fallback");
});


test("TL-74 selected A B C accompaniment timelines round-trip into score-editor piano and guitar tracks", async () => {
  const beat=await readFile(beatLabPath,"utf8");
  const score=await readFile(path.join(here,"..","apps","score-editor-v2.html"),"utf8");
  assert.match(beat,/bass: \{\.\.\.\(base\.bass\|\|\{\}\),notes:bassForExport\.map/,"selected bass candidate must be exported as an explicit timeline");
  assert.match(beat,/piano: \{notes:exportTimeline\(chordEventsForExport\.piano\)\}/,"piano arrangement must export note events");
  assert.match(beat,/guitar: \{notes:exportTimeline\(chordEventsForExport\.guitar\)\}/,"guitar arrangement must export note events");
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
  assert.match(canvas,/project\.chords=project\.generatedMusic\?\.chords\|\|window\.__lastDrumProject\?\.chords/,"Canvas → Beat Lab must restore saved chord progression");
  assert.match(canvas,/bass:project\.bass\|\|\{notes:\[\]\},piano:project\.piano\|\|\{notes:\[\]\},guitar:project\.guitar\|\|\{notes:\[\]\}/,"Beat Lab → Canvas must save accompaniment timelines");
  assert.match(canvas,/project\.bass=saved\.bass\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore bass");
  assert.match(canvas,/project\.piano=saved\.piano\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore piano");
  assert.match(canvas,/project\.guitar=saved\.guitar\|\|\{notes:\[\]\}/,"resuming Beat Lab must restore guitar");
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
  assert.match(html,/guitarToneFilter=new Tone\.Filter\(155,'highpass'\)\.connect\(guitarPan\)/,"guitar bus must leave more low-frequency room for bass");
  assert.match(html,/pianoBus=new Tone\.Gain\([^;]*\)\.connect\(pianoToneFilter\)/,"piano level must remain independently adjustable before filtering");
  assert.match(html,/guitarBus=new Tone\.Gain\([^;]*\)\.connect\(guitarToneFilter\)/,"guitar level must remain independently adjustable before filtering");
});


test("TL-78 piano and guitar occupy subtly separated stereo positions", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/pianoPan=new Tone\.Panner\(-\.16\)\.toDestination\(\)/,"piano should sit slightly left of center");
  assert.match(html,/guitarPan=new Tone\.Panner\(\.18\)\.toDestination\(\)/,"guitar should sit slightly right of center");
  assert.match(html,/pianoToneFilter=new Tone\.Filter\(105,'highpass'\)\.connect\(pianoPan\)/,"piano filter must feed its stereo position");
  assert.match(html,/guitarToneFilter=new Tone\.Filter\(155,'highpass'\)\.connect\(guitarPan\)/,"guitar filter must feed its stereo position");
});


test("TL-79 sampled piano loads lazily with synth fallback and distinct electric guitar path", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/new Tone\.Sampler\(\{urls:\{C2:'C2\.mp3',C3:'C3\.mp3',C4:'C4\.mp3',C5:'C5\.mp3',C6:'C6\.mp3'\}/,"piano must load multi-register Salamander piano samples");
  assert.match(html,/baseUrl:'https:\/\/tonejs\.github\.io\/audio\/salamander\//,"piano samples must use the public Salamander sample set");
  assert.match(html,/const sampler=getPianoSampler\(\);[\s\S]*?if\(pianoSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getPianoSynth\(\)\.triggerAttackRelease/,"piano playback must fall back to the synth while samples load or fail");
  assert.match(html,/new Tone\.PluckSynth\(\{attackNoise:[\s\S]*?\}\)\.connect\(getGuitarBus\(\)\)/,"acoustic guitar must retain a plucked-string voice");
  assert.match(html,/new Tone\.PolySynth\(Tone\.Synth,\{oscillator:\{type:'fatsawtooth',count:3,spread:9\}/,"electric guitar must use a separate sustained voice");
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
  assert.match(html,/playBassNote\(note,duration,audioAt,activeSection,chordVariant\)/,"live bass playback must receive section and selected arrangement");
});


test("TL-81 section-specific bass timbre changes are scheduled at note audio timestamps", async () => {
  const html=await readFile(beatLabPath,"utf8");
  const start=html.indexOf("function playBassNote(note,duration,when,section=null,variant='A')");
  const end=html.indexOf("\nfunction updateMixVolumes",start);
  assert.ok(start>=0&&end>start);
  const play=html.slice(start,end);
  for(const expression of ["body.filter.frequency.setValueAtTime(tone.filterHz,when)","body.volume.setValueAtTime(tone.bodyDb,when)","sub.volume.setValueAtTime(tone.subDb,when)","attack.volume.setValueAtTime(tone.attackDb,when)"]){
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
  assert.match(html,/Cs2:'Cs2\.mp3'[\s\S]*?C6:'C6\.mp3'/,"electric guitar sampler should map notes across its playable range");
  assert.match(html,/Cs1:'Cs1\.mp3'[\s\S]*?Cs4:'Cs4\.mp3'/,"bass sampler should map the low register");
  assert.match(html,/if\(electricGuitarSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getElectricGuitarSynth\(\)\.triggerAttackRelease/);
  assert.match(html,/if\(guitarSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else getGuitarSynth\(\)\.triggerAttack/);
  assert.match(html,/if\(bassSamplerReady&&sampler\)sampler\.triggerAttackRelease[\s\S]*?else body\.triggerAttackRelease/);
  assert.match(html,/if\(bassSampler\)bassSampler\.releaseAll\(\)/);
  assert.match(html,/if\(guitarSampler\)guitarSampler\.releaseAll\(\)/);
  assert.match(html,/if\(electricGuitarSampler\)electricGuitarSampler\.releaseAll\(\)/);
});

test("TL-83 instrument buses feed a shared master compressor and limiter", async () => {
  const html=await readFile(beatLabPath,"utf8");
  assert.match(html,/masterLimiter=new Tone\.Limiter\(-1\)\.toDestination\(\)/);
  assert.match(html,/masterCompressor=new Tone\.Compressor\(\{threshold:-15,ratio:1\.7/);
  assert.match(html,/drumCompressor\)\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/bassCompressor\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/guitarCompressor=new Tone\.Compressor\([\s\S]*?\.connect\(guitarPan\)/);
  assert.match(html,/pianoPan=new Tone\.Panner\(-\.16\)\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/guitarPan=new Tone\.Panner\(\.2\)\.connect\(getMasterBus\(\)\)/);
  assert.match(html,/getBassSamplerFilter\(\),v=>bassSamplerReady=v/,"sampled bass must pass through its tone-shaping filter");
});
