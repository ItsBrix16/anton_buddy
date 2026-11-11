import { MODELS, DEFAULT_SETTINGS } from './models.js';
const $ = id => document.getElementById(id);
let settings = Object.assign({}, DEFAULT_SETTINGS);
let ai = { state: 'idle', modelId: '', progress: 0 };

const save = async patch => { Object.assign(settings, patch); await chrome.storage.local.set({ settings }); paint(); };
const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);

function paint() {
  $('enabled').checked = settings.enabled;
  $('onoff').textContent = settings.enabled ? 'ist an' : 'ist aus';
  $('marks').checked = settings.marks;
  $('panel').checked = settings.panel;
  $('reveal').checked = settings.reveal === 'click';
  $('aiAuto').checked = settings.aiAuto;
  if (document.activeElement !== $('serverUrl')) $('serverUrl').value = settings.serverUrl || '';
  if (document.activeElement !== $('serverModel')) $('serverModel').value = settings.serverModel || '';
  paintModels();
}

function paintModels() {
  const box = $('models');
  box.textContent = '';
  for (const m of MODELS) {
    const isCur = settings.aiBackend === 'builtin' && settings.aiModel === m.id;
    const busy = ai.modelId === m.id && ai.state === 'downloading';
    const ready = isCur && (ai.state === 'ready' || ai.state === 'idle');
    const d = document.createElement('div');
    d.className = 'model' + (isCur ? ' cur' : '') + (busy ? ' busy' : '');
    const top = document.createElement('div'); top.className = 'top';
    const info = document.createElement('div');
    const b = document.createElement('b'); b.textContent = m.name + ' · ' + m.size;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = m.sub + (m.score != null ? ' · im Test ' + m.score + ' % richtig' : '');
    info.append(b, meta);
    const btn = document.createElement('button');
    btn.className = 'btn' + (isCur ? '' : ' pri');
    btn.textContent = busy ? Math.round(ai.progress * 100) + ' %' : isCur ? 'Entfernen' : 'Installieren';
    btn.disabled = busy;
    btn.addEventListener('click', async () => {
      if (isCur) { await send({ type: 'ai:remove' }); ai = { state: 'idle', modelId: '', progress: 0 }; await load(); }
      else { ai = { state: 'downloading', modelId: m.id, progress: 0 }; paintModels(); await send({ type: 'ai:install', modelId: m.id }); await load(false); }
    });
    top.append(info, btn);
    const bar = document.createElement('div'); bar.className = 'bar';
    const fill = document.createElement('i'); fill.style.width = Math.round((busy ? ai.progress : 0) * 100) + '%'; bar.append(fill);
    const msg = document.createElement('div'); msg.className = 'msg';
    if (busy) msg.textContent = 'Lädt einmalig herunter' + (ai.totalBytes ? ' (' + Math.round(ai.loadedBytes / 1e6) + ' von ' + Math.round(ai.totalBytes / 1e6) + ' MB)' : '') + ' … Fenster darf zu.';
    else if (ai.modelId === m.id && ai.state === 'error') { msg.textContent = 'Fehler: ' + ai.error; msg.classList.add('err'); }
    else if (isCur && ai.state === 'ready') msg.textContent = 'Bereit – rechnet auf ' + (ai.device === 'webgpu' ? 'der Grafikkarte' : 'dem Prozessor') + '.';
    else if (ready) msg.textContent = 'Installiert.';
    else msg.textContent = m.note;
    d.append(top, bar, msg);
    box.append(d);
  }
}

async function pageStatus() {
  const box = $('status'), a = $('st1'), b = $('st2');
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
  const onAnton = tab && tab.url && /^https:\/\/([a-z0-9-]+\.)?anton\.app\//.test(tab.url);
  $('openWrap').style.display = onAnton ? 'none' : 'flex';
  if (!onAnton) { box.classList.remove('ok'); a.textContent = 'Du bist nicht auf anton.app'; b.textContent = 'Öffne ANTON und starte eine Übung.'; return; }
  let r = null;
  try { r = await chrome.tabs.sendMessage(tab.id, { type: 'page:status' }); } catch (e) {}
  if (!r) { box.classList.remove('ok'); a.textContent = 'Seite bitte einmal neu laden'; b.textContent = 'Der Buddy wurde erst nach dem Öffnen der Seite installiert.'; return; }
  if (r.tasks) { box.classList.add('ok'); a.textContent = r.title || 'Übung erkannt'; b.textContent = r.tasks + ' Lösungen bereit'; }
  else { box.classList.remove('ok'); a.textContent = 'Bereit'; b.textContent = 'Starte eine Übung – die Lösungen erscheinen von selbst.'; }
}

async function load(askStatus = true) {
  settings = Object.assign({}, DEFAULT_SETTINGS, (await chrome.storage.local.get('settings')).settings || {});
  if (askStatus) { const r = await send({ type: 'ai:status' }); if (r && r.status) ai = r.status; }
  paint();
}

for (const id of ['enabled', 'marks', 'panel', 'aiAuto']) $(id).addEventListener('change', e => save({ [id]: e.target.checked }));
$('reveal').addEventListener('change', e => save({ reveal: e.target.checked ? 'click' : 'always' }));
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => {
  for (const x of document.querySelectorAll('.tab')) x.setAttribute('aria-selected', String(x === t));
  for (const s of document.querySelectorAll('section')) s.classList.toggle('on', s.id === t.dataset.tab);
});
$('tut').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }));
$('ver').textContent = chrome.runtime.getManifest().version;

async function serverPerm() {
  try { return await chrome.permissions.request({ origins: ['http://127.0.0.1/*', 'http://localhost/*'] }); } catch (e) { return false; }
}
$('srvUse').addEventListener('click', async () => {
  if (!(await serverPerm())) { $('srvMsg').textContent = 'Ohne Erlaubnis kann der Server nicht erreicht werden.'; return; }
  await save({ aiBackend: 'server', serverUrl: $('serverUrl').value.trim() || DEFAULT_SETTINGS.serverUrl, serverModel: $('serverModel').value.trim() || DEFAULT_SETTINGS.serverModel });
  $('srvMsg').className = 'msg'; $('srvMsg').textContent = 'Gespeichert. Die KI-Notlösung fragt jetzt deinen Server.';
});
$('srvTest').addEventListener('click', async () => {
  if (!(await serverPerm())) return;
  $('srvMsg').className = 'msg'; $('srvMsg').textContent = 'Teste …';
  const r = await send({ type: 'server:test', settings: { serverUrl: $('serverUrl').value.trim(), serverModel: $('serverModel').value.trim() } });
  if (r && r.ok) { $('srvMsg').textContent = 'Verbunden. Testfrage 2 + 3 → ' + r.answer + ' (' + r.ms + ' ms)'; }
  else { $('srvMsg').className = 'msg err'; $('srvMsg').textContent = 'Keine Verbindung: ' + ((r && r.error) || 'unbekannt'); }
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'ai:progress' && msg.status) { ai = msg.status; paintModels(); }
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, ch.settings.newValue || {}); paint(); } });

load().then(() => { if (settings.aiBackend === 'server') $('srv').open = true; });
pageStatus();
