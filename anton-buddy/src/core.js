/*
 * Lösungs-Buddy – core.js
 * Liest die Lösungen direkt aus den Übungsdaten, die ANTON selbst lädt.
 * Läuft im Content-Script (globalThis.BuddyCore) und in Node (Tests).
 *
 * ANTON-Schreibweise (aus echten Übungen abgeleitet):
 *   "++Wort"            richtige Auswahl
 *   "--Wort"            falsche Auswahl
 *   "ein_Wort"          Unterstrich = Leerzeichen innerhalb einer Auswahl
 *   "((a ++b c))"       Lücke mit Auswahl, b ist richtig
 *   "((Haus))"          Lücke zum Schreiben, Lösung "Haus"
 *   "((das ein))"       ohne ++ sind alle Einträge gültige Lösungen
 *   "<gap>42</gap>"     Lücke in einer Rechnung
 */
(function (root) {
  'use strict';

  const ENTITIES = {
    nbsp: ' ', shy: '', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ndash: '–', mdash: '—', hellip: '…', times: '×', divide: '÷', middot: '·',
    euro: '€', deg: '°', bdquo: '„', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
    auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß'
  };

  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : m;
    });
  }

  const TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;

  /** HTML/Markup -> lesbarer Klartext */
  function clean(str) {
    if (typeof str === 'number') return String(str);
    if (typeof str !== 'string') return '';
    let s = str.replace(/^\s*ssml:\s*/i, '');
    s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<hr\s*\/?>/gi, ' ');
    s = s.replace(TAG_RE, '');
    s = decodeEntities(s);
    s = s.replace(/\u00AD/g, '').replace(/[\u00A0\u2007\u202F]/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Vergleichsform: klein, ohne weiche Trennzeichen, einheitliche Leerzeichen */
  function norm(str) {
    return clean(String(str == null ? '' : str))
      .toLowerCase()
      .replace(/[\u2018\u2019\u201A\u201B´`]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F«»]/g, '"')
      .replace(/[\u2212\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** "a ++b --c d_e" -> [{text, correct}]  (wie ANTONs convertPlusPlusString) */
  function parseChoices(str) {
    if (typeof str !== 'string') return [];
    let s = str.replace(/<br\s*\/?>/gi, '').replace(TAG_RE, '');
    s = s.replace(/&nbsp;/g, '_').replace(/\+\+\s+/g, '++').trim();
    // "++Pin++sel" -> zwei Einträge
    s = s.replace(/([^\s+])\+\+/g, '$1 ++');
    if (!s) return [];
    const hasPlus = s.includes('++');
    const out = [];
    for (const raw of s.split(/\s+/)) {
      if (!raw) continue;
      let text = raw, correct = !hasPlus;
      if (raw.startsWith('++')) { text = raw.slice(2); correct = true; }
      else if (raw.startsWith('--')) { text = raw.slice(2); correct = false; }
      text = clean(text.split('_').join(' '));
      if (text !== '') out.push({ text, correct });
    }
    return out;
  }

  const GAP_RE = /\(\(([\s\S]*?)\)\)|<gap>([\s\S]*?)<\/gap>/g;

  /**
   * Text mit Lücken zerlegen.
   * -> { parts:[{text}|{gap:index}], gaps:[{answers, wrong}], plain, solved }
   */
  function parseGapText(str, opts) {
    const literal = !!(opts && opts.literal); // findWordsInText: Inhalt ist ein ganzer Ausdruck
    const parts = [], gaps = [];
    if (typeof str !== 'string') return { parts, gaps, plain: '', solved: '' };
    let last = 0, m;
    GAP_RE.lastIndex = 0;
    while ((m = GAP_RE.exec(str)) !== null) {
      if (m.index > last) parts.push({ raw: str.slice(last, m.index) });
      const content = m[1] != null ? m[1] : m[2];
      let answers, wrong;
      if (literal) {
        const c = clean(content.replace(/^\s*\+\+/, '').split('_').join(' '));
        answers = c ? [c] : []; wrong = [];
      } else {
        const ch = parseChoices(content);
        answers = ch.filter(c => c.correct).map(c => c.text);
        wrong = ch.filter(c => !c.correct).map(c => c.text);
      }
      parts.push({ gap: gaps.length });
      gaps.push({ answers, wrong });
      last = m.index + m[0].length;
    }
    if (last < str.length) parts.push({ raw: str.slice(last) });
    // Text-Teile säubern, dabei Leerzeichen an den Rändern erhalten (wichtig für "Schulkind((chen))")
    for (const p of parts) {
      if (p.raw != null) {
        const lead = /^\s/.test(p.raw.replace(TAG_RE, '')) ? ' ' : '';
        const trail = /\s$/.test(p.raw.replace(TAG_RE, '')) ? ' ' : '';
        const c = clean(p.raw);
        p.text = c ? lead + c + trail : (lead || trail ? ' ' : '');
        delete p.raw;
      }
    }
    const join = fn => parts.map(p => (p.gap != null ? fn(gaps[p.gap]) : p.text)).join('').replace(/\s+/g, ' ').trim();
    return {
      parts, gaps,
      plain: join(() => '___'),
      solved: join(g => g.answers[0] || '?')
    };
  }

  function baseName(p) {
    if (typeof p !== 'string') return '';
    const s = p.split('/').pop().replace(/\.(lsg|svg|png|jpe?g)$/i, '').replace(/_crop[-\d]+/g, '');
    return s;
  }

  /** Beschriftung für Text-/Bild-/Ton-Elemente */
  function label(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return clean(v);
    if (typeof v === 'boolean') return v ? 'Richtig' : 'Falsch';
    if (typeof v === 'object') {
      const t = clean(v.text) || clean(v.flip && v.flip.text) || clean(v.title) || clean(v.sound) || clean(v.a) || clean(v.b && typeof v.b === 'string' ? v.b : '');
      if (t) return t;
      const media = mediaName(v);
      return media ? '🖼 ' + media : '';
    }
    return '';
  }

  function mediaName(v) {
    if (!v || typeof v !== 'object') return '';
    const pick = x => (typeof x === 'string' ? x : x && typeof x === 'object' ? (x.lsg || x.image || x.svg || '') : '');
    return baseName(pick(v.lsg) || pick(v.image) || pick(v.svg) || (v.flip ? pick(v.flip.image) : ''));
  }

  /** IDs von Bildern/Grafiken, um sie später auf der Seite wiederzufinden */
  function mediaIds(v) {
    const ids = [];
    if (!v || typeof v !== 'object') return ids;
    const pick = x => (typeof x === 'string' ? x : x && typeof x === 'object' ? (x.lsg || x.image || x.svg || '') : '');
    for (const x of [v.lsg, v.image, v.svg, v.flip && v.flip.image]) {
      const id = baseName(pick(x));
      if (id) ids.push(id);
    }
    return ids;
  }

  const asList = a => (Array.isArray(a) ? a : a == null ? [] : [a]);
  const uniq = arr => Array.from(new Set(arr.filter(x => x != null && x !== '')));

  const INFO_TYPES = new Set(['content', 'contentPlayer', 'contentCard', 'dragCard', 'aiFeedback', 'speakBeta1', 'video', 'contentVideo']);
  const VISUAL_TYPES = new Set(['followPath', 'findAll', 'findOnImage', 'findZone', 'findSequence', 'dragAndValidate', 'kidDragGroup',
    'kidColorize', 'shapeMirror', 'squareMirror', 'drawLines', 'shapes', 'kidPairs', 'switchPath', 'pixelPaint']);
  const SEQ_JOIN = { sentenceSlice: ' ', wordSlice: '', syllabifier: '·', dragPunc: ' ' };
  const PAIR_TYPES = new Set(['listMatch', 'listMatchVertical', 'memory', 'dragMatch']);
  const LIST_CHOICE_TYPES = new Set(['multipleChoice', 'multipleChoiceText', 'imageButtons', 'soundButtons', 'flipButtons', 'flashRead']);
  const GAP_TYPES = new Set(['gap', 'gapMulti', 'gapMultiLearnList', 'lsg', 'table', 'wordBuilder', 'mathFormula']);
  const STRING_CHOICE_TYPES = new Set(['buttons', 'buttonsText', 'buttonsAnimation', 'buttonsAnimationTime', 'lineCombineLeft',
    'lineCombineRight', 'gravity', 'kickItem']);

  function parseTrainer(t, ti, level) {
    const tasks = [];
    const type = String(t.trainer || '');
    const instruction = clean(t.instruction && (t.instruction.text || t.instruction.sound));
    const atomsRaw = t.atoms;
    const atoms = asList(atomsRaw);
    const mk = (ai, o) => {
      const task = Object.assign({
        id: 't' + ti + 'a' + ai, ti, ai, trainer: type, kind: 'choice', instruction,
        prompt: '', keys: [], answers: [], wrong: [], media: []
      }, o);
      task.answers = uniq(task.answers);
      task.wrong = uniq(task.wrong).filter(w => !task.answers.includes(w));
      task.keys = uniq((task.keys || []).map(norm)).filter(k => k.length >= 2);
      tasks.push(task);
      return task;
    };
    const trueLabel = clean(t.trueButtonLabel) || 'Richtig';
    const falseLabel = clean(t.falseButtonLabel) || 'Falsch';

    if (INFO_TYPES.has(type)) return tasks;

    // ---------- Lücken ----------
    if (GAP_TYPES.has(type)) {
      const tf = !!t.trueFalseMode;
      if (type === 'table' || type === 'lsg') {
        // viele kleine Zellen/Beschriftungen -> eine Aufgabe für die ganze Tabelle/Grafik
        const gaps = [], rows = [], keys = [];
        atoms.forEach(a => {
          if (!a || typeof a.b !== 'string') return;
          const g = parseGapText(a.b);
          if (g.gaps.length) {
            g.gaps.forEach(x => gaps.push(Object.assign({ cell: a.id }, x)));
            rows.push({ id: a.id, text: g.solved, isGap: true });
          } else {
            const c = clean(a.b);
            if (c) { keys.push(c); rows.push({ id: a.id, text: c, isGap: false }); }
          }
        });
        if (gaps.length) {
          mk(0, {
            kind: 'gap', gaps, rows: type === 'table' ? rows : undefined, layout: type === 'table' ? t.layout : undefined,
            prompt: instruction, keys: [instruction].concat(keys.slice(0, 12)),
            answers: gaps.map(g => g.answers[0]), wrong: [].concat(...gaps.map(g => g.wrong)),
            write: t.gapMode === 'write'
          });
        }
        return tasks;
      }
      atoms.forEach((a, ai) => {
        if (!a || typeof a !== 'object') return;
        const aText = clean(a.a);
        if (typeof a.b === 'boolean' || (tf && (a.b === 'correct' || a.b === 'wrong'))) {
          const ok = a.b === true || a.b === 'correct';
          mk(ai, { prompt: aText, keys: [aText], answers: [ok ? trueLabel : falseLabel], wrong: [ok ? falseLabel : trueLabel], media: mediaIds(a) });
          return;
        }
        if (typeof a.b !== 'string') return;
        const g = parseGapText(a.b);
        if (!g.gaps.length) return; // reiner Text (z. B. Dialogzeile)
        const textKeys = g.parts.filter(p => p.text && p.text.trim().length > 2).map(p => p.text);
        mk(ai, {
          kind: 'gap', parts: g.parts, gaps: g.gaps, a: aText,
          prompt: (aText ? aText + ' — ' : '') + g.plain, solved: g.solved,
          keys: [aText].concat(textKeys),
          answers: g.gaps.map(x => x.answers[0]), wrong: [].concat(...g.gaps.map(x => x.wrong)),
          write: (a.gapMode || t.gapMode) === 'write', media: mediaIds(a)
        });
      });
      return tasks;
    }

    // ---------- Wörter im Text antippen ----------
    if (type === 'findWordsInText') {
      atoms.forEach((a, ai) => {
        const src = a && (a.b || a.text);
        if (typeof src !== 'string') return;
        const g = parseGapText(src, { literal: true });
        if (!g.gaps.length) return;
        mk(ai, {
          kind: 'find', parts: g.parts, gaps: g.gaps, prompt: g.solved, solved: g.solved,
          keys: g.parts.filter(p => p.text && p.text.trim().length > 2).map(p => p.text),
          answers: g.gaps.map(x => x.answers[0])
        });
      });
      return tasks;
    }

    // ---------- Auswahl als Liste ----------
    if (LIST_CHOICE_TYPES.has(type)) {
      const context = [];
      atoms.forEach((a, ai) => {
        if (!a || typeof a !== 'object') return;
        if (!Array.isArray(a.b)) {
          const c = clean(a.text) || clean(a.title);
          if (c) context.push(c);
          return;
        }
        const answers = [], wrong = [], media = [], wrongMedia = [];
        const hasPlus = a.b.some(x => typeof x === 'string' && x.trim().startsWith('++'));
        a.b.forEach(x => {
          if (typeof x === 'string') {
            const s = x.trim();
            if (s.startsWith('++')) answers.push(clean(s.slice(2)));
            else if (s.startsWith('--')) wrong.push(clean(s.slice(2)));
            else (hasPlus ? wrong : answers).push(clean(s));
          } else if (x && typeof x === 'object') {
            const l = label(x) || '(Bild)';
            if (x.correct === true) { answers.push(l); media.push(...mediaIds(x)); }
            else { wrong.push(l); wrongMedia.push(...mediaIds(x)); }
          }
        });
        const aText = clean(a.a);
        mk(ai, {
          prompt: aText || instruction, keys: [aText || instruction], answers, wrong,
          multi: answers.length > 1, media, wrongMedia, context: context.join(' ').slice(-1200)
        });
      });
      return tasks;
    }

    // ---------- Karte auswählen ----------
    if (type === 'selectCard') {
      const cards = asList(t.cards);
      atoms.forEach((a, ai) => {
        const want = a && a.b;
        const ok = cards.filter(c => c && c.id === want).map(label);
        const no = cards.filter(c => c && c.id !== want).map(label);
        if (ok.length) mk(ai, { prompt: clean(a.a) || instruction, keys: [clean(a.a) || instruction], answers: ok, wrong: no });
      });
      return tasks;
    }

    // ---------- Reihenfolge aus Bausteinen ----------
    if (SEQ_JOIN[type] != null) {
      atoms.forEach((a, ai) => {
        if (!a || typeof a.b !== 'string') return;
        const ch = parseChoices(a.b);
        const seq = ch.filter(c => c.correct).map(c => c.text);
        if (!seq.length) return;
        const aText = clean(a.a);
        const joined = seq.join(SEQ_JOIN[type]).replace(/\s+([.,!?;:])/g, '$1');
        mk(ai, {
          kind: 'order', sequence: seq, prompt: aText || instruction, keys: [aText],
          answers: [joined], solved: joined, wrong: ch.filter(c => !c.correct).map(c => c.text), media: mediaIds(a)
        });
      });
      return tasks;
    }

    // ---------- Auswahl als Text mit ++ ----------
    if (STRING_CHOICE_TYPES.has(type)) {
      const tf = !!t.trueFalseMode;
      const context = [];
      atoms.forEach((a, ai) => {
        if (!a || typeof a !== 'object') return;
        const aText = clean(a.a);
        const b = a.b;
        if (b === undefined) {
          const c = clean(a.text) || clean(a.title);
          if (c) context.push(c);
          return;
        }
        let answers = [], wrong = [];
        if (typeof b === 'boolean' || (tf && typeof b === 'string' && /^(correct|wrong|true|false)$/.test(b.trim()))) {
          const ok = b === true || b === 'correct' || b === 'true';
          answers = [ok ? trueLabel : falseLabel]; wrong = [ok ? falseLabel : trueLabel];
        } else if (typeof b === 'string') {
          if (b.includes('++') || b.includes('--')) {
            const ch = parseChoices(b);
            if (type === 'kickItem') {
              // "Was passt nicht?" -> die falschen Einträge müssen angetippt werden
              answers = ch.filter(c => !c.correct).map(c => c.text);
              wrong = ch.filter(c => c.correct).map(c => c.text);
            } else {
              answers = ch.filter(c => c.correct).map(c => c.text);
              wrong = ch.filter(c => !c.correct).map(c => c.text);
            }
          } else {
            // automatischer Modus: b ist die Lösung, die anderen Aufgaben liefern die falschen Knöpfe
            answers = [clean(b)];
            wrong = atoms.filter(o => o && typeof o.b === 'string' && o.b !== b && !o.b.includes('++') && !o.b.includes('--')).map(o => clean(o.b));
          }
        } else if (typeof b === 'number') {
          answers = [String(b)];
        } else return;
        if (!answers.length) return;
        mk(ai, {
          prompt: aText || instruction, keys: [aText || instruction], answers, wrong,
          multi: answers.length > 1, media: mediaIds(a), context: context.join(' ').slice(-1200)
        });
      });
      return tasks;
    }

    // ---------- Paare ----------
    if (PAIR_TYPES.has(type)) {
      const pairs = [];
      atoms.forEach(a => {
        if (!a || typeof a !== 'object') return;
        const l = label(a.a), r = label(a.b);
        if (l || r) pairs.push({ a: l, b: r, aMedia: mediaIds(typeof a.a === 'object' ? a.a : a), bMedia: mediaIds(typeof a.b === 'object' ? a.b : null) });
      });
      if (pairs.length) {
        mk(0, {
          kind: 'pairs', pairs, prompt: instruction,
          keys: [instruction].concat(pairs.slice(0, 8).map(p => p.a)),
          answers: pairs.map(p => p.a + ' → ' + p.b)
        });
      }
      return tasks;
    }

    // ---------- In Gruppen sortieren ----------
    if (type === 'dragGroup') {
      const cats = asList(t.cats).map(label);
      const groups = cats.map(c => ({ name: c, items: [] }));
      atoms.forEach(a => {
        if (!a || typeof a !== 'object') return;
        const idx = typeof a.cat === 'number' ? a.cat : parseInt(a.cat, 10);
        if (groups[idx]) groups[idx].items.push(label(a.b) || label(a) || '(Bild)');
      });
      if (groups.some(g => g.items.length)) {
        mk(0, {
          kind: 'group', groups, prompt: instruction,
          keys: [instruction].concat(cats),
          answers: groups.map(g => g.name + ': ' + g.items.join(', '))
        });
      }
      return tasks;
    }

    // ---------- Reihenfolge ----------
    if (type === 'dragSort' || type === 'listSort') {
      const seq = atoms.map(a => label(a && (a.text != null ? a.text : a.b)) || label(a)).filter(Boolean);
      if (seq.length) mk(0, { kind: 'order', numbered: true, sequence: seq, prompt: instruction, keys: [instruction].concat(seq.slice(0, 3)), answers: [seq.join(' → ')] });
      return tasks;
    }
    if (type === 'dragOrder') {
      atoms.forEach((a, ai) => {
        if (!a || !Array.isArray(a.elements) || !Array.isArray(a.solutions) || !a.solutions.length) return;
        const first = Array.isArray(a.solutions[0]) ? a.solutions[0] : a.solutions;
        const seq = first.map(i => clean(a.elements[i])).filter(s => s !== '');
        if (!seq.length) return;
        let joined = seq.join(' ').replace(/\s+([.,!?;:])/g, '$1');
        if (t.firstLetterBig && joined) joined = joined[0].toUpperCase() + joined.slice(1);
        const aText = clean(a.a);
        mk(ai, { kind: 'order', sequence: seq, prompt: aText || instruction, keys: [aText || instruction], answers: [joined], solved: joined });
      });
      return tasks;
    }
    if (type === 'dragSpell') {
      atoms.forEach((a, ai) => {
        if (!a || typeof a.word !== 'string') return;
        const letters = a.word.trim().split(/\s+/).map(clean);
        mk(ai, { kind: 'order', sequence: letters, prompt: instruction, keys: [], answers: [letters.join('')], solved: letters.join(''), media: mediaIds(a) });
      });
      return tasks;
    }

    // ---------- schriftliches Rechnen ----------
    if (type === 'mathGrid' || type === 'mathFreeGrid') {
      const rows = atoms.map(a => (a && typeof a.row === 'string')
        ? a.row.split('|').map(c => (c.length >= 2 ? c[1] : ' ')).join('').replace(/\s+$/, '') : '').filter(r => r.trim());
      if (rows.length) mk(0, { kind: 'grid', rows, prompt: instruction, keys: [instruction], answers: [rows[0].replace(/\s+/g, ' ').trim()], solved: rows.join('\n') });
      return tasks;
    }

    // ---------- Bild-/Zeichenaufgaben ----------
    if (VISUAL_TYPES.has(type)) {
      const names = atoms.map(a => label(a && a.a)).filter(Boolean);
      mk(0, { kind: 'visual', prompt: instruction, keys: [instruction], answers: [], hints: names.slice(0, 12) });
      return tasks;
    }

    // ---------- Unbekannter Aufgabentyp: so viel wie möglich herausholen ----------
    atoms.forEach((a, ai) => {
      if (!a || typeof a !== 'object') return;
      const aText = clean(a.a);
      if (typeof a.b === 'string') {
        const g = parseGapText(a.b);
        if (g.gaps.length) {
          mk(ai, { kind: 'gap', parts: g.parts, gaps: g.gaps, a: aText, prompt: (aText ? aText + ' — ' : '') + g.plain, solved: g.solved,
            keys: [aText].concat(g.parts.filter(p => p.text && p.text.trim().length > 2).map(p => p.text)),
            answers: g.gaps.map(x => x.answers[0]), wrong: [].concat(...g.gaps.map(x => x.wrong)), guess: true });
        } else if (a.b.includes('++') || a.b.includes('--')) {
          const ch = parseChoices(a.b);
          mk(ai, { prompt: aText || instruction, keys: [aText || instruction], answers: ch.filter(c => c.correct).map(c => c.text), wrong: ch.filter(c => !c.correct).map(c => c.text), guess: true });
        } else if (clean(a.b)) {
          mk(ai, { prompt: aText || instruction, keys: [aText || instruction], answers: [clean(a.b)], guess: true });
        }
      } else if (Array.isArray(a.b)) {
        const ok = [], no = [];
        a.b.forEach(x => {
          if (typeof x === 'string') (x.trim().startsWith('++') ? ok : no).push(clean(x.replace(/^\s*(\+\+|--)/, '')));
          else if (x && typeof x === 'object') (x.correct === true ? ok : no).push(label(x) || '(Bild)');
        });
        if (ok.length) mk(ai, { prompt: aText || instruction, keys: [aText || instruction], answers: ok, wrong: no, multi: ok.length > 1, guess: true });
      } else if (typeof a.b === 'boolean') {
        mk(ai, { prompt: aText || instruction, keys: [aText], answers: [a.b ? trueLabel : falseLabel], wrong: [a.b ? falseLabel : trueLabel], guess: true });
      }
    });
    if (!tasks.length && atoms.length) mk(0, { kind: 'visual', prompt: instruction, keys: [instruction], answers: [], unknown: true });
    return tasks;
  }

  /** Übungsdaten -> Aufgabenliste */
  function parseLevel(level) {
    const out = { title: '', id: '', tasks: [], total: 0, solved: 0, info: 0 };
    if (!level || !Array.isArray(level.trainers)) return out;
    out.title = clean(level.title);
    out.id = String(level.puid || level.path || out.title || '');
    level.trainers.forEach((t, ti) => {
      if (!t || typeof t !== 'object') return;
      if (INFO_TYPES.has(String(t.trainer || ''))) { out.info++; return; }
      let tasks = [];
      try { tasks = parseTrainer(t, ti, level); } catch (e) { tasks = []; }
      out.total++;
      if (tasks.some(x => x.answers.length || x.kind === 'pairs' || x.kind === 'group')) out.solved++;
      out.tasks.push(...tasks);
    });
    return out;
  }

  /** Sucht in beliebig verschachtelten Daten nach einer Übung (Objekt mit "trainers") */
  function findLevel(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (Array.isArray(obj.trainers) && obj.trainers.length && obj.trainers.some(t => t && typeof t === 'object' && typeof t.trainer === 'string')) return obj;
    const vals = Array.isArray(obj) ? obj.slice(0, 20) : Object.keys(obj).slice(0, 30).map(k => obj[k]);
    for (const v of vals) {
      if (v && typeof v === 'object') {
        const r = findLevel(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Blitz-Rechner: löst reine Rechenaufgaben ganz ohne KI
  // ------------------------------------------------------------------
  function evalExpr(src) {
    let s = String(src).replace(/\s+/g, '')
      .replace(/[·×⋅*xX]/g, '*').replace(/[:÷]/g, '/').replace(/[−–]/g, '-')
      .replace(/(\d),(\d)/g, '$1.$2');
    if (!s || !/^[\d+\-*/().]+$/.test(s) || !/\d/.test(s)) return null;
    let i = 0;
    const peek = () => s[i];
    function num() {
      if (peek() === '(') { i++; const v = add(); if (peek() !== ')') throw 0; i++; return v; }
      if (peek() === '-') { i++; return -num(); }
      if (peek() === '+') { i++; return num(); }
      const st = i;
      while (i < s.length && /[\d.]/.test(s[i])) i++;
      if (st === i) throw 0;
      const v = Number(s.slice(st, i));
      if (!Number.isFinite(v)) throw 0;
      return v;
    }
    function mul() {
      let v = num();
      while (peek() === '*' || peek() === '/') {
        const op = s[i++]; const r = num();
        if (op === '/' && r === 0) throw 0;
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function add() {
      let v = mul();
      while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    try {
      const v = add();
      if (i !== s.length || !Number.isFinite(v)) return null;
      return Math.round(v * 1e9) / 1e9;
    } catch (e) { return null; }
  }

  function fmtNum(v) {
    return String(v).replace('.', ',');
  }

  function parseNum(s) {
    const m = String(s).replace(/\s/g, '').replace(',', '.').match(/^-?\d+(\.\d+)?$/);
    return m ? Number(m[0]) : null;
  }

  /**
   * Versucht eine Aufgabe ohne KI zu lösen.
   * -> { answer, how } oder null
   */
  function quickSolve(question, options) {
    const q = String(question || '').replace(/[\u00A0]/g, ' ');
    options = (options || []).map(o => String(o).trim()).filter(Boolean);

    // 1) Vergleich: "34 ___ 43" mit < = >
    const isCmp = options.length >= 2 && options.every(o => /^[<>=]$/.test(o));
    if (isCmp) {
      const m = q.match(/([\d\s+\-−–·×*:÷/(),.]+?)\s*(?:_{2,}|\?|□|…|\.{3})\s*([\d\s+\-−–·×*:÷/(),.]+)/);
      if (m) {
        const l = evalExpr(m[1]), r = evalExpr(m[2]);
        if (l != null && r != null) return { answer: l < r ? '<' : l > r ? '>' : '=', how: 'gerechnet' };
      }
    }

    // 2) Rechnung mit Ergebnis-Lücke: "3 + 8 =", "7 · 6 = ___", "Wie viel ist 12 : 4?"
    const exprs = q.match(/\d[\d\s+\-−–·×*xX:÷/(),.]*[+\-−–·×*xX:÷/][\d\s+\-−–·×*xX:÷/(),.]*\d\)?/g) || [];
    for (const e of exprs) {
      const rest = q.slice(q.indexOf(e) + e.length);
      // steht hinter dem "=" schon eine Zahl, ist das keine offene Rechnung
      if (/^\s*=\s*-?\d/.test(rest)) continue;
      const v = evalExpr(e);
      if (v == null) continue;
      if (options.length) {
        const hit = options.find(o => { const n = parseNum(o); return n != null && Math.abs(n - v) < 1e-9; });
        if (hit) return { answer: hit, how: 'gerechnet' };
        continue;
      }
      return { answer: fmtNum(v), how: 'gerechnet' };
    }

    // 3) Lücke in der Rechnung: "5 + ___ = 12"
    const gm = q.match(/(-?\d+(?:[.,]\d+)?)\s*([+\-−–·×*xX:÷/])\s*(?:_{2,}|\?|□)\s*=\s*(-?\d+(?:[.,]\d+)?)/);
    const gm2 = q.match(/(?:_{2,}|\?|□)\s*([+\-−–·×*xX:÷/])\s*(-?\d+(?:[.,]\d+)?)\s*=\s*(-?\d+(?:[.,]\d+)?)/);
    let v = null;
    if (gm) {
      const a = parseNum(gm[1]), c = parseNum(gm[3]), op = gm[2];
      if (a != null && c != null) {
        if (op === '+') v = c - a; else if (/[-−–]/.test(op)) v = a - c;
        else if (/[·×*xX]/.test(op)) v = a !== 0 ? c / a : null; else v = c !== 0 ? a / c : null;
      }
    } else if (gm2) {
      const b = parseNum(gm2[2]), c = parseNum(gm2[3]), op = gm2[1];
      if (b != null && c != null) {
        if (op === '+') v = c - b; else if (/[-−–]/.test(op)) v = c + b;
        else if (/[·×*xX]/.test(op)) v = b !== 0 ? c / b : null; else v = c * b;
      }
    }
    if (v != null && Number.isFinite(v)) {
      v = Math.round(v * 1e9) / 1e9;
      if (options.length) {
        const hit = options.find(o => { const n = parseNum(o); return n != null && Math.abs(n - v) < 1e-9; });
        if (hit) return { answer: hit, how: 'gerechnet' };
      } else return { answer: fmtNum(v), how: 'gerechnet' };
    }
    return null;
  }

  const api = { clean, norm, parseChoices, parseGapText, parseLevel, parseTrainer, findLevel, quickSolve, evalExpr, label, baseName };
  root.BuddyCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
