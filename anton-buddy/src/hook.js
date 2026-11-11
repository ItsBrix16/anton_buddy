/*
 * Lösungs-Buddy – hook.js (läuft in der Seite selbst, "MAIN world")
 * Hört mit, wenn ANTON eine Übung lädt, und reicht die Übungsdaten an das
 * Content-Script weiter. Es wird nichts verändert und nichts verschickt.
 */
(function () {
  'use strict';
  if (window.__loesungsBuddyHook) return;
  window.__loesungsBuddyHook = true;

  const TAG = 'loesungs-buddy';
  const recent = [];            // die letzten Übungen (falls das Content-Script später startet)
  const seen = new WeakSet();

  function looksLikeLevel(o) {
    return !!o && typeof o === 'object' && Array.isArray(o.trainers) && o.trainers.length > 0 &&
      o.trainers.some(t => t && typeof t === 'object' && typeof t.trainer === 'string');
  }

  function find(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    if (looksLikeLevel(o)) return o;
    const keys = Array.isArray(o) ? null : Object.keys(o);
    const n = Math.min(keys ? keys.length : o.length, 24);
    for (let i = 0; i < n; i++) {
      const v = keys ? o[keys[i]] : o[i];
      if (v && typeof v === 'object') {
        const r = find(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function publish(level) {
    try {
      if (!level || seen.has(level)) return;
      seen.add(level);
      // nur das Nötige kopieren (keine Medienlisten)
      const slim = {
        title: level.title, puid: level.puid, path: level.path, type: level.type,
        trainers: JSON.parse(nativeStringify(level.trainers))
      };
      const key = String(slim.puid || slim.path || slim.title || '');
      const idx = recent.findIndex(r => r.key === key);
      if (idx >= 0) recent.splice(idx, 1);
      recent.push({ key, level: slim });
      while (recent.length > 4) recent.shift();
      window.postMessage({ source: TAG, type: 'LEVEL', level: slim }, window.location.origin);
    } catch (e) { /* nie die Seite stören */ }
  }

  function inspectText(text) {
    if (typeof text !== 'string' || text.length < 80 || text.indexOf('"trainers"') === -1) return;
    try { const lvl = find(nativeParse(text), 0); if (lvl) publish(lvl); } catch (e) {}
  }
  function inspectObject(obj) {
    try { const lvl = find(obj, 0); if (lvl) publish(lvl); } catch (e) {}
  }

  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;

  // 1) JSON.parse – erwischt auch Übungen aus dem Offline-Speicher
  try {
    const wrapped = function parse(text, reviver) {
      const result = nativeParse.apply(this, arguments);
      try {
        if (result && typeof result === 'object' && typeof text === 'string' && text.length > 80 && text.indexOf('"trainers"') !== -1) {
          inspectObject(result);
        }
      } catch (e) {}
      return result;
    };
    Object.defineProperty(wrapped, 'name', { value: 'parse' });
    wrapped.toString = () => 'function parse() { [native code] }';
    JSON.parse = wrapped;
  } catch (e) {}

  // 2) fetch
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        const p = origFetch.apply(this, arguments);
        try {
          p.then(res => {
            try {
              const ct = (res.headers && res.headers.get('content-type')) || '';
              if (!res.ok || !/json|text|^$/.test(ct)) return;
              res.clone().text().then(inspectText).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        } catch (e) {}
        return p;
      };
    }
  } catch (e) {}

  // 3) XMLHttpRequest
  try {
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            if (this.responseType === '' || this.responseType === 'text') inspectText(this.responseText);
            else if (this.responseType === 'json') inspectObject(this.response);
          } catch (e) {}
        });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  // Content-Script fragt nach, was schon geladen wurde
  window.addEventListener('message', ev => {
    if (ev.source !== window || !ev.data || ev.data.source !== TAG || ev.data.type !== 'HELLO') return;
    for (const r of recent) window.postMessage({ source: TAG, type: 'LEVEL', level: r.level }, window.location.origin);
  });
})();
