// Help page: first tab is the onboarding tour, the rest explain the areas.
// Opens once automatically for every new browser (localStorage flag).
import { version } from '../../package.json';

const SEEN_KEY = 'latex-ide-onboarding-seen-v1';

const SECTIONS = [
  ['Einführung', [
    'Willkommen bei LatexIDE. Auf der Startseite legst du Projekte an, lädst ZIPs hoch oder öffnest vorhandene Projekte.',
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
    'Kompilieren startet den Lauf, das Log zeigt Fehler und Warnungen als Karten – ein Klick springt zur Zeile.',
    'Doppelklick im PDF springt zur Stelle im Quelltext (SyncTeX), und umgekehrt.',
    'In geteilten Projekten kompiliert standardmäßig jeder für sich und sieht nur sein eigenes PDF. Unter Einstellungen → Compiler lässt sich auf Gruppen-Kompilieren umstellen.',
  ]],
  ['Review & Kommentare', [
    'Review zeigt vorgeschlagene Änderungen, die man annehmen oder ablehnen kann – auch Konflikte nach einer Offline-Phase landen dort.',
    'Kommentare hängen an einer Textstelle; Text markieren und Kommentar hinzufügen.',
  ]],
  ['Literatur & Zotero', [
    'Zotero-Zugang einrichten: [zotero.org/settings/keys](https://www.zotero.org/settings/keys) öffnen und „Create new private key“ wählen.',
    'Beschreibung vergeben und unter „Personal Library“ „Allow library access“ (Lesen) aktivieren; speichern und den angezeigten Schlüssel kopieren.',
    'Auf derselben Seite steht „Your userID for use in API calls“ – diese Zahl ist die Library-ID. Bei einer Gruppenbibliothek ist es die Zahl aus der Gruppen-URL (zotero.org/groups/<ID>/…), Bibliothek = „Gruppe“.',
    'In der IDE: Einstellungen ▸ References: Library-ID und API-Key eintragen, „Zotero-Zugang speichern“.',
    'Der API-Key wird auf dem Server gespeichert, der damit deine Bibliothek bei zotero.org abruft – nur Lesezugriff erteilen.',
    'Danach Neue Datei ▸ References ▸ Zotero: „Aus Zotero importieren“ legt die .bib-Datei im Projekt an.',
  ]],
  ['Offline & Desktop-App', [
    'Die Desktop-App hält von deinen eigenen Projekten eine lokale Kopie und kompiliert lokal.',
    'Ohne Verbindung erscheint oben ein gelber Hinweis (mit × zu einem schmalen Balken verkleinerbar); du arbeitest in der lokalen Kopie weiter.',
    'Beim Wiederverbinden werden die Änderungen zusammengeführt; Konflikte erscheinen im Review.',
  ]],
  ['Grammatik (LanguageTool)', [
    'Einstellungen → Rechtschreibung → „Grammatik & Rechtschreibung“ einschalten. Der Server kann einen LanguageTool bereitstellen (LANGUAGETOOL_URL).',
    "Eigener lokaler Server: java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081 --allow-origin '*' starten und http://localhost:8081 unter „LanguageTool-URL (eigener Rechner)“ eintragen.",
    'Desktop-App: funktioniert direkt (Proxy). Im Web fragt der Browser den lokalen Server selbst, darum ist --allow-origin nötig; Safari blockiert das, Chrome fragt ggf. nach Zugriff auf lokale Geräte.',
    'Ist der Server nicht erreichbar, erscheint ein einmaliger Hinweis; nach 30 Sekunden wird erneut versucht.',
  ]],
  ['Tastenkürzel', [
    'Alle Tastenkürzel lassen sich unter Einstellungen → Editor → „Tastenkürzel bearbeiten…“ ansehen und ändern.',
  ]],
  // Letzter Reiter = Help ▸ About (AGPL §0/§5: Copyright, Gewährleistungsausschluss, Lizenz, Quellcode).
  ['Über & Lizenz', [
    `LatexIDE ${version} – Copyright (C) 2026 felix-d-git.`,
    'Freie Software ohne jede Gewährleistung. Weitergabe und Änderung sind unter der GNU Affero General Public License, ausschließlich Version 3 (AGPL-3.0-only), erlaubt.',
    '[Quellcode dieser Version](/source)',
    '[Lizenzen (AGPL & Drittanbieter)](/licenses): Lizenztext und Hinweise zur enthaltenen Fremdsoftware.',
  ]],
];

// Text mit [Label](https://…)- oder [Label](/pfad)-Links in ein Element schreiben (target=_blank, noopener).
export function linkify(el, text) {
  el.textContent = '';
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\((https:\/\/[^)\s]+|\/(?!\/)[^)\s]*)\)/g)) {
    el.append(text.slice(last, m.index));
    const a = Object.assign(document.createElement('a'), { textContent: m[1], href: m[2], target: '_blank', rel: 'noopener' });
    el.append(a);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
  return el;
}

export function setupHelpDialog() {
  const modal = document.getElementById('help-dialog');
  const tabs = document.getElementById('help-tabs');
  const body = document.getElementById('help-body');
  const heading = modal.querySelector('.dialog-header h3');
  const helpTitle = heading.textContent;
  const ABOUT = SECTIONS.length - 1;
  let active = 0;

  function render() {
    heading.textContent = active === ABOUT ? 'Über LatexIDE' : helpTitle;
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
      linkify(li, line);
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

  return { show, hide, isOpen, showAbout: () => show(ABOUT) };
}
