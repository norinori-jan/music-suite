import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import engine from "../apps/lyric-composition-engine.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syllables = (words, role, label, phraseIndex = 0) => words.map((word, index) => ({
  word, wordIndex:index, syllableIndex:0, wordSyllables:1,
  stressed:!["the","and","to","a"].includes(word.toLowerCase()),
  functionWord:["the","and","to","a"].includes(word.toLowerCase()),
  role, label, phrase:"", phraseIndex
}));

test("LC-01 builds a complete, contiguous 32-bar form", () => {
  const result = engine.generate({key:"C",mood:"hope",progression:"pop",phraseGroups:[]});
  assert.equal(result.bars,32);
  assert.deepEqual(result.structure.map(s=>[s.startBar,s.endBar]),[[1,4],[5,8],[9,12],[13,16],[17,24],[25,28],[29,32]]);
  assert.equal(result.chords.length,32);
  assert.deepEqual(result.chords.map(c=>c.bar),Array.from({length:32},(_,i)=>i+1));
  assert.ok(result.chords.every(c=>c.beats===4));
});

test("LC-02 pre-chorus builds dominant tension and chorus resolves into a clear release", () => {
  const result = engine.generate({key:"C",mood:"bright",progression:"pop",phraseGroups:[]});
  const pre = result.chordSections.find(s=>s.id==="preChorus").progression;
  const chorus = result.chordSections.find(s=>s.id==="chorus").progression;
  assert.equal(pre.at(-1).degree,5);
  assert.equal(chorus[0].degree,1);
  assert.equal(chorus.at(-1).degree,5);
  assert.equal(result.chordSections.find(s=>s.id==="outro").progression.at(-1).degree,1);
});

test("LC-03 section-aware lyric groups are placed in their matching form sections", () => {
  const groups = [
    {role:"A",label:"Mia / A verse",text:"I walk through morning",phraseIndex:0,syllables:syllables(["I","walk","through","morning"],"A","Mia / A verse")},
    {role:"B",label:"Ken / B verse",text:"The night is fading",phraseIndex:1,syllables:syllables(["The","night","is","fading"],"B","Ken / B verse")},
    {role:"DUET",label:"Chorus",text:"We will rise again",phraseIndex:2,syllables:syllables(["We","will","rise","again"],"DUET","Chorus")},
    {role:"DUET",label:"Bridge",text:"Hold on to hope",phraseIndex:3,syllables:syllables(["Hold","on","to","hope"],"DUET","Bridge")}
  ];
  const result = engine.generate({key:"G",mood:"hope",progression:"warm",phraseGroups:groups});
  const roleBars = role => result.melody.filter(n=>n.sectionRole===role).map(n=>Math.floor(n.startBeat/4)+1);
  assert.ok(roleBars("verseA").every(bar=>bar>=5&&bar<=8));
  assert.ok(roleBars("verseB").every(bar=>bar>=9&&bar<=12));
  assert.ok(roleBars("chorus").every(bar=>bar>=17&&bar<=24));
  assert.ok(roleBars("bridge").every(bar=>bar>=25&&bar<=28));
});

test("LC-04 melody preserves lyric syllables and exposes stress, phrase and motif metadata", () => {
  const words = ["The","bright","stars","are","calling","home"];
  const groups = [{role:"DUET",label:"Chorus",text:words.join(" "),phraseIndex:7,syllables:syllables(words,"DUET","Chorus",7)}];
  const result = engine.generate({key:"D",mood:"hope",progression:"pop",phraseGroups:groups});
  const lyricNotes = result.melody.filter(n=>n.lyricId && n.sectionRole==="chorus");
  assert.deepEqual(lyricNotes.map(n=>n.word),words);
  assert.ok(lyricNotes.some(n=>n.importantWord));
  assert.ok(lyricNotes.every(n=>n.motifId && Number.isFinite(n.startBeat) && n.length>0));
  assert.ok(lyricNotes.at(-1).phraseEnd);
});

test("LC-05 chorus hook peaks and outro callback are generated without lyric duplication", () => {
  const words = ["We","will","find","the","light","tonight"];
  const groups = [{role:"DUET",label:"Chorus",text:words.join(" "),phraseIndex:0,syllables:syllables(words,"DUET","Chorus")}];
  const result = engine.generate({key:"C",mood:"bright",progression:"pop",phraseGroups:groups});
  const hooks = result.melody.filter(n=>n.hookPeak);
  const outro = result.melody.filter(n=>n.sectionRole==="outro");
  assert.ok(hooks.length>0);
  assert.ok(outro.length>0);
  assert.ok(outro.every(n=>n.lyric==="" && n.lyricId===null && n.motifVariation==="outro-callback"));
  assert.ok(outro.every(n=>n.startBeat>=112 && n.startBeat<128));
});

test("LC-06 Composition Canvas loads and calls the separate engine while retaining project handoff", async () => {
  const html = await readFile(path.join(root,"apps","composition-canvas.html"),"utf8");
  assert.match(html,/src="lyric-composition-engine\.js"/);
  assert.match(html,/LyricCompositionEngine\.generate/);
  assert.match(html,/structure:composition\.structure/);
  assert.match(html,/chordSections,chords:allSectionChords/);
  assert.match(html,/project\.generatedMusic=window\.__lyricMusicSketch/);
  assert.match(html,/project\.roundTripBaseline=createCompositionSnapshot/);
  assert.match(html,/function restoreLyricCanvasProject/);
});

test("LC-07 rejects unsupported keys rather than silently generating invalid harmony", () => {
  assert.throws(()=>engine.generate({key:"F#",phraseGroups:[]}),/Unsupported key/);
});

test("LC-08 chorus motif is introduced instrumentally and reprised in the outro", () => {
  const words = ["We","will","find","the","light","tonight"];
  const groups = [{role:"DUET",label:"Chorus",text:words.join(" "),phraseIndex:0,syllables:syllables(words,"DUET","Chorus")}];
  const result = engine.generate({key:"C",mood:"bright",progression:"pop",phraseGroups:groups});
  const intro = result.melody.filter(n=>n.sectionRole==="intro");
  const outro = result.melody.filter(n=>n.sectionRole==="outro");
  assert.ok(intro.length>0);
  assert.ok(outro.length>0);
  assert.ok(intro.every(n=>n.lyricId===null && n.startBeat<16 && n.motifVariation==="intro-statement"));
  assert.ok(outro.every(n=>n.lyricId===null && n.startBeat>=112 && n.motifVariation==="outro-callback"));
});
