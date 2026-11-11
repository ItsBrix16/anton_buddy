/*
 * Lösungs-Buddy – content.js
 * Zeigt die Lösungen der aktuellen ANTON-Übung an:
 *   – grüne Markierung direkt an der richtigen Antwort
 *   – kleine Lösungs-Schilder an Lücken
 *   – ein aufklappbares Fenster mit allen Lösungen
 */
(function () {
  'use strict';
  const core = globalThis.BuddyCore;
  if (!core || window.__lbContent) return;
  window.__lbContent = true;

  const TAG = 'loesungs-buddy';
  const DEFAULTS = {
    enabled: true,        // Hauptschalter
    marks: true,          // Markierungen auf der Seite
    panel: true,          // Lösungs-Fenster
    reveal: 'always',     // 'always' | 'click' (Spoiler-Schutz)
    aiBackend: 'none',    // 'none' | 'builtin' | 'server'
    aiAuto: true,         // KI automatisch fragen, wenn keine Lösungsdaten da sind
    open: false,          // Fenster aufgeklappt?
    pos: null             // {right, bottom}
  };
  let settings = Object.assign({}, DEFAULTS);

  const state = {
    levels: new Map(),     // id -> { title, tasks, at }
    currentId: '',
    located: [],           // Aufgaben, die gerade auf der Seite gefunden wurden
    marks: [],             // { el, kind, text, color }
    tab: 'now',
    revealed: false,
    ai: { sig: '', busy: false, result: null, error: '' }
  };

  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const send = msg => new Promise(resolve => {
    if (!hasChrome) return resolve(null);
    try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; resolve(r || null); }); }
    catch (e) { resolve(null); }
  });

  // ------------------------------------------------------------------
  // Text-Helfer
  // ------------------------------------------------------------------
  const tight = s => core.norm(s).replace(/[\s\u200B]+/g, '');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'DEFS', 'OBJECT', 'IFRAME']);
  let tcache = new WeakMap();
  function tightOf(el) {
    let t = tcache.get(el);
    if (t === undefined) { t = tight(el.textContent || ''); tcache.set(el, t); }
    return t;
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) {}
    }
    return true;
  }
  const inViewport = (r, pad) => r.bottom > -(pad || 0) && r.top < window.innerHeight + (pad || 0) && r.right > 0 && r.left < window.innerWidth;

  /** kleinste Elemente, deren Text den Schlüssel enthält */
  function minimalContaining(rootEl, key, exact, out, limit) {
    let found = false;
    for (const ch of rootEl.children) {
      if (SKIP.has(ch.tagName)) continue;
      const t = tightOf(ch);
      if (t.length >= key.length && t.includes(key)) {
        found = true;
        minimalContaining(ch, key, exact, out, limit);
        if (out.length >= limit) return;
      }
    }
    if (!found && (!exact || tightOf(rootEl) === key)) out.push(rootEl);
  }

  const CLICK_SEL = '.button, button, [role="button"], [style*="cursor: pointer"], [style*="cursor: move"], [style*="cursor: grab"], [draggable="true"]';
  let clicks = [];
  function collectClickables() {
    const out = [];
    if (!document.body) return out;
    for (const el of document.body.querySelectorAll(CLICK_SEL)) {
      const t = tightOf(el);
      if (!t || t.length > 220) continue;
      const p = el.parentElement && el.parentElement.closest(CLICK_SEL);
      if (p && tightOf(p) === t) continue; // äußerstes Element reicht
      if (!isVisible(el)) continue;
      out.push({ el, t });
    }
    return out;
  }

  /** Elemente mit genau diesem Text innerhalb eines Bereichs */
  function findByText(scope, t) {
    if (!t) return [];
    const hits = clicks.filter(c => c.t === t && scope.contains(c.el)).map(c => c.el);
    if (hits.length) return hits;
    if (!tightOf(scope).includes(t)) return [];
    const mins = [];
    minimalContaining(scope, t, true, mins, 6);
    return mins.filter(isVisible).map(el => {
      let e = el;
      while (e.parentElement && e !== scope && tightOf(e.parentElement) === t) e = e.parentElement;
      return e;
    });
  }

  function nearest(els, anchor) {
    if (els.length <= 1 || !anchor) return els[0] || null;
    const a = anchor.getBoundingClientRect();
    let best = null, bd = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      let d = Math.abs(r.top - a.bottom) + Math.abs((r.left + r.width / 2) - (a.left + a.width / 2)) * 0.2;
      if (r.bottom < a.top - 4) d += 400; // lieber darunter als darüber
      if (d < bd) { bd = d; best = el; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Aufgaben auf der Seite wiederfinden
  // ------------------------------------------------------------------
  const PAIR_COLORS = ['#1E88E5', '#8E24AA', '#F4511E', '#00897B', '#C0CA33', '#D81B60', '#6D4C41', '#3949AB', '#FB8C00', '#00ACC1'];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function gapRegex(task) {
    if (task._re !== undefined) return task._re;
    let src = '^', textLen = 0;
    for (const p of task.parts || []) {
      if (p.gap != null) src += '.{0,80}?';
      else { const t = tight(p.text); textLen += t.length; src += esc(t); }
    }
    try { task._re = textLen >= 1 ? new RegExp(src + '$') : null; } catch (e) { task._re = null; }
    task._textLen = textLen;
    return task._re;
  }

  function anchorsFor(task, bodyT) {
    const keys = (task.keys || []).map(tight).filter(k => k.length >= 2).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (!bodyT.includes(k)) continue;
      const out = [];
      minimalContaining(document.body, k, k.length < 6, out, 6);
      const vis = out.filter(isVisible);
      if (vis.length) return { els: vis, keyLen: k.length };
    }
    return null;
  }

  function climb(anchor, test, maxUp) {
    let el = anchor;
    for (let i = 0; el && el !== document.documentElement && i <= (maxUp || 9); i++) {
      const r = test(el);
      if (r) return { scope: el, value: r };
      el = el.parentElement;
    }
    return null;
  }

  function addMark(marks, el, kind, text, color) {
    if (!el) return;
    if (marks.some(m => m.el === el && m.kind === kind && m.text === text)) return;
    marks.push({ el, kind, text: text || '', color: color || '' });
  }

  function locateAll() {
    const located = [], marks = [];
    const body = document.body;
    if (!body) return { located, marks };
    const bodyT = tightOf(body);
    clicks = collectClickables();
    const lvl = state.levels.get(state.currentId);
    if (!lvl) return { located, marks };

    const gapComps = Array.from(body.querySelectorAll('.gapComponent')).filter(isVisible);
    const usedComps = new Set();
    const choiceCands = [];

    for (const task of lvl.tasks) {
      // ---- Lückentexte: Textmuster mit dem sichtbaren Lückentext vergleichen
      if (task.kind === 'gap' && task.parts && gapComps.length) {
        const re = gapRegex(task);
        if (!re) continue;
        for (const comp of gapComps) {
          if (usedComps.has(comp)) continue;
          const ct = tightOf(comp);
          if (!re.test(ct)) continue;
          const gaps = Array.from(comp.querySelectorAll('.gap'));
          if (gaps.length !== task.gaps.length) continue;
          // steht der Zusatztext (a) in der Nähe? -> wichtig, wenn mehrere Lücken gleich aussehen
          if (task._textLen < 4 && task.a) {
            const at = tight(task.a);
            let p = comp, ok = false;
            for (let i = 0; i < 4 && p; i++, p = p.parentElement) if (tightOf(p).includes(at)) { ok = true; break; }
            if (!ok) continue;
          }
          usedComps.add(comp);
          located.push({ task, el: comp });
          gaps.forEach((g, i) => {
            const ans = task.gaps[i].answers[0];
            if (!ans) return;
            const cur = tight(g.textContent || '');
            const done = task.gaps[i].answers.some(a => tight(a) === cur);
            addMark(marks, g, done ? 'done' : 'chip', task.gaps[i].answers.slice(0, 2).join(' / '));
          });
          break;
        }
        continue;
      }

      const anc = anchorsFor(task, bodyT);
      if (!anc) continue;

      if (task.kind === 'choice') {
        const opts = task.answers.concat(task.wrong).map(tight).filter(Boolean);
        const ansT = task.answers.map(tight);
        for (const a of anc.els.slice(0, 4)) {
          const found = climb(a, sc => {
            const hit = clicks.filter(c => sc.contains(c.el) && opts.includes(c.t));
            return hit.some(c => ansT.includes(c.t)) ? hit : null;
          }, 8);
          if (!found) continue;
          const present = new Set(found.value.map(c => c.t));
          choiceCands.push({ task, anchor: a, scope: found.scope, fit: present.size / Math.max(1, new Set(opts).size), keyLen: anc.keyLen, ansT });
        }
        continue;
      }

      const a = anc.els[0];
      if (task.kind === 'gap') {
        // Tabellen/Beschriftungen: Lücken in Seiten-Reihenfolge, nur wenn die Anzahl exakt passt
        const found = climb(a, sc => { const g = sc.querySelectorAll('.gap'); return g.length >= task.gaps.length ? g : null; }, 7);
        located.push({ task, el: found ? found.scope : a });
        if (found && found.value.length === task.gaps.length && task.gaps.length <= 40) {
          Array.from(found.value).forEach((g, i) => {
            const ans = task.gaps[i].answers[0];
            if (ans && isVisible(g)) {
              const done = task.gaps[i].answers.some(x => tight(x) === tight(g.textContent || ''));
              addMark(marks, g, done ? 'done' : 'chip', ans);
            }
          });
        }
      } else if (task.kind === 'find') {
        const full = tight(task.solved);
        const holder = [];
        if (bodyT.includes(full)) minimalContaining(body, full, false, holder, 2);
        const box = holder.find(isVisible) || a;
        located.push({ task, el: box });
        markPhrases(marks, box, task);
      } else if (task.kind === 'pairs') {
        const found = climb(a, sc => (task.pairs.filter(p => p.b && tightOf(sc).includes(tight(p.b))).length >= Math.min(2, task.pairs.length) ? true : null), 8);
        const sc = found ? found.scope : body;
        located.push({ task, el: sc });
        task.pairs.forEach((p, i) => {
          const color = PAIR_COLORS[i % PAIR_COLORS.length];
          const tag = String.fromCharCode(65 + (i % 26));
          for (const side of [p.a, p.b]) {
            if (!side || side.startsWith('🖼')) continue;
            const el = nearest(findByText(sc, tight(side)), null);
            if (el) addMark(marks, el, 'pair', tag, color);
          }
        });
      } else if (task.kind === 'group') {
        const found = climb(a, sc => (task.groups.filter(g => tightOf(sc).includes(tight(g.name))).length >= Math.min(2, task.groups.length) ? true : null), 8);
        const sc = found ? found.scope : body;
        located.push({ task, el: sc });
        task.groups.forEach((g, i) => {
          const color = PAIR_COLORS[i % PAIR_COLORS.length];
          const head = findByText(sc, tight(g.name))[0];
          if (head) addMark(marks, head, 'pair', String(i + 1), color);
          g.items.forEach(it => {
            if (it.startsWith('🖼') || it === '(Bild)') return;
            for (const el of findByText(sc, tight(it)).slice(0, 2)) addMark(marks, el, 'pair', String(i + 1), color);
          });
        });
      } else if (task.kind === 'order' && task.sequence) {
        const found = climb(a, sc => (task.sequence.filter(s => findByText(sc, tight(s)).length).length >= Math.min(2, task.sequence.length) ? true : null), 8);
        const sc = found ? found.scope : null;
        located.push({ task, el: sc || a });
        if (sc) {
          const used = new Set();
          task.sequence.forEach((s, i) => {
            const el = findByText(sc, tight(s)).find(e => !used.has(e));
            if (el) { used.add(el); addMark(marks, el, 'num', String(i + 1)); }
          });
        }
      } else {
        located.push({ task, el: a });
      }
    }

    // ---- Auswahl-Aufgaben: pro Bereich die am besten passende Aufgabe nehmen
    const byScope = new Map();
    for (const c of choiceCands) {
      const arr = byScope.get(c.scope) || [];
      arr.push(c); byScope.set(c.scope, arr);
    }
    for (const [scope, arr] of byScope) {
      const bestFit = Math.max(...arr.map(c => c.fit));
      let best = arr.filter(c => c.fit >= bestFit - 1e-9);
      const bestKey = Math.max(...best.map(c => c.keyLen));
      best = best.filter(c => c.keyLen === bestKey);
      const sig = c => c.ansT.slice().sort().join('|');
      const distinct = new Set(best.map(sig));
      if (distinct.size > 1) {
        // gleiche Frage, gleiche Knöpfe, verschiedene Lösungen (z. B. Bildaufgaben) -> nichts markieren
        located.push({ task: best[0].task, el: scope, ambiguous: best.map(c => c.task) });
        continue;
      }
      const c = best[0];
      located.push({ task: c.task, el: scope });
      for (const t of c.ansT) {
        const els = clicks.filter(k => k.t === t && scope.contains(k.el)).map(k => k.el);
        const el = nearest(els, c.anchor);
        if (el) addMark(marks, el, 'ok', '');
      }
    }

    // ---- Lücken mit Auswahl-Knöpfen: passenden Knopf markieren, wenn eindeutig
    const visBtn = new Map();
    for (const c of clicks) if (!visBtn.has(c.t)) visBtn.set(c.t, c.el);
    const want = new Map();
    for (const l of located) {
      const t = l.task;
      if (t.kind !== 'gap' || t.write) continue;
      for (const g of t.gaps) {
        if (g.wrong.length < 1 || !g.answers.length) continue;
        const set = g.answers.concat(g.wrong).map(tight);
        if (!set.every(x => visBtn.has(x))) continue;
        const key = set.slice().sort().join('|');
        const ans = tight(g.answers[0]);
        if (!want.has(key)) want.set(key, new Set());
        want.get(key).add(ans);
      }
    }
    for (const [, answers] of want) {
      if (answers.size !== 1) continue;
      const el = visBtn.get(Array.from(answers)[0]);
      if (el && !el.closest('.gapComponent')) addMark(marks, el, 'ok', '');
    }

    return { located, marks };
  }

  /** Wörter im Text markieren: Zeichenpositionen der Lösung auf die einzelnen Wort-Elemente abbilden */
  function markPhrases(marks, box, task) {
    const leaves = [];
    const walk = el => {
      if (SKIP.has(el.tagName)) return;
      if (!el.children.length) { const t = tightOf(el); if (t) leaves.push({ el, t }); return; }
      let hasText = false;
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) { hasText = true; break; }
      if (hasText && el.children.length === 0) { leaves.push({ el, t: tightOf(el) }); return; }
      for (const ch of el.children) walk(ch);
    };
    walk(box);
    const joined = leaves.map(l => l.t).join('');
    let expected = '', ranges = [];
    for (const p of task.parts) {
      if (p.gap != null) { const t = tight(task.gaps[p.gap].answers[0] || ''); ranges.push([expected.length, expected.length + t.length]); expected += t; }
      else expected += tight(p.text);
    }
    const off = joined.indexOf(expected);
    if (off < 0) return;
    let pos = 0;
    for (const l of leaves) {
      const s = pos - off, e = s + l.t.length;
      pos += l.t.length;
      if (ranges.some(r => s < r[1] && e > r[0] && /[\p{L}\p{N}]/u.test(l.t))) addMark(marks, l.el, 'ok', '');
    }
  }

  // ------------------------------------------------------------------
  // Oberfläche (im Shadow-DOM, damit ANTON nichts davon merkt und umgekehrt)
  // ------------------------------------------------------------------
  let host = null, shadow = null, layer = null, dock = null, pill = null, panelEl = null;

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.lb{font-family:"Source Sans Pro Solocode","Source Sans Pro","Source Sans 3","Segoe UI",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.35;color:#111}
.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646;overflow:hidden}
.m{position:fixed;pointer-events:none;transition:opacity .12s}
.m.ok{outline:3px solid #43A047;outline-offset:2px;background:rgba(76,175,80,.14);box-shadow:0 0 0 6px rgba(76,175,80,.16)}
.m.ok::after{content:"✓";position:absolute;top:-11px;right:-11px;width:20px;height:20px;border-radius:50%;background:#43A047;color:#fff;font:700 13px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.m.ai{outline:3px dashed #FB8C00;outline-offset:2px;background:rgba(251,140,0,.12)}
.m.ai::after{content:"KI";position:absolute;top:-11px;right:-13px;padding:0 5px;height:20px;border-radius:10px;background:#FB8C00;color:#fff;font:700 11px/20px system-ui,sans-serif}
.m.chip,.m.done{outline:2px solid #43A047;outline-offset:1px}
.m.done{outline-color:#A5D6A7}
.m .tag{position:absolute;left:50%;bottom:calc(100% + 5px);transform:translateX(-50%);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;background:#2E7D32;color:#fff;padding:2px 8px;font-weight:600;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.25)}
.m .tag::after{content:"";position:absolute;left:50%;top:100%;margin-left:-5px;border:5px solid transparent;border-top-color:#2E7D32}
.m.done .tag{display:none}
.m.num,.m.pair{outline:3px solid var(--c,#1E88E5);outline-offset:-4px}
.m .badge{position:absolute;top:-10px;left:-10px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--c,#1E88E5);color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dock{position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px)}
.pill{display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 24px));padding:8px 12px 8px 8px;background:#fff;border:1px solid #E0E0E0;box-shadow:0 4px 18px rgba(0,0,0,.16);cursor:pointer;user-select:none}
.pill:hover{border-color:#BDBDBD}
.face{flex:none;width:34px;height:34px;border-radius:50%;background:#2196F3;display:grid;place-items:center}
.face.ok{background:#43A047}.face.ai{background:#FB8C00}.face.idle{background:#9E9E9E}
.pt{min-width:0;display:flex;flex-direction:column}
.pk{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:#757575;font-weight:600}
.pv{font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#111}
.pv.muted{font-weight:400;color:#555;font-size:14.5px}
.chev{flex:none;color:#9E9E9E;font-size:18px;margin-left:2px}
.btn{font:inherit;border:0;background:#E0E0E0;color:#111;padding:6px 12px;cursor:pointer}
.btn:hover{background:#D5D5D5}.btn.pri{background:#2196F3;color:#fff}.btn.pri:hover{background:#1E88E5}
.panel{width:min(400px,calc(100vw - 24px));max-height:min(64vh,620px);display:flex;flex-direction:column;background:#fff;border:1px solid #E0E0E0;box-shadow:0 10px 34px rgba(0,0,0,.2)}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #EEE}
.hd b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1565C0;font-size:15.5px}
.x{border:0;background:none;font-size:20px;line-height:1;color:#757575;cursor:pointer;padding:2px 6px}
.x:hover{color:#111}
.tabs{display:flex;border-bottom:1px solid #EEE}
.tab{flex:1;padding:8px;border:0;background:#FAFAFA;font:inherit;color:#616161;cursor:pointer;border-bottom:2px solid transparent}
.tab.on{background:#fff;color:#1565C0;font-weight:600;border-bottom-color:#2196F3}
.list{overflow:auto;padding:4px 12px 10px;overscroll-behavior:contain}
.card{padding:10px 0;border-bottom:1px solid #F0F0F0}
.card:last-child{border-bottom:0}
.q{color:#555;font-size:13.5px;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.a{font-size:15.5px}
.g{background:#E8F5E9;color:#1B5E20;font-weight:700;padding:0 4px;box-decoration-break:clone}
.ans{display:inline-block;background:#E8F5E9;color:#1B5E20;font-weight:700;padding:2px 8px;margin:2px 4px 2px 0}
.row{display:flex;gap:6px;align-items:baseline;margin:2px 0}
.dot{flex:none;min-width:20px;height:20px;border-radius:10px;padding:0 5px;color:#fff;font:700 12px/20px system-ui,sans-serif;text-align:center}
.hint{color:#757575;font-size:13.5px}
.grid{font-family:ui-monospace,Consolas,monospace;white-space:pre;background:#F5F5F5;padding:6px 8px;display:inline-block}
.tbl{border-collapse:collapse;font-size:14px}.tbl td{border:1px solid #E0E0E0;padding:3px 7px}
.empty{padding:18px 4px;color:#616161;text-align:center}
.foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid #EEE;color:#757575;font-size:12.5px}
.foot span{flex:1}
.aibox{background:#FFF3E0;border-left:3px solid #FB8C00;padding:8px 10px;margin:8px 0}
.aibox b{color:#E65100}
.hidden{display:none!important}
`;

  const FACE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="1.3" fill="#fff" stroke="none"/><circle cx="16" cy="8" r="1.3" fill="#fff" stroke="none"/><path d="M5.5 13.5l4.2 4.2L18.8 11"/></svg>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureUI() {
    if (host && host.isConnected) return true;
    const parent = document.documentElement;
    if (!parent || !document.body) return false;
    if (!host) {
      host = document.createElement('div');
      host.id = 'loesungs-buddy-root';
      host.setAttribute('translate', 'no');
      shadow = host.attachShadow({ mode: 'closed' });
      const st = document.createElement('style');
      st.textContent = CSS;
      shadow.appendChild(st);
      layer = el('div', 'lb layer');
      dock = el('div', 'lb dock');
      shadow.appendChild(layer);
      shadow.appendChild(dock);
      dock.addEventListener('click', onDockClick);
      enableDrag();
    }
    parent.appendChild(host);
    applyPos();
    return true;
  }

  function applyPos() {
    if (!dock) return;
    const p = settings.pos;
    dock.style.right = (p && Number.isFinite(p.right) ? Math.max(4, Math.min(window.innerWidth - 80, p.right)) : 16) + 'px';
    dock.style.bottom = (p && Number.isFinite(p.bottom) ? Math.max(4, Math.min(window.innerHeight - 60, p.bottom)) : 16) + 'px';
  }

  let dragMoved = false;
  function enableDrag() {
    let start = null;
    dock.addEventListener('pointerdown', ev => {
      if (!ev.target.closest('.pill, .hd') || ev.target.closest('button')) return;
      const r = dock.getBoundingClientRect();
      start = { x: ev.clientX, y: ev.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom };
      dragMoved = false;
    });
    window.addEventListener('pointermove', ev => {
      if (!start) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
      dragMoved = true;
      settings.pos = { right: start.right - dx, bottom: start.bottom - dy };
      applyPos();
    }, true);
    window.addEventListener('pointerup', () => {
      if (start && dragMoved) save({ pos: settings.pos });
      start = null;
    }, true);
  }

  function save(patch) {
    Object.assign(settings, patch);
    if (hasChrome) { try { chrome.storage.local.set({ settings }); } catch (e) {} }
  }

  function onDockClick(ev) {
    if (dragMoved) { dragMoved = false; return; }
    const t = ev.target.closest('[data-act]');
    const act = t ? t.dataset.act : (ev.target.closest('.pill') ? 'toggle' : '');
    if (!act) return;
    if (act === 'toggle') { save({ open: !settings.open }); render(); }
    else if (act === 'close') { save({ open: false }); render(); }
    else if (act === 'tab') { state.tab = t.dataset.tab; render(); }
    else if (act === 'reveal') { state.revealed = true; render(); }
    else if (act === 'ai') { askAI(true); }
    else if (act === 'hide') { save({ panel: false }); render(); }
  }

  const showAnswers = () => settings.reveal !== 'click' || state.revealed;

  function summary(task) {
    if (!task) return '';
    if (task.kind === 'pairs') return task.pairs.length + ' Paare – siehe Farben';
    if (task.kind === 'group') return task.groups.length + ' Gruppen – siehe Farben';
    if (task.kind === 'visual') return 'Bildaufgabe';
    if (task.kind === 'gap') return task.gaps.map(g => g.answers[0]).filter(Boolean).join(' · ');
    if (task.kind === 'find') return task.answers.join(' · ');
    if (task.kind === 'order') return task.solved || task.sequence.join(' → ');
    if (task.kind === 'grid') return task.answers[0];
    return task.answers.join(' · ');
  }

  function taskCard(task, note) {
    const c = el('div', 'card');
    const q = task.kind === 'gap' && task.a ? task.a : (task.kind === 'gap' || task.kind === 'find' ? task.instruction : (task.prompt || task.instruction));
    if (q) c.appendChild(el('div', 'q', q));
    if (note) c.appendChild(el('div', 'hint', note));
    const a = el('div', 'a');
    if ((task.kind === 'gap' || task.kind === 'find') && task.parts) {
      for (const p of task.parts) {
        if (p.gap != null) a.appendChild(el('span', 'g', task.gaps[p.gap].answers.slice(0, 3).join(' / ') || '?'));
        else a.appendChild(document.createTextNode(p.text));
      }
    } else if (task.kind === 'gap' && task.rows && task.layout) {
      const byId = new Map(task.rows.map(r => [r.id, r]));
      const tbl = el('table', 'tbl');
      for (const line of String(task.layout).split('\n')) {
        const tr = el('tr');
        for (const id of line.trim().split(/\s+/)) {
          const r = byId.get(id);
          const td = el('td');
          if (r && r.isGap) td.appendChild(el('span', 'g', r.text)); else td.textContent = r ? r.text : '';
          tr.appendChild(td);
        }
        tbl.appendChild(tr);
      }
      a.appendChild(tbl);
    } else if (task.kind === 'gap') {
      task.gaps.forEach((g, i) => {
        const r = el('div', 'row');
        const d = el('span', 'dot', String(i + 1)); d.style.background = '#43A047';
        r.appendChild(d); r.appendChild(el('span', 'ans', g.answers.slice(0, 3).join(' / ') || '?'));
        a.appendChild(r);
      });
    } else if (task.kind === 'pairs') {
      task.pairs.forEach((p, i) => {
        const r = el('div', 'row');
        const d = el('span', 'dot', String.fromCharCode(65 + (i % 26))); d.style.background = PAIR_COLORS[i % PAIR_COLORS.length];
        r.appendChild(d); r.appendChild(el('span', '', p.a + '  →  ' + p.b));
        a.appendChild(r);
      });
    } else if (task.kind === 'group') {
      task.groups.forEach((g, i) => {
        const r = el('div', 'row');
        const d = el('span', 'dot', String(i + 1)); d.style.background = PAIR_COLORS[i % PAIR_COLORS.length];
        const s = el('span'); const b = el('b', '', g.name + ': '); s.appendChild(b); s.appendChild(document.createTextNode(g.items.join(', ')));
        r.appendChild(d); r.appendChild(s); a.appendChild(r);
      });
    } else if (task.kind === 'order' && task.numbered) {
      task.sequence.forEach((s, i) => {
        const r = el('div', 'row');
        const d = el('span', 'dot', String(i + 1)); d.style.background = '#1E88E5';
        r.appendChild(d); r.appendChild(el('span', '', s)); a.appendChild(r);
      });
    } else if (task.kind === 'grid') {
      a.appendChild(el('div', 'grid', task.solved));
    } else if (task.kind === 'visual') {
      a.appendChild(el('div', 'hint', 'Bild- oder Zeichenaufgabe – dafür gibt es keine Text-Lösung.' + (task.hints && task.hints.length ? ' Gesucht: ' + task.hints.join(', ') : '')));
    } else {
      for (const x of task.answers) a.appendChild(el('span', 'ans', x));
    }
    c.appendChild(a);
    return c;
  }

  function nowTasks() {
    const seen = new Set(), out = [];
    const items = state.located.map(l => {
      const r = l.el.getBoundingClientRect();
      return Object.assign({ top: r.top, vis: inViewport(r, 40) }, l);
    }).filter(l => l.vis).sort((a, b) => a.top - b.top);
    for (const l of items) { if (!seen.has(l.task.id)) { seen.add(l.task.id); out.push(l); } }
    return out;
  }

  function render() {
    if (!ensureUI()) return;
    const on = settings.enabled;
    layer.classList.toggle('hidden', !on || !settings.marks || !showAnswers());
    dock.classList.toggle('hidden', !on || !settings.panel);
    if (!on || !settings.panel) return;

    const lvl = state.levels.get(state.currentId);
    const now = nowTasks();
    const first = now.find(l => !l.ambiguous && l.task.kind !== 'visual') || now[0];
    const ai = state.ai.result;

    // ---- kleine Leiste
    dock.textContent = '';
    if (settings.open) dock.appendChild(buildPanel(lvl, now));
    pill = el('div', 'pill');
    pill.title = 'Klicken: alle Lösungen · Ziehen: verschieben · Alt+L: ein/aus';
    const face = el('div', 'face');
    face.innerHTML = FACE;
    const pt = el('div', 'pt');
    let k = 'Lösungs-Buddy', v = '', muted = false;
    if (first && !first.ambiguous) {
      k = now.length > 1 ? 'Lösung (1 von ' + now.length + ')' : 'Lösung';
      if (showAnswers()) v = summary(first.task); else { v = 'Zum Anzeigen klicken'; muted = true; }
      face.classList.add('ok');
    } else if (first && first.ambiguous) {
      k = 'Mehrere Möglichkeiten'; v = 'Fenster öffnen'; muted = true;
    } else if (ai) {
      k = ai.how === 'gerechnet' ? 'Gerechnet' : 'KI-Tipp' + (ai.confidence != null ? ' · ' + Math.round(ai.confidence * 100) + ' %' : '');
      v = ai.answer; face.classList.add(ai.how === 'gerechnet' ? 'ok' : 'ai');
    } else if (state.ai.busy) {
      k = 'KI'; v = 'denkt nach …'; muted = true; face.classList.add('ai');
    } else if (lvl) {
      k = lvl.title || 'Übung erkannt'; v = lvl.tasks.length + ' Lösungen bereit'; muted = true;
    } else {
      v = 'Starte eine Übung'; muted = true; face.classList.add('idle');
    }
    pt.appendChild(el('div', 'pk', k));
    pt.appendChild(el('div', 'pv' + (muted ? ' muted' : ''), v));
    pill.appendChild(face); pill.appendChild(pt);
    if (!showAnswers() && first) { const b = el('button', 'btn pri', 'Zeigen'); b.dataset.act = 'reveal'; pill.appendChild(b); }
    pill.appendChild(el('div', 'chev', settings.open ? '▾' : '▴'));
    dock.appendChild(pill);
  }

  function buildPanel(lvl, now) {
    const p = el('div', 'panel');
    const hd = el('div', 'hd');
    hd.appendChild(el('b', '', lvl ? (lvl.title || 'Übung') : 'Lösungs-Buddy'));
    const x = el('button', 'x', '×'); x.dataset.act = 'close'; x.title = 'Schließen';
    hd.appendChild(x); p.appendChild(hd);

    const tabs = el('div', 'tabs');
    for (const [id, name] of [['now', 'Jetzt'], ['all', 'Alle Lösungen' + (lvl ? ' (' + lvl.tasks.length + ')' : '')]]) {
      const b = el('button', 'tab' + (state.tab === id ? ' on' : ''), name);
      b.dataset.act = 'tab'; b.dataset.tab = id; tabs.appendChild(b);
    }
    p.appendChild(tabs);

    const list = el('div', 'list');
    if (!showAnswers()) {
      const e = el('div', 'empty', 'Spoiler-Schutz ist an. ');
      const b = el('button', 'btn pri', 'Lösungen zeigen'); b.dataset.act = 'reveal';
      e.appendChild(el('br')); e.appendChild(b); list.appendChild(e);
    } else if (state.tab === 'now') {
      if (state.ai.result) {
        const a = state.ai.result;
        const box = el('div', 'aibox');
        box.appendChild(el('b', '', a.how === 'gerechnet' ? 'Ausgerechnet: ' : 'KI-Tipp: '));
        box.appendChild(document.createTextNode(a.answer));
        if (a.how !== 'gerechnet') box.appendChild(el('div', 'hint', 'Sicherheit ' + (a.confidence != null ? Math.round(a.confidence * 100) + ' %' : '?') + ' – ein kleines KI-Modell kann sich irren.'));
        list.appendChild(box);
      }
      if (now.length) {
        for (const l of now) {
          if (l.ambiguous) {
            list.appendChild(el('div', 'hint', 'Diese Frage kommt mehrfach mit verschiedenen Bildern vor. Mögliche Lösungen:'));
            for (const t of l.ambiguous) list.appendChild(taskCard(t));
          } else list.appendChild(taskCard(l.task));
        }
      } else if (!state.ai.result) {
        const e = el('div', 'empty');
        e.textContent = lvl ? 'Auf dem Bildschirm ist gerade keine Aufgabe mit Text-Lösung zu sehen. Unter „Alle Lösungen“ steht die ganze Übung.'
          : 'Noch keine Übung erkannt. Öffne in ANTON eine Übung – die Lösungen erscheinen von selbst. Falls du schon mitten in einer Übung bist: Seite einmal neu laden.';
        list.appendChild(e);
        if (settings.aiBackend !== 'none') {
          const b = el('button', 'btn pri', state.ai.busy ? 'KI denkt nach …' : 'KI fragen'); b.dataset.act = 'ai';
          const w = el('div', 'empty'); w.appendChild(b);
          if (state.ai.error) w.appendChild(el('div', 'hint', state.ai.error));
          list.appendChild(w);
        }
      }
    } else if (lvl && lvl.tasks.length) {
      let lastTi = -1, n = 0;
      for (const t of lvl.tasks) {
        if (t.ti !== lastTi) { lastTi = t.ti; n++; }
        list.appendChild(taskCard(t));
      }
    } else {
      list.appendChild(el('div', 'empty', 'Noch keine Übung erkannt.'));
    }
    p.appendChild(list);

    const ft = el('div', 'foot');
    ft.appendChild(el('span', '', 'Alt+L blendet alles sofort aus'));
    p.appendChild(ft);
    return p;
  }

  // ------------------------------------------------------------------
  // Markierungen zeichnen (liegen über der Seite, ANTON wird nicht verändert)
  // ------------------------------------------------------------------
  const pool = [];
  function covered(node, r) {
    try {
      const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 2);
      const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 2);
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === host || hit === node || node.contains(hit) || hit.contains(node)) return false;
      for (let e = hit; e && e !== document.documentElement; e = e.parentElement) {
        const pos = getComputedStyle(e).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
      }
    } catch (e) {}
    return false;
  }

  function drawMarks() {
    if (!layer) return;
    const marks = (settings.enabled && settings.marks && showAnswers()) ? state.marks : [];
    let n = 0;
    for (const m of marks) {
      if (!m.el.isConnected) continue;
      const r = m.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !inViewport(r, 0)) continue;
      if (r.top < 140 && covered(m.el, r)) continue; // liegt unter ANTONs fester Kopfleiste
      let d = pool[n];
      if (!d) { d = el('div', 'm'); layer.appendChild(d); pool[n] = d; }
      n++;
      const cls = 'm ' + m.kind;
      if (d.className !== cls) d.className = cls;
      d.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' + (m.color ? '--c:' + m.color : '');
      const sig = m.kind + '|' + m.text;
      if (d.dataset.sig !== sig) {
        d.dataset.sig = sig;
        d.textContent = '';
        if ((m.kind === 'chip' || m.kind === 'done') && m.text) d.appendChild(el('div', 'tag', m.text));
        if ((m.kind === 'num' || m.kind === 'pair') && m.text) d.appendChild(el('div', 'badge', m.text));
      }
    }
    for (let i = n; i < pool.length; i++) if (pool[i].className !== 'm hidden') pool[i].className = 'm hidden';
  }
  function loop() { drawMarks(); requestAnimationFrame(loop); }

  // ------------------------------------------------------------------
  // Ablauf
  // ------------------------------------------------------------------
  let scanTimer = 0, lastSig = '';
  function scheduleScan(ms) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, ms == null ? 140 : ms);
  }

  function scan() {
    if (!settings.enabled || document.hidden || !document.body) { state.marks = []; if (host) render(); return; }
    tcache = new WeakMap();
    let res;
    try { res = locateAll(); } catch (e) { res = { located: [], marks: [] }; }
    state.located = res.located;
    state.marks = res.marks;
    const sig = res.located.map(l => l.task.id + (l.ambiguous ? '?' : '')).join(',') + '#' + res.marks.length + '#' + state.currentId;
    if (sig !== lastSig) {
      lastSig = sig;
      if (res.located.length) { state.ai.result = null; state.ai.error = ''; }
      render();
    }
    if (!res.located.length && settings.aiAuto && settings.aiBackend !== 'none') maybeAutoAI();
  }

  function onLevel(raw) {
    const lvl = core.parseLevel(raw);
    if (!lvl.tasks.length && !lvl.info) return;
    const id = lvl.id || lvl.title || String(Date.now());
    lvl.at = Date.now();
    state.levels.delete(id);
    state.levels.set(id, lvl);
    while (state.levels.size > 5) state.levels.delete(state.levels.keys().next().value);
    state.currentId = id;
    state.revealed = false;
    state.ai.result = null;
    lastSig = '';
    scheduleScan(60);
    render();
  }

  // ------------------------------------------------------------------
  // KI-Notlösung: nur wenn keine Lösungsdaten vorhanden sind
  // ------------------------------------------------------------------
  const CONTROL = new Set(['weiter', 'fertig', 'prüfen', 'pruefen', 'ok', 'nochmal', 'zurück', 'überspringen', 'los', 'start', 'schließen', 'tipp', 'hilfe', 'lösung', 'abbrechen', 'next', 'continue', 'check', 'done', 'skip']);

  function readQuestion() {
    const body = document.body;
    if (!body) return null;
    tcache = new WeakMap();
    clicks = collectClickables();
    const options = [];
    for (const c of clicks) {
      const r = c.el.getBoundingClientRect();
      if (!inViewport(r, 0)) continue;
      const txt = core.clean(c.el.innerText || c.el.textContent || '');
      if (!txt || txt.length > 90 || CONTROL.has(txt.toLowerCase())) continue;
      if (c.el.closest('#loesungs-buddy-root')) continue;
      if (!options.some(o => o.text === txt)) options.push({ text: txt, el: c.el });
    }
    const parts = [];
    for (const i of body.querySelectorAll('.instruction, h1, h2')) {
      if (!isVisible(i) || !inViewport(i.getBoundingClientRect(), 0)) continue;
      const t = core.clean(i.innerText || '');
      if (t && !parts.includes(t)) parts.push(t);
    }
    for (const g of body.querySelectorAll('.gapComponent')) {
      if (!isVisible(g) || !inViewport(g.getBoundingClientRect(), 0)) continue;
      const clone = g.cloneNode(true);
      clone.querySelectorAll('.gap').forEach(x => { x.textContent = ' ___ '; });
      const t = core.clean(clone.textContent || '');
      if (t) parts.push(t);
    }
    if (!parts.length) {
      // allgemeiner Ausweg: sichtbarer Text ohne die Antwort-Knöpfe
      let t = core.clean(body.innerText || '');
      for (const o of options) t = t.replace(o.text, ' ');
      t = t.replace(/\s+/g, ' ').trim();
      if (t.length > 12) parts.push(t.slice(0, 600));
    }
    const question = parts.join('\n').slice(0, 900);
    if (question.length < 3) return null;
    return { question, options: options.slice(0, 6) };
  }

  let autoTimer = 0;
  function maybeAutoAI() {
    if (autoTimer || state.ai.busy) return;
    autoTimer = setTimeout(() => { autoTimer = 0; askAI(false); }, 900);
  }

  async function askAI(manual) {
    if (state.ai.busy) return;
    if (state.located.length && !manual) return;
    const q = readQuestion();
    if (!q) { if (manual) { state.ai.error = 'Auf dieser Seite wurde keine Frage gefunden.'; render(); } return; }
    const sig = q.question + '|' + q.options.map(o => o.text).join('|');
    if (!manual && sig === state.ai.sig) return;
    state.ai.sig = sig;
    state.ai.error = '';

    // 1) Rechenaufgaben: sofort und exakt, ganz ohne KI
    const quick = core.quickSolve(q.question, q.options.map(o => o.text));
    if (quick) { state.ai.result = { answer: quick.answer, how: 'gerechnet', confidence: 1 }; applyAIMark(q, quick.answer, 'ok'); render(); return; }
    if (settings.aiBackend === 'none') { if (manual) { state.ai.error = 'Kein KI-Modell eingerichtet (siehe Menü → KI).'; render(); } return; }
    if (!manual && q.options.length < 2) return; // automatisch nur bei Auswahlfragen

    state.ai.busy = true; state.ai.result = null; render();
    const res = await send({ type: 'ai:ask', question: q.question, options: q.options.map(o => o.text) });
    state.ai.busy = false;
    if (res && res.ok && res.answer) {
      state.ai.result = { answer: res.answer, confidence: res.confidence, how: 'ki', ms: res.ms };
      applyAIMark(q, res.answer, 'ai');
    } else {
      state.ai.error = (res && res.error) || 'Die KI hat nicht geantwortet.';
    }
    lastSig = '';
    render();
  }

  function applyAIMark(q, answer, kind) {
    if (state.located.length) return;
    const t = tight(answer);
    const o = q.options.find(x => tight(x.text) === t);
    state.marks = o ? [{ el: o.el, kind, text: '', color: '' }] : [];
  }

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  window.addEventListener('message', ev => {
    if (ev.source !== window || !ev.data || ev.data.source !== TAG || ev.data.type !== 'LEVEL') return;
    try { onLevel(ev.data.level); } catch (e) {}
  });

  window.addEventListener('keydown', ev => {
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'l' || ev.key === 'L' || ev.code === 'KeyL')) {
      ev.preventDefault();
      save({ enabled: !settings.enabled });
      lastSig = ''; scan(); render();
    }
  }, true);

  function start() {
    try { window.postMessage({ source: TAG, type: 'HELLO' }, window.location.origin); } catch (e) {}
    const mo = new MutationObserver(() => scheduleScan());
    const attach = () => {
      if (!document.body) return setTimeout(attach, 50);
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      ensureUI(); render(); scheduleScan(0);
      requestAnimationFrame(loop);
    };
    attach();
    setInterval(() => scheduleScan(0), 1500);
    window.addEventListener('resize', () => { applyPos(); }, { passive: true });
    if (settings.aiBackend === 'builtin') send({ type: 'ai:warm' });
  }

  if (hasChrome) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, respond) => {
        if (!msg || msg.type !== 'page:status') return;
        const lvl = state.levels.get(state.currentId);
        respond({ ok: true, title: lvl ? lvl.title : '', tasks: lvl ? lvl.tasks.length : 0, located: state.located.length });
      });
      chrome.storage.local.get('settings', d => {
        void chrome.runtime.lastError;
        if (d && d.settings) settings = Object.assign({}, DEFAULTS, d.settings);
        start();
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch.settings) return;
        settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
        lastSig = ''; applyPos(); scan(); render();
      });
    } catch (e) { start(); }
  } else {
    start(); // Vorschau/Test ohne Erweiterung
  }

  // für Tests
  if (!hasChrome) window.__lbDebug = () => ({ level: state.levels.get(state.currentId), located: state.located.map(l => ({ id: l.task.id, kind: l.task.kind, amb: !!l.ambiguous })), marks: state.marks.map(m => ({ kind: m.kind, text: m.text, target: (m.el.textContent || '').trim().slice(0, 40) })) });
})();
