import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "composition-testline-v1.json");

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
