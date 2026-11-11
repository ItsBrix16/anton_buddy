/*
 * Lösungs-Buddy – offscreen.js
 * Lässt ein kleines Sprachmodell direkt im Browser laufen (WebGPU, sonst WASM).
 * Das Modell wird einmal von Hugging Face geladen und bleibt im Browser-Speicher.
 */
import { AutoTokenizer, AutoModelForCausalLM, LogitsProcessor, LogitsProcessorList, env } from '../vendor/transformers.min.js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// Zwei Rechen-Kerne liegen bei: einer für die Grafikkarte (WebGPU), einer für den Prozessor.
// Welcher gebraucht wird, muss vor dem ersten Laden feststehen.
async function pickDevice() {
  if (sessionStorage.getItem('lbNoGpu') === '1') return { device: 'wasm', dtype: 'q4' };
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) return { device: 'webgpu', dtype: ad.features && ad.features.has('shader-f16') ? 'q4f16' : 'q4' };
    }
  } catch (e) {}
  return { device: 'wasm', dtype: 'q4' };
}
const RUN = await pickDevice();
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
try {
  const base = RUN.device === 'webgpu' ? 'vendor/ort-wasm-simd-threaded.asyncify' : 'vendor/ort-wasm-simd-threaded';
  env.backends.onnx.wasm.wasmPaths = { mjs: chrome.runtime.getURL(base + '.mjs'), wasm: chrome.runtime.getURL(base + '.wasm') };
  env.backends.onnx.wasm.numThreads = THREADS;
} catch (e) {}

const L = 'ABCDEF';
const st = { state: 'idle', modelId: '', device: RUN.device, threads: THREADS, isolated: !!self.crossOriginIsolated, progress: 0, error: '', loadedBytes: 0, totalBytes: 0 };
let tok = null, model = null, letterIds = null, loading = null;

function publish() {
  try { chrome.runtime.sendMessage({ type: 'ai:progress', status: Object.assign({}, st) }, () => void chrome.runtime.lastError); } catch (e) {}
}

class Pick extends LogitsProcessor {
  constructor(groups) { super(); this.groups = groups; this.scores = null; }
  _call(input_ids, logits) {
    const d = logits.data;
    this.scores = this.groups.map(ids => Math.max(...ids.map(i => Number(d[i]))));
    const keep = [];
    for (const ids of this.groups) for (const i of ids) keep.push([i, d[i]]);
    d.fill(-Infinity);
    for (const [i, v] of keep) d[i] = v;
    return logits;
  }
}

async function load(modelId) {
  if (model && st.modelId === modelId && st.state === 'ready') return;
  if (loading && st.modelId === modelId) return loading;
  loading = (async () => {
    try {
      if (model && model.dispose) { try { await model.dispose(); } catch (e) {} }
      model = null; tok = null;
      Object.assign(st, { state: 'downloading', modelId, progress: 0, error: '', loadedBytes: 0, totalBytes: 0 });
      publish();
      const files = new Map();
      let last = 0;
      const progress_callback = p => {
        if (!p || !p.file) return;
        if (p.status === 'progress' || p.status === 'done' || p.status === 'download') {
          const f = files.get(p.file) || { loaded: 0, total: 0 };
          if (p.total) f.total = p.total;
          if (p.loaded != null) f.loaded = p.loaded;
          if (p.status === 'done' && f.total) f.loaded = f.total;
          files.set(p.file, f);
          let l = 0, t = 0;
          for (const x of files.values()) { l += x.loaded; t += x.total; }
          st.loadedBytes = l; st.totalBytes = t;
          st.progress = t ? Math.min(0.99, l / t) : 0;
          const now = Date.now();
          if (now - last > 250) { last = now; publish(); }
        }
      };
      const { device, dtype } = RUN;
      st.device = device;
      tok = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
      try {
        model = await AutoModelForCausalLM.from_pretrained(modelId, { device, dtype, progress_callback });
      } catch (e) {
        if (device !== 'webgpu') throw e;
        // Grafikkarte will nicht -> Dokument neu starten und auf dem Prozessor rechnen
        sessionStorage.setItem('lbNoGpu', '1');
        sessionStorage.setItem('lbPending', modelId);
        location.reload();
        return;
      }
      letterIds = [...L].map(ch => {
        const s = new Set();
        for (const v of [ch, ' ' + ch]) { const ids = tok.encode(v, { add_special_tokens: false }); if (ids.length === 1) s.add(Number(ids[0])); }
        return [...s];
      });
      Object.assign(st, { state: 'ready', progress: 1 });
      publish();
    } catch (e) {
      Object.assign(st, { state: 'error', error: String((e && e.message) || e).slice(0, 300) });
      model = null; tok = null;
      publish();
      throw e;
    } finally { loading = null; }
  })();
  return loading;
}

const softmax = a => { const m = Math.max(...a); const e = a.map(x => Math.exp(x - m)); const s = e.reduce((x, y) => x + y, 0); return e.map(x => x / s); };

async function pass(question, opts) {
  const user = 'Aufgabe: ' + question + '\n' + opts.map((o, i) => L[i] + ') ' + o).join('\n') + '\nWelche Antwort ist richtig? Antworte nur mit dem Buchstaben.';
  const inputs = tok.apply_chat_template([{ role: 'user', content: user }], { add_generation_prompt: true, return_dict: true });
  const proc = new Pick(letterIds.slice(0, opts.length));
  const lp = new LogitsProcessorList(); lp.push(proc);
  await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false, logits_processor: lp });
  return softmax(proc.scores);
}

async function ask(question, options) {
  const t0 = performance.now();
  options = (options || []).slice(0, 6);
  if (options.length >= 2 && letterIds.slice(0, options.length).every(g => g.length)) {
    // zwei Durchgänge (normal + umgekehrte Reihenfolge) gleichen die Vorliebe kleiner Modelle für "A" aus
    const p1 = await pass(question, options);
    const p2 = (await pass(question, options.slice().reverse())).reverse();
    const avg = p1.map((x, i) => (x + p2[i]) / 2);
    const idx = avg.indexOf(Math.max(...avg));
    return { ok: true, answer: options[idx], index: idx, confidence: avg[idx], ms: Math.round(performance.now() - t0), device: st.device };
  }
  const user = 'Löse die Schulaufgabe. Antworte nur mit der Lösung (höchstens 4 Wörter), ohne Erklärung.\n\n' + question;
  const inputs = tok.apply_chat_template([{ role: 'user', content: user }], { add_generation_prompt: true, return_dict: true });
  const out = await model.generate({ ...inputs, max_new_tokens: 16, do_sample: false });
  const n = inputs.input_ids.dims[1];
  const text = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: true }).split('\n')[0].trim();
  return { ok: !!text, answer: text, confidence: null, ms: Math.round(performance.now() - t0), device: st.device };
}

async function removeAll() {
  try { if (model && model.dispose) await model.dispose(); } catch (e) {}
  model = null; tok = null;
  try { for (const k of await caches.keys()) if (/transformers/i.test(k)) await caches.delete(k); } catch (e) {}
  Object.assign(st, { state: 'idle', modelId: '', progress: 0, error: '' });
  publish();
}

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'status') return respond({ ok: true, status: st });
      if (msg.type === 'load') { load(msg.modelId).catch(() => {}); return respond({ ok: true, status: st }); }
      if (msg.type === 'remove') { await removeAll(); return respond({ ok: true }); }
      if (msg.type === 'ask') {
        const job = queue.then(async () => { await load(msg.modelId); return ask(msg.question, msg.options); });
        queue = job.catch(() => {});
        return respond(await job);
      }
      respond({ ok: false, error: 'unbekannt' });
    } catch (e) { respond({ ok: false, error: String((e && e.message) || e).slice(0, 300) }); }
  })();
  return true;
});
publish();
const pending = sessionStorage.getItem('lbPending');
if (pending) { sessionStorage.removeItem('lbPending'); load(pending).catch(() => {}); }
