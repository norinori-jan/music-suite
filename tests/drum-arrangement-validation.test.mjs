import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/beat-lab.html', import.meta.url), 'utf8');
const helperStart = html.indexOf('function normalizeTimelineBars');
const helperEnd = html.indexOf('function sectionPatternFrom', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'timeline validation helpers must be present');
const { normalizeTimelineBars, buildArrangementBarRanges, isValidArrangementTimeline } =
  new Function(html.slice(helperStart, helperEnd) + '\nreturn {normalizeTimelineBars,buildArrangementBarRanges,isValidArrangementTimeline};')();

function sectionsFor(bars) {
  const ids = ['intro','verse','chorus','bridge','final'];
  return buildArrangementBarRanges(bars).map((range,index) => ({
    id: ids[index], ...range, pattern: {}, effects: {}
  }));
}

test('timeline bar count rejects NaN, null-like and out-of-range values', () => {
  assert.equal(normalizeTimelineBars('NaN', 8, 1), 8);
  assert.equal(normalizeTimelineBars('null', 8, 1), 8);
  assert.equal(normalizeTimelineBars('33', 8, 1), 8);
  assert.equal(normalizeTimelineBars('2', 8, 5), 8);
  assert.equal(normalizeTimelineBars('24', 8, 5), 24);
});

test('five generated sections are contiguous and exactly cover the song', () => {
  for (const bars of [5, 8, 16, 24, 32]) {
    const sections = sectionsFor(bars);
    assert.equal(sections.length, 5);
    assert.equal(sections[0].startBar, 1);
    assert.equal(sections.at(-1).endBar, bars);
    assert.equal(isValidArrangementTimeline(sections, bars), true);
    for (let index=1; index<sections.length; index++) {
      assert.equal(sections[index].startBar, sections[index-1].endBar + 1);
    }
  }
});

test('invalid, overlapping, gapped, reversed and non-integer ranges are rejected', () => {
  const bars = 16;
  const mutations = [
    section => { section.startBar = null; },
    section => { section.endBar = NaN; },
    section => { section.startBar = 0; },
    section => { section.endBar = section.startBar - 1; },
    section => { section.startBar += 1; },
    section => { section.endBar = bars + 1; }
  ];
  for (const mutate of mutations) {
    const sections = sectionsFor(bars);
    mutate(sections[2]);
    assert.equal(isValidArrangementTimeline(sections, bars), false);
  }
  assert.equal(isValidArrangementTimeline(sectionsFor(bars).slice(0,4), bars), false);
  assert.equal(isValidArrangementTimeline(sectionsFor(bars), NaN), false);
});

test('restore reconstructs invalid saved sections and playback/generation guard malformed timelines', () => {
  assert.match(html, /if\(!valid\)\{[\s\S]*?buildArrangementBarRanges\(APP\.bars\)/);
  assert.match(html, /function createDrumCandidates\(\)\{\s*if\(!isValidArrangementTimeline\(APP\.sections,APP\.bars\)\)/);
  assert.match(html, /function playDrumCandidateOnly\(\)\{\s*if\(!isValidArrangementTimeline\(APP\.sections,APP\.bars\)\)/);
  assert.match(html, /function applyDrumCandidateState\(id\)\{\s*if\(!\['A','B','C'\]\.includes\(id\)\|\|!isValidArrangementTimeline/);
});

test('step-grid rendering sanitizes bars, division and time signature before calculating steps', () => {
  const start = html.indexOf('function renderStepGrid(){');
  const end = html.indexOf('\nfunction cellClick', start);
  assert.ok(start >= 0 && end > start);
  const body = html.slice(start,end);
  assert.match(body, /APP\.bars=normalizeTimelineBars\(barsInput\?\.value,APP\.bars,1\)/);
  assert.match(body, /\[8,16,32\]\.includes\(Number\(divInput\?\.value\)\)/);
  assert.match(body, /\[3,4,6\]\.includes\(Number\(timeSigInput\?\.value\)\)/);
});
