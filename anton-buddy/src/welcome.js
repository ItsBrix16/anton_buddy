// Probe-Übung für die Anleitung: dieselben Daten, wie ANTON sie liefert
(function () {
  const level = {
    title: 'Probe-Runde', puid: 'demo/probe',
    trainers: [
      { trainer: 'buttons', instruction: { text: 'Welches Wort ist ein Nomen?' }, atoms: { a: '', b: 'laufen ++Katze schnell' } },
      { trainer: 'gap', gapMode: 'write', instruction: { text: 'Bilde die Mehrzahl.' }, atoms: { a: 'das Schulkind', b: 'die ((Schulkinder))' } },
      { trainer: 'dragGroup', instruction: { text: 'Ordne passend zu.' }, cats: ['Tier', 'Gefühl', 'Ding'],
        atoms: [{ cat: 0, b: 'der Pinguin' }, { cat: 1, b: 'die Liebe' }, { cat: 2, b: 'der Hammer' }] }
    ]
  };
  const post = () => window.postMessage({ source: 'loesungs-buddy', type: 'LEVEL', level }, window.location.origin);
  setTimeout(post, 300);
  setTimeout(post, 1500);
  const first = document.querySelector('#demo .slide');
  if (first) first.addEventListener('click', ev => {
    const b = ev.target.closest('.button');
    if (!b) return;
    for (const x of first.querySelectorAll('.button')) x.classList.remove('right', 'wrongpick');
    b.classList.add(b.textContent.trim() === 'Katze' ? 'right' : 'wrongpick');
  });
})();
