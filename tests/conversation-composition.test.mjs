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


test("inline JavaScript in the four connected apps parses without syntax errors", async () => {
  const appPaths = [
    path.join(here, "..", "apps", "composition-canvas.html"),
    path.join(here, "..", "apps", "vocal-lab-v3.html"),
    path.join(here, "..", "apps", "chord-lab.html"),
    path.join(here, "..", "apps", "beat-lab.html")
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
