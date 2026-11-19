import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvasPath = path.join(here, "..", "apps", "composition-canvas.html");

function extractFunction(source, name, nextName) {
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("function " + nextName + "(", start + 1);
  assert.notEqual(start, -1, name + " exists");
  assert.notEqual(end, -1, nextName + " boundary exists");
  return source.slice(start, end).trim();
}

test("actual Canvas converter preserves A/B utterances without inventing chorus text", async () => {
  const html = await readFile(canvasPath, "utf8");
  const converter = extractFunction(html, "convertDialogueToLyricDraft", "lyricSectionsRead");
  const elements = {
    "duet-canvas-a": { value: "" },
    "duet-canvas-b": { value: "" },
    "duet-canvas-chorus": { value: "" },
    "duet-canvas-bridge": { value: "" }
  };
  let writtenSections = null;
  const context = {
    window: { __incomingLyricProject: { dialogue: [
      { speaker: "A", role: "user", text: "I missed the last train." },
      { speaker: "B", role: "assistant", text: "That sounds frustrating." },
      { speaker: "A", role: "user", text: "I will walk home tonight." },
      { speaker: "B", role: "assistant", text: "I can keep you company." }
    ] } },
    document: { getElementById: id => elements[id] },
    lyricSectionsWrite: sections => { writtenSections = sections; },
    lyricRenderPreview: () => {},
    showToast: () => {}
  };
  vm.runInNewContext(converter + "; convertDialogueToLyricDraft();", context);
  assert.equal(elements["duet-canvas-a"].value, "I missed the last train.\nI will walk home tonight.");
  assert.equal(elements["duet-canvas-b"].value, "That sounds frustrating.\nI can keep you company.");
  assert.equal(elements["duet-canvas-chorus"].value, "");
  assert.equal(elements["duet-canvas-bridge"].value, "");
  assert.deepEqual(JSON.parse(JSON.stringify(writtenSections)).map(x => x.role), ["A", "B"]);
});

test("Canvas project return carries stable identity and source dialogue to specialist apps", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /projectId:window\.__musicProjectId\|\|incoming\.projectId/);
  assert.match(html, /dialogue:incoming\.dialogue\|\|incoming\.sourceDialogue/);
  assert.ok(html.includes("kind:incoming.kind||"));
  assert.match(html, /const hasLyrics=!!lyricTextRead\(\)\|\|!!window\.__incomingLyricProject\?\.dialogue/);
  const vocalStart = html.indexOf("function sendToVocalLab()");
  assert.doesNotMatch(html.slice(vocalStart, vocalStart + 900), /送信するメロディがありません/);
});

test("Vocal Lab no longer substitutes fictional duet lyrics", async () => {
  const vocalPath = path.join(here, "..", "apps", "vocal-lab-v3.html");
  const html = await readFile(vocalPath, "utf8");
  assert.doesNotMatch(html, /It's almost midnight, I should close my eyes/);
  assert.doesNotMatch(html, /onclick="sendLyricToChordLab/);
  assert.match(html, /\$\('duet-a'\)\.value=a\.join/);
  assert.match(html, /\$\('duet-b'\)\.value=b\.join/);
});


test("inline JavaScript in the connected music apps parses without syntax errors", async () => {
  const appPaths = [
    path.join(here, "..", "apps", "composition-canvas.html"),
    path.join(here, "..", "apps", "vocal-lab-v3.html"),
    path.join(here, "..", "apps", "chord-lab.html"),
    path.join(here, "..", "apps", "beat-lab.html"),
    path.join(here, "..", "apps", "score-editor-v2.html")
  ];
  for (const file of appPaths) {
    const html = await readFile(file, "utf8");
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .filter(code => code.trim());
    assert.ok(scripts.length > 0, path.basename(file) + " has inline scripts");
    scripts.forEach((code, index) => {
      assert.doesNotThrow(() => new vm.Script(code, { filename: path.basename(file) + "#" + index }));
    });
  }
});


test("Score Editor preserves the same project and returns it to Composition Canvas", async () => {
  const scorePath = path.join(here, "..", "apps", "score-editor-v2.html");
  const score = await readFile(scorePath, "utf8");
  const canvas = await readFile(canvasPath, "utf8");
  assert.match(score, /function sendToCompositionCanvas\(\)/);
  assert.match(score, /window\.__compositionProjectContext=data/);
  assert.match(score, /projectId:context\.projectId/);
  assert.match(canvas, /payload\.source==='score-editor'/);
});


test("Canvas creates three melody variants and three rhythm choices with playable durations", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /id="composition-arrangement"/);
  assert.match(html, /id="composition-melody-choices"/);
  assert.match(html, /id="composition-rhythm-choices"/);
  assert.match(html, /id:'hook',name:'A：覚えやすいフック型'/);
  assert.match(html, /id:'rise',name:'B：高揚する上昇型'/);
  assert.match(html, /id:'arch',name:'C：大きな弧を描く型'/);
  assert.match(html, /id:'straight',name:'ストレート'/);
  assert.match(html, /id:'syncopated',name:'シンコペーション'/);
  assert.match(html, /id:'ballad',name:'バラード'/);
  assert.match(html, /async function playSelectedComposition\(\)/);
  assert.match(html, /function applySelectedComposition\(\)/);
  const build = extractFunction(html, "buildSelectedCompositionNotes", "applySelectedComposition");
  const arrangement = {
    selectedMelody: "rise",
    selectedRhythm: "syncopated",
    melodyVariants: [{ id: "rise", notes: [
      { id: "n1", note: "C4", word: "I" },
      { id: "n2", note: "D4", word: "wish" },
      { id: "n3", note: "E4", word: "tonight" }
    ] }],
    rhythmStyles: [{ id: "syncopated", beats: [0.75, 0.25, 0.5] }]
  };
  const context = { window: { __compositionArrangement: arrangement } };
  vm.runInNewContext(build + "; result=buildSelectedCompositionNotes();", context);
  const notes = context.result;
  assert.deepEqual(JSON.parse(JSON.stringify(notes.map(n => n.startBeat))), [0, 0.75, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(notes.map(n => n.durationBeats))), [0.75, 0.25, 0.5]);
  assert.equal(notes.length, 3);
});


test("Canvas builds independent melody, chord, bass, drum and lyric tracks on one beat timeline", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /id="composition-multitrack"/);
  assert.match(html, /function buildCompositionTracks\(melodyNotes\)/);
  assert.match(html, /function renderTrackTimeline\(track,totalBeats\)/);
  assert.match(html, /function renderStaffSvg\(track,totalBeats\)/);
  assert.match(html, /function setCompositionTrackMode\(id,mode\)/);
  assert.match(html, /soloTracks\.length\?soloTracks:tracks\.filter\(t=>!t\.muted\)/);
  const builder = extractFunction(html, "buildCompositionTracks", "setCompositionTrackMode");
  const arrangement = {
    bpm: 96, selectedRhythm: "syncopated",
    chordSections: [{ label: "Verse", progression: [
      { id: "c1", chord: "C", tones: [0,4,7], beats: 4 },
      { id: "c2", chord: "G", tones: [7,11,2], beats: 4 }
    ] }]
  };
  const context = {
    window: { __compositionArrangement: arrangement },
    lyricSectionsRead: () => [{ label: "Verse", role: "A", text: "Hello world" }]
  };
  vm.runInNewContext(builder + "; result=buildCompositionTracks([{id:'m1',note:'C4',startBeat:0,durationBeats:0.5,lyric:'Hello world',role:'A',section:'Verse'},{id:'m2',note:'E4',startBeat:0.5,durationBeats:0.5,lyric:'Hello world',role:'A',section:'Verse'}]);", context);
  const tracks = context.result;
  assert.deepEqual(JSON.parse(JSON.stringify(tracks.map(t => t.id))), ["melody","chords","bass","drums","lyrics"]);
  assert.equal(tracks[0].notes.length, 2);
  assert.equal(tracks[1].notes.length, 2);
  assert.equal(tracks[2].notes.length, 2);
  assert.ok(tracks[3].notes.some(n => n.kind === "kick"));
  assert.equal(tracks[4].notes[0].startBeat, 0);
  assert.equal(tracks[4].notes[0].durationBeats, 1);
});

test("Canvas sends all arranged tracks to Score Editor and Score Editor imports and returns track collections", async () => {
  const canvas = await readFile(canvasPath, "utf8");
  const scorePath = path.join(here, "..", "apps", "score-editor-v2.html");
  const score = await readFile(scorePath, "utf8");
  assert.match(canvas, /tracks:trackPackage/);
  assert.match(canvas, /function restoreCompositionTracksFromScore\(payload\)/);
  assert.match(canvas, /restoreCompositionTracksFromScore\(payload\)/);
  assert.match(score, /if\(Array\.isArray\(data\.tracks\)&&data\.tracks\.length\)/);
  assert.match(score, /tracks:PROJ\.tracks\.map\(track=>/);
});


test("Canvas renders treble and bass staves with measure rulers and duration-positioned track clips", async () => {
  const html = await readFile(canvasPath, "utf8");
  const helpers = html.slice(html.indexOf("function midiStaffPosition("), html.indexOf("function renderCompositionTracks("));
  const context = { noteToMidi: note => ({C4:60,D4:62,E4:64,G2:43,C3:48}[note] ?? 60), escapeHtmlCanvas: value => String(value) };
  vm.runInNewContext(helpers + "; result={treble:renderStaffSvg({id:'melody',name:'Lead',kind:'pitched',notes:[{note:'C4',startBeat:0,durationBeats:1}]},8),bass:renderStaffSvg({id:'bass',name:'Bass',kind:'pitched',notes:[{midi:43,startBeat:0,durationBeats:2}]},8),timeline:renderTrackTimeline({id:'melody',name:'Lead',kind:'pitched',notes:[{note:'C4',startBeat:1,durationBeats:2}]},8)};", context);
  assert.match(context.result.treble, /𝄞/);
  assert.match(context.result.bass, /𝄢/);
  assert.equal((context.result.treble.match(/stroke="#9bb3b8" stroke-width="1"/g) || []).length, 5);
  assert.match(context.result.timeline, /width="82"/);
  assert.match(context.result.timeline, /C4/);
});


test("Composition arrangement is persisted by project identity and restores all tracks", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /function compositionArrangementStorageKey\(\)/);
  assert.match(html, /localStorage\.setItem\(key,JSON\.stringify\(arrangement\)\)/);
  assert.match(html, /function restoreSavedCompositionArrangement\(\)/);
  assert.match(html, /restoreSavedCompositionArrangement\(\)/);
  assert.match(html, /project\.drums=drumTrack\?/);
  assert.match(html, /project\.tracks=arrangedTracks\.filter/);
  const scorePath = path.join(here, "..", "apps", "score-editor-v2.html");
  const score = await readFile(scorePath, "utf8");
  assert.match(score, /tracks:PROJ\.tracks\.map\(track=>/);
});


test("Canvas receives speak-native lyrics imports and restores the lyrics into the editor", async () => {
  const html = await readFile(canvasPath, "utf8");
  assert.match(html, /hash\.startsWith\('import='\)/);
  assert.match(html, /payload\.source==='composition-canvas-lyrics'/);
  assert.match(html, /restoreLyricCanvasProject\(payload\)/);
  assert.match(html, /document\.getElementById\('canvas-lyrics'\)\.value=project\.lyrics\|\|''/);
  assert.match(html, /document\.getElementById\('lyric-panel'\)\.classList\.add\('show'\)/);
  assert.match(html, /history\.replaceState\(null,'' ,location\.pathname\+location\.search\)/);
});
