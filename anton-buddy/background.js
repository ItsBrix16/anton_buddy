/*
 * Lösungs-Buddy – background.js
 * Vermittelt zwischen Seite, Menü und KI. Die Lösungen selbst brauchen diesen Teil nicht.
 */
import { DEFAULT_SETTINGS } from './src/models.js';

const getSettings = async () => Object.assign({}, DEFAULT_SETTINGS, (await chrome.storage.local.get('settings')).settings || {});

chrome.runtime.onInstalled.addListener(async d => {
  const cur = (await chrome.storage.local.get('settings')).settings;
  if (!cur) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// ---------------- eingebaute KI (läuft in einem unsichtbaren Dokument) ----------------
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Das kleine KI-Modell rechnet lokal im Browser.'
    }).catch(e => { if (!/single offscreen/i.test(String(e))) throw e; }).finally(() => { creating = null; });
  }
  await creating;
  await new Promise(r => setTimeout(r, 150));
}
const toOffscreen = async msg => {
  await ensureOffscreen();
  for (let i = 0; i < 20; i++) {
    try {
      const r = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
      if (r) return r;
    } catch (e) { /* Dokument lädt noch */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false, error: 'KI-Dokument antwortet nicht.' };
};

// ---------------- eigener Server (llama.cpp, Ollama, LM Studio …) ----------------
async function askServer(s, question, options) {
  const L = 'ABCDEF';
  const hasOpts = options && options.length >= 2;
  const user = hasOpts
    ? 'Aufgabe: ' + question + '\n' + options.map((o, i) => L[i] + ') ' + o).join('\n') + '\nWelche Antwort ist richtig? Antworte nur mit dem Buchstaben.'
    : 'Löse die Schulaufgabe. Antworte nur mit der Lösung (höchstens 4 Wörter), ohne Erklärung.\n\n' + question;
  const t0 = Date.now();
  const res = await fetch(String(s.serverUrl).replace(/\/+$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.serverModel || 'local-model', messages: [{ role: 'user', content: user }], temperature: 0, max_tokens: hasOpts ? 8 : 40 })
  });
  if (!res.ok) throw new Error('Server meldet HTTP ' + res.status);
  const data = await res.json();
  const m = data && data.choices && data.choices[0] && data.choices[0].message;
  let text = String((m && (m.content || m.reasoning_content)) || '').trim();
  if (hasOpts) {
    const hit = text.match(/\b([A-F])\b/i);
    let idx = hit ? L.indexOf(hit[1].toUpperCase()) : -1;
    if (idx < 0 || idx >= options.length) idx = options.findIndex(o => text.toLowerCase().includes(String(o).toLowerCase()));
    if (idx < 0) throw new Error('Antwort nicht verstanden: ' + text.slice(0, 60));
    return { ok: true, answer: options[idx], index: idx, confidence: null, ms: Date.now() - t0, device: 'server' };
  }
  text = text.split('\n').pop().trim();
  return { ok: !!text, answer: text, confidence: null, ms: Date.now() - t0, device: 'server' };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen' || msg.type === 'ai:progress') return;
  (async () => {
    try {
      const s = await getSettings();
      switch (msg.type) {
        case 'ai:status': {
          if (!(await chrome.offscreen.hasDocument())) return respond({ ok: true, status: { state: 'idle', modelId: '' }, installed: s.aiModel });
          const r = await toOffscreen({ type: 'status' });
          return respond(Object.assign({ installed: s.aiModel }, r));
        }
        case 'ai:install': {
          await chrome.storage.local.set({ settings: Object.assign(s, { aiModel: msg.modelId, aiBackend: 'builtin' }) });
          return respond(await toOffscreen({ type: 'load', modelId: msg.modelId }));
        }
        case 'ai:remove': {
          await toOffscreen({ type: 'remove' });
          try { await chrome.offscreen.closeDocument(); } catch (e) {}
          await chrome.storage.local.set({ settings: Object.assign(s, { aiModel: '', aiBackend: s.aiBackend === 'builtin' ? 'none' : s.aiBackend }) });
          return respond({ ok: true });
        }
        case 'ai:warm': {
          if (s.aiBackend === 'builtin' && s.aiModel) toOffscreen({ type: 'load', modelId: s.aiModel });
          return respond({ ok: true });
        }
        case 'ai:ask': {
          if (s.aiBackend === 'builtin' && s.aiModel) return respond(await toOffscreen({ type: 'ask', modelId: s.aiModel, question: msg.question, options: msg.options }));
          if (s.aiBackend === 'server') return respond(await askServer(s, msg.question, msg.options));
          return respond({ ok: false, error: 'Kein KI-Modell eingerichtet.' });
        }
        case 'server:test': {
          const r = await askServer(Object.assign({}, s, msg.settings || {}), 'Wie viel ist 2 + 3?', ['4', '5', '6']);
          return respond(r);
        }
        case 'auto:run': {
          // msg.payload should contain {question:string, options?:string[]}
          const payload = msg.payload || {};
          const baseDelay = 300; // minimum ms
          const lengthFactor = (payload.question?.length ?? 0) + (payload.options?.join('').length ?? 0);
          const delay = Math.min(2000, baseDelay + lengthFactor * 2); // max ~2 s
          await new Promise(r => setTimeout(r, delay));
          // Forward to the existing AI handler.
          if (s.aiBackend === 'builtin' && s.aiModel) {
            return respond(await toOffscreen({ type: 'ask', modelId: s.aiModel, question: payload.question, options: payload.options }));
          }
          if (s.aiBackend === 'server') {
            return respond(await askServer(s, payload.question, payload.options));
          }
          return respond({ ok: false, error: 'Kein KI‑Modell eingerichtet.' });
        }
        default: return respond({ ok: false, error: 'unbekannt' });
      }
    } catch (e) { respond({ ok: false, error: String((e && e.message) || e).slice(0, 300) }); }
  })();
  return true;
});
