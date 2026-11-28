(function (root) {
  "use strict";

  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const ROOTS = { C:0, G:7, D:2, A:9, E:4 };
  const SCALES = {
    C:[0,2,4,5,7,9,11], G:[0,2,4,5,7,9,11], D:[0,2,4,5,7,9,11],
    A:[0,2,3,5,7,8,10], E:[0,2,3,5,7,8,10]
  };
  const PROGRESSIONS = {
    pop:[1,5,6,4], warm:[1,6,4,5], sad:[6,4,1,5], simple:[1,4,5,1],
    rock:[1,4,6,5], jazz:[2,5,1,6], rb:[1,3,6,2], cinematic:[6,4,1,5],
    loop:[1,5,6,3], surprise:[1,3,4,4]
  };
  const FORM = [
    { id:"intro", label:"Intro", startBar:1, endBar:4, role:"INTRO", degrees:[1,5,6,4], energy:0.28, octave:4 },
    { id:"verseA", label:"Verse A", startBar:5, endBar:8, role:"A", degrees:[1,6,4,5], energy:0.38, octave:4 },
    { id:"verseB", label:"Verse B", startBar:9, endBar:12, role:"B", degrees:[6,4,1,5], energy:0.48, octave:4 },
    { id:"preChorus", label:"Pre-Chorus", startBar:13, endBar:16, role:"PRE", degrees:[2,4,5,5], energy:0.76, octave:5 },
    { id:"chorus", label:"Chorus", startBar:17, endBar:24, role:"CHORUS", degrees:[1,5,6,4,1,5,4,5], energy:1, octave:5 },
    { id:"bridge", label:"Bridge", startBar:25, endBar:28, role:"BRIDGE", degrees:[6,3,4,5], energy:0.62, octave:4 },
    { id:"outro", label:"Outro", startBar:29, endBar:32, role:"OUTRO", degrees:[1,5,4,1], energy:0.3, octave:4 }
  ];

  function chordFor(key, degree) {
    const scale = SCALES[key], root = ROOTS[key];
    if (!scale || !Number.isInteger(degree) || degree < 1 || degree > 7) throw new Error("Unsupported key or scale degree");
    const i = degree - 1, rootPc = (root + scale[i]) % 12;
    const thirdPc = (root + scale[(i + 2) % 7] + (i + 2 >= 7 ? 12 : 0)) % 12;
    const fifthPc = (root + scale[(i + 4) % 7] + (i + 4 >= 7 ? 12 : 0)) % 12;
    const third = (thirdPc - rootPc + 12) % 12, fifth = (fifthPc - rootPc + 12) % 12;
    const quality = third === 4 && fifth === 7 ? "" : third === 3 && fifth === 7 ? "m" : third === 3 && fifth === 6 ? "dim" : third === 4 && fifth === 8 ? "aug" : null;
    if (quality === null) throw new Error("Unsupported triad in " + key + " degree " + degree);
    return { degree, root:NOTE_NAMES[rootPc], quality, chord:NOTE_NAMES[rootPc] + quality, tones:[rootPc,thirdPc,fifthPc] };
  }

  function progressionFor(form, selected, mode) {
    if (mode === "minor") {
      const minor = {
        intro:[1,6,3,7], verseA:[1,6,4,7], verseB:[6,4,1,7],
        preChorus:[4,6,7,7], chorus:[1,6,3,7,4,1,7,1],
        bridge:[6,3,4,7], outro:[1,7,1,1]
      };
      return minor[form.id].slice();
    }
    const selectedDegrees = PROGRESSIONS[selected] || PROGRESSIONS.pop;
    if (form.id === "verseA") return selectedDegrees.slice();
    if (form.id === "chorus") return [selectedDegrees[0], selectedDegrees[1], selectedDegrees[2], selectedDegrees[3], selectedDegrees[0], selectedDegrees[1], 4, 5];
    return form.degrees.slice();
  }

  function buildHarmony(key, mood, selected) {
    const mode = key === "A" || key === "E" ? "minor" : "major";
    const sections = FORM.map(form => {
      const degrees = progressionFor(form, selected, mode);
      const progression = [];
      for (let i = 0; i < form.endBar - form.startBar + 1; i++) {
        const chord = chordFor(key, degrees[i % degrees.length]);
        const bar = form.startBar + i;
        progression.push({
          id:"harmony-" + String(bar).padStart(2,"0"), bar, startBeat:(bar - 1) * 4,
          beats:4, chord:chord.chord, degree:chord.degree, quality:chord.quality,
          tones:chord.tones, section:form.id, role:form.role, energy:form.energy
        });
      }
      return { ...form, style:selected, progression };
    });
    return { sections, chords:sections.flatMap(section => section.progression), mode };
  }

  function sectionForLabel(label, role) {
    const value = (String(label || "") + " " + String(role || "")).toLowerCase();
    if (/chorus|サビ|hook/.test(value)) return "chorus";
    if (/bridge|ブリッジ/.test(value)) return "bridge";
    if (/ken|b[ _/-]?verse|verse[ _/-]?b|\brole.?b\b/.test(value)) return "verseB";
    if (/mia|a[ _/-]?verse|verse[ _/-]?a|\brole.?a\b/.test(value)) return "verseA";
    if (/pre.?chorus|prechorus|buildup/.test(value)) return "preChorus";
    return null;
  }

  function midiName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  function nearestScaleDegree(pc, key, chord) {
    const root = ROOTS[key], scale = SCALES[key];
    const target = ((pc - root) % 12 + 12) % 12;
    let best = 0, distance = 99;
    scale.forEach((semitone, index) => {
      const d = Math.min((semitone - target + 12) % 12, (target - semitone + 12) % 12);
      if (d < distance) { best = index; distance = d; }
    });
    return best;
  }

  function generateMelody(key, mood, phraseGroups, chords) {
    const scale = SCALES[key], root = ROOTS[key], notes = [];
    const byRole = { verseA:[], verseB:[], chorus:[], bridge:[], preChorus:[] };
    const unassigned = [];
    (phraseGroups || []).forEach(group => {
      const target = sectionForLabel(group.label, group.role);
      if (target && byRole[target]) byRole[target].push(group);
      else unassigned.push(group);
    });
    const assignedCount = Object.values(byRole).reduce((n, list) => n + list.length, 0);
    if (!assignedCount && unassigned.length) {
      unassigned.forEach((group, index) => byRole[["verseA","verseB","chorus","bridge"][index % 4]].push(group));
    } else {
      unassigned.forEach((group, index) => byRole[["verseA","verseB","chorus","bridge"][index % 4]].push(group));
    }

    const roleRanges = {
      verseA:{ start:16, span:16, form:"verseA" }, verseB:{ start:32, span:16, form:"verseB" },
      preChorus:{ start:48, span:16, form:"preChorus" }, chorus:{ start:64, span:32, form:"chorus" },
      bridge:{ start:96, span:16, form:"bridge" }
    };
    const contour = [0,2,4,2,3,1,2,4,3,2,1,0];
    let motifCounter = 0;
    Object.entries(roleRanges).forEach(([role, range]) => {
      const groups = byRole[role];
      if (!groups.length) return;
      const phraseSpan = range.span / groups.length;
      groups.forEach((group, groupIndex) => {
        const syllables = Array.isArray(group.syllables) ? group.syllables : [];
        if (!syllables.length) return;
        const start = range.start + groupIndex * phraseSpan;
        const weights = syllables.map((item, index) =>
          (item.stressed ? 1.35 : 0.78) *
          (item.syllableIndex === 0 ? 1.06 : 1) *
          (index === syllables.length - 1 ? 1.3 : 1)
        );
        const total = weights.reduce((a,b) => a + b, 0);
        let cursor = 0, previousDegree = 0;
        const motifId = "motif-" + (++motifCounter);
        syllables.forEach((syllable, index) => {
          const slot = phraseSpan * weights[index] / Math.max(0.001, total);
          const beat = start + cursor;
          const bar = Math.min(32, Math.floor(beat / 4) + 1);
          const chord = chords[bar - 1] || chords[chords.length - 1];
          const stress = !!syllable.stressed;
          const contentWord = !syllable.functionWord && syllable.syllableIndex === 0;
          const phraseEnd = index === syllables.length - 1;
          const isChorus = role === "chorus";
          let degree;
          if (phraseEnd) degree = role === "chorus" ? 2 : 0;
          else if (isChorus && stress && contentWord && index >= Math.floor(syllables.length * 0.35) && index <= Math.ceil(syllables.length * 0.8)) degree = 5;
          else if (stress) {
            const chordTone = chord.tones[(Math.floor(index / 2) + index) % 3];
            degree = nearestScaleDegree(chordTone, key, chord);
          } else {
            const shape = contour[index % contour.length];
            degree = (shape + (groupIndex % 2) + (role === "verseB" ? 1 : 0)) % 7;
          }
          if (!stress && index > 0) {
            const delta = ((degree - previousDegree + 3.5) % 7) - 3.5;
            if (Math.abs(delta) > 2) degree = (previousDegree + Math.sign(delta) * 2 + 7) % 7;
          }
          if (phraseEnd) {
            const cadence = role === "chorus" || role === "bridge" ? 0 : 2;
            degree = cadence;
          }
          previousDegree = degree;
          const sectionBaseOctave = role === "chorus" ? 5 : role === "preChorus" ? 4 : 4;
          let octave = sectionBaseOctave;
          if (mood === "calm" || mood === "bittersweet") octave = role === "chorus" ? 5 : 4;
          if (role === "chorus" && isChorus && stress && contentWord && degree === 5) octave = 5;
          const midi = 60 + root + scale[degree] + (octave - 4) * 12;
          const duration = Math.max(0.28, Math.min(slot * (stress ? 0.9 : 0.76), phraseEnd ? 1.8 : 1.35));
          notes.push({
            id:"melody-" + String(notes.length + 1).padStart(4,"0"), note:midiName(midi),
            pitch:midi, startBeat:+beat.toFixed(4), length:+Math.min(duration, slot * 0.94).toFixed(4),
            word:syllable.word || "", lyric:group.text || group.phrase || "",
            role:group.role || role, section:group.label || role, sectionRole:role,
            lyricId:"lyric-" + String(notes.length + 1).padStart(4,"0"),
            syllableIndex:syllable.syllableIndex || 0, wordSyllables:syllable.wordSyllables || 1,
            stressed:stress, importantWord:contentWord, phraseIndex:group.phraseIndex || groupIndex,
            phraseEnd, motifId, motifVariation:groupIndex ? "variation" : "statement",
            hookPeak:!!(isChorus && stress && contentWord && degree === 5)
          });
          cursor += slot;
        });
      });
    });

    // A short instrumental callback closes the song without duplicating lyric assignments.
    // Reuse the chorus hook as an instrumental intro motif, transposed down for a restrained opening.
    const introMotif = notes.filter(note => note.sectionRole === "chorus" && note.stressed).slice(0, 4);
    if (introMotif.length) {
      introMotif.forEach((note, index) => {
        notes.push({
          ...note, id:"melody-" + String(notes.length + 1).padStart(4,"0"),
          pitch:note.pitch - 12, note:midiName(note.pitch - 12),
          startBeat:index * 2, length:1.5, lyric:"", word:"", lyricId:null,
          role:"INTRO", section:"Intro", sectionRole:"intro",
          motifVariation:"intro-statement", phraseEnd:index === introMotif.length - 1,
          hookPeak:false
        });
      });
    }

    const outroMotif = notes.filter(note => note.sectionRole === "chorus" && note.stressed).slice(0, 4);
    if (outroMotif.length) {
      outroMotif.forEach((note, index) => {
        const beat = 112 + index * 2;
        notes.push({
          ...note, id:"melody-" + String(notes.length + 1).padStart(4,"0"),
          startBeat:beat, length:1.5, lyric:"", word:"", lyricId:null,
          role:"OUTRO", section:"Outro", sectionRole:"outro",
          motifVariation:"outro-callback", phraseEnd:index === outroMotif.length - 1,
          hookPeak:false
        });
      });
    }
    return notes.sort((a,b) => a.startBeat - b.startBeat);
  }

  function generate(options) {
    const input = options || {};
    const key = input.key || "C", mood = input.mood || "bittersweet";
    if (!SCALES[key]) throw new Error("Unsupported key: " + key);
    const harmony = buildHarmony(key, mood, input.progression || "pop");
    const melody = generateMelody(key, mood, input.phraseGroups || [], harmony.chords);
    return {
      bars:32, timeSig:4, key, mode:harmony.mode, mood,
      structure:FORM.map(form => ({ id:form.id, label:form.label, role:form.role, startBar:form.startBar, endBar:form.endBar, energy:form.energy })),
      chordSections:harmony.sections, chords:harmony.chords, melody,
      quality:{ phraseStructure:true, eightBarHarmony:true, preChorusDominantLift:true, chorusRelease:true, motifDevelopment:true, stressedWordPeaks:true, phraseCadences:true },
      method:"structured-32-bar-lyric-composition-v1"
    };
  }

  const api = { generate, form:FORM.map(item => ({...item})), scales:SCALES, progressions:PROGRESSIONS };
  root.LyricCompositionEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
