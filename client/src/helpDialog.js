// Help page: first tab is the onboarding tour, the rest explain the areas.
// Opens once automatically for every new browser (localStorage flag).
const SEEN_KEY = 'latex-ide-onboarding-seen-v1';

const SECTIONS = [
  ['Einführung', [
    'Willkommen in der LaTeX Web IDE. Auf der Startseite legst du Projekte an, lädst ZIPs hoch oder öffnest vorhandene Projekte.',
    'Im Projekt: links die Leiste mit Dateibaum, Suche, Review und Kommentaren; in der Mitte der Editor; rechts das PDF.',
    'Speichern passiert automatisch. Strg+S oder Strg+Enter kompiliert das Hauptdokument.',
    'Unten links findest du Hilfe (?), Einstellungen (Zahnrad) und dein Profil.',
  ]],
  ['Projekte', [
    '„Alle Projekte“ zeigt deine eigenen und die für dich freigegebenen Projekte; freigegebene lassen sich nur öffnen, nicht umbenennen oder löschen.',
    'Über „Teilen“ gibst du ein Projekt für andere Konten frei.',
  ]],
  ['Editor & Dateien', [
    'Dateibaum: Rechtsklick für Neu, Umbenennen, Löschen, Hochladen. Die Hauptdatei (Stern) wird kompiliert.',
    'Projektsuche (Lupe) durchsucht alle Dateien. Strg+F sucht in der offenen Datei.',
    'Mehrere Personen können gleichzeitig in derselben Datei schreiben; Cursor der anderen sind farbig markiert.',
  ]],
  ['PDF & Kompilieren', [
    'Recompile startet den Lauf, das Log zeigt Fehler und Warnungen als Karten – ein Klick springt zur Zeile.',
    'Doppelklick im PDF springt zur Stelle im Quelltext (SyncTeX), und umgekehrt.',
    'In geteilten Projekten kompiliert standardmäßig jeder für sich und sieht nur sein eigenes PDF. Unter Einstellungen → Compiler lässt sich auf Gruppen-Kompilieren umstellen.',
  ]],
  ['Review & Kommentare', [
    'Review zeigt vorgeschlagene Änderungen, die man annehmen oder ablehnen kann – auch Konflikte nach einer Offline-Phase landen dort.',
    'Kommentare hängen an einer Textstelle; Text markieren und Kommentar hinzufügen.',
  ]],
  ['Offline & Desktop-App', [
    'Die Desktop-App hält von deinen eigenen Projekten eine lokale Kopie und kompiliert lokal.',
    'Ohne Verbindung erscheint oben ein gelber Hinweis (mit × zu einem schmalen Balken verkleinerbar); du arbeitest in der lokalen Kopie weiter.',
    'Beim Wiederverbinden werden die Änderungen zusammengeführt; Konflikte erscheinen im Review.',
  ]],
  ['Tastenkürzel', [
    'Alle Tastenkürzel lassen sich unter Einstellungen → Editor → „Tastenkürzel bearbeiten…“ ansehen und ändern.',
  ]],
];

export function setupHelpDialog() {
  const modal = document.getElementById('help-dialog');
  const tabs = document.getElementById('help-tabs');
  const body = document.getElementById('help-body');
  let active = 0;

  function render() {
    tabs.innerHTML = '';
    SECTIONS.forEach(([title], i) => {
      const b = document.createElement('button');
      b.className = 'tab-btn' + (i === active ? ' active' : '');
      b.textContent = title;
      b.addEventListener('click', () => ((active = i), render()));
      tabs.appendChild(b);
    });
    body.innerHTML = '';
    const ul = document.createElement('ul');
    for (const line of SECTIONS[active][1]) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  const show = (section = 0) => {
    active = section;
    render();
    modal.classList.remove('hidden');
  };
  const hide = () => {
    modal.classList.add('hidden');
    try { localStorage.setItem(SEEN_KEY, '1'); } catch {}
  };
  const isOpen = () => !modal.classList.contains('hidden');
  document.getElementById('btn-close-help').addEventListener('click', hide);
  modal.querySelector('.modal-backdrop').addEventListener('click', hide);

  let seen = true;
  try { seen = !!localStorage.getItem(SEEN_KEY); } catch {}
  if (!seen) show(0);

  return { show, hide, isOpen };
}
