import { api } from './api.js';

// Rail-Panel „Projektsuche": bewusst NUR Suche über alle Dateien des Projekts.
// Ersetzen gehört ins Editor-Panel (Strg+F, CodeMirror-Suchleiste unten), das
// pro Datei arbeitet und die Änderung sichtbar im Text macht.
export function setupSearchPanel({ onOpenResult }) {
  const panel = document.getElementById('search-panel');
  const btnClose = document.getElementById('btn-close-search');
  const queryEl = document.getElementById('search-query');
  const optRegex = document.getElementById('opt-regex');
  const optCase = document.getElementById('opt-case');
  const optWord = document.getElementById('opt-word');
  const resultsEl = document.getElementById('search-results');
  const btnSearch = document.getElementById('btn-do-search');

  function opts() {
    return { regex: optRegex.checked, caseSensitive: optCase.checked, wholeWord: optWord.checked };
  }

  function open() {
    panel.classList.remove('hidden');
    queryEl.focus();
  }
  function close() {
    panel.classList.add('hidden');
  }
  function isOpen() {
    return !panel.classList.contains('hidden');
  }
  function toggle() {
    if (isOpen()) close();
    else open();
  }

  btnClose.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    // Nur wenn der Fokus in der Suche liegt und niemand (Autocomplete, Dialog, Vim) Escape schon behandelt hat.
    if (e.key === 'Escape' && isOpen() && !e.defaultPrevented && panel.contains(document.activeElement)) close();
  });

  let searchSeq = 0;
  async function doSearch() {
    const q = queryEl.value;
    if (!q) return;
    resultsEl.innerHTML = 'Suche läuft…';
    const seq = ++searchSeq; // langsamere aeltere Antwort darf die neuere nicht ueberschreiben
    try {
      const { results } = await api.search(q, opts());
      if (seq === searchSeq) renderResults(results, q);
    } catch (e) {
      if (seq === searchSeq) resultsEl.textContent = 'Fehler: ' + e.message;
    }
  }

  function renderResults(results, q) {
    resultsEl.innerHTML = '';
    if (!results.length) {
      resultsEl.textContent = 'Keine Treffer.';
      return;
    }
    let lastFile = null;
    let total = 0;
    for (const r of results) {
      total += r.matches.length;
      if (r.file !== lastFile) {
        const h = document.createElement('div');
        h.className = 'search-result-file';
        h.textContent = r.file;
        resultsEl.appendChild(h);
        lastFile = r.file;
      }
      const line = document.createElement('div');
      line.className = 'search-result-line';
      line.innerHTML = highlight(r.lineText, r.matches);
      line.addEventListener('click', () => onOpenResult(r.file, r.line));
      resultsEl.appendChild(line);
    }
    const summary = document.createElement('div');
    summary.style.marginTop = '8px';
    summary.style.opacity = '0.7';
    summary.textContent = `${total} Treffer in ${new Set(results.map((r) => r.file)).size} Datei(en)`;
    resultsEl.appendChild(summary);
  }

  function highlight(text, matches) {
    let out = '';
    let last = 0;
    for (const m of matches) {
      out += escapeHtml(text.slice(last, m.col));
      out += `<mark>${escapeHtml(text.slice(m.col, m.col + m.length))}</mark>`;
      last = m.col + m.length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  btnSearch.addEventListener('click', doSearch);
  queryEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  return { open, close, toggle, isOpen };
}
