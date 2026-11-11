// Auswahl für den KI-Installer. Trefferquoten: eigener Test mit 176 echten ANTON-Auswahlfragen
// (reine Textaufgaben, Zufall läge bei 42 %). Siehe ANLEITUNG.html.
export const MODELS = [
  {
    id: 'onnx-community/LFM2.5-350M-ONNX',
    name: 'Mini',
    sub: 'LFM2.5 · 350 Mio. Parameter',
    size: '≈ 300 MB',
    note: 'Am schnellsten. Liegt aber bei fast jeder zweiten Frage daneben.',
    score: 53
  },
  {
    id: 'onnx-community/LFM2-700M-ONNX',
    name: 'Klein',
    sub: 'LFM2 · 700 Mio. Parameter',
    size: '≈ 560 MB',
    note: 'Empfohlen, wenn schon KI: etwas treffsicherer, halb so schnell.',
    score: 60
  }
];
export const DEFAULT_SETTINGS = {
  enabled: true, marks: true, panel: true, reveal: 'always',
  aiBackend: 'none', aiAuto: true, aiModel: '', serverUrl: 'http://127.0.0.1:8080', serverModel: 'local-model',
  open: false, pos: null
};
