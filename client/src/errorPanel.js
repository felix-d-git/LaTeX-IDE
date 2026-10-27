import { api } from './api.js';
import { toggleDropdown } from './dropdown.js';
import { fixHint } from './fixHint.js';

// R1/R6: Die Log-/Fehleransicht ist ein volldeckendes Overlay der PDF-Spalte
// (z-index 11). Aufbau: Tabs All/Errors/Warnings/Info mit
// Zählern, aufklappbare Karten (Klartext-Hinweis + Log-Auszug + ⌖), Fuß mit
// "Clear cached files"/"Other logs and files", "Back to PDF" als Pille in
// der PDF-Toolbar. Der rote Zähler sitzt als Badge auf dem Logs-Button.
const LEVELS = { error: 'Errors', warning: 'Warnings', info: 'Info' };

export function setupErrorPanel({ onJumpTo }) {
  const panel = document.getElementById('log-panel');
  const btnToggle = document.getElementById('btn-errors');
  const btnBack = document.getElementById('btn-close-errors');
  const tabsEl = document.getElementById('log-tabs');
  const blocksEl = document.getElementById('error-blocks');
  const emptyEl = document.getElementById('error-panel-empty');
  const badgeEl = document.getElementById('error-badge');
  const rawLog = document.getElementById('pdf-log-view');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const btnOtherLogs = document.getElementById('btn-other-logs');

  let entries = [];
  let filter = 'all';

  const isOpen = () => !panel.classList.contains('hidden');

  function show() {
    panel.classList.remove('hidden');
    btnBack.classList.remove('hidden');
  }

  function hide() {
    panel.classList.add('hidden');
    btnBack.classList.add('hidden');
  }

  function toggle() {
    if (isOpen()) hide();
    else show();
  }

  function setLog({ errors = [], warnings = [], infos = [] }) {
    entries = [
      ...errors.map((e) => ({ ...e, level: 'error' })),
      ...warnings.map((e) => ({ ...e, level: 'warning' })),
      ...infos.map((e) => ({ ...e, level: 'info' })),
    ];
    badgeEl.textContent = String(errors.length);
    badgeEl.classList.toggle('hidden', errors.length === 0);
    btnToggle.classList.toggle('has-errors', errors.length > 0);
    render();
  }

  function render() {
    for (const tab of tabsEl.querySelectorAll('[data-level]')) {
      const lvl = tab.dataset.level;
      const n = lvl === 'all' ? entries.length : entries.filter((e) => e.level === lvl).length;
      tab.querySelector('.log-count').textContent = n ? String(n) : '';
      tab.classList.toggle('active', lvl === filter);
      tab.setAttribute('aria-selected', String(lvl === filter));
    }
    const shown = filter === 'all' ? entries : entries.filter((e) => e.level === filter);
    emptyEl.classList.toggle('hidden', shown.length > 0);
    emptyEl.textContent = filter === 'all' ? 'Keine Meldungen beim letzten Kompilieren.' : `Keine ${LEVELS[filter]}.`;
    blocksEl.replaceChildren(...shown.map(card));
  }

  function card(e) {
    const el = document.createElement('div');
    el.className = `log-card level-${e.level}`;

    const head = document.createElement('div');
    head.className = 'log-card-head';
    const chevron = document.createElement('button');
    chevron.className = 'log-card-chevron';
    chevron.setAttribute('aria-label', 'Details');
    chevron.setAttribute('aria-expanded', 'false');
    chevron.innerHTML = '<svg class="ui-icon"><use href="#i-chevron-right"></use></svg>';
    const title = document.createElement('div');
    title.className = 'log-card-title';
    title.textContent = e.message;
    const loc = document.createElement('div');
    loc.className = 'log-card-loc';
    loc.textContent = e.file ? `${e.file}${e.line ? `, ${e.line}` : ''}` : '';
    head.append(chevron, title, loc);
    if (e.file && e.line) {
      // ⌖ springt in den Editor, das Log bleibt offen.
      const go = document.createElement('button');
      go.className = 'log-card-goto';
      go.title = 'Zur Stelle im Code springen';
      go.textContent = '⌖';
      go.setAttribute('aria-label', 'Zur Stelle im Code springen');
      go.addEventListener('click', () => onJumpTo(e.file, e.line));
      head.appendChild(go);
    }

    const body = document.createElement('div');
    body.className = 'log-card-body hidden';
    if (e.hint) {
      const hint = document.createElement('p');
      hint.className = 'log-card-hint';
      hint.textContent = e.hint;
      body.appendChild(hint);
    }
    if (e.raw) {
      const pre = document.createElement('pre');
      pre.textContent = e.raw;
      body.appendChild(pre);
    }
    chevron.addEventListener('click', () => {
      const open = body.classList.toggle('hidden') === false;
      chevron.setAttribute('aria-expanded', String(open));
      el.classList.toggle('is-open', open);
    });
    el.append(head, body);
    const fix = fixHint(e.message, (e.raw || '').match(/^l\.\d+ (.*)$/m)?.[1]);
    if (fix) {
      const f = document.createElement('div');
      f.className = 'log-card-fix';
      f.textContent = `Vermutlicher Fix: ${fix}`;
      el.appendChild(f);
    }
    return el;
  }

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-level]');
    if (!tab) return;
    filter = tab.dataset.level;
    render();
  });

  btnClearCache.addEventListener('click', async () => {
    btnClearCache.disabled = true;
    try {
      await api.clearCache();
    } catch (e) {
      alert('Cache leeren fehlgeschlagen: ' + e.message);
    } finally {
      btnClearCache.disabled = false;
    }
  });

  btnOtherLogs.addEventListener('click', () =>
    toggleDropdown(btnOtherLogs, [
      { label: rawLog.classList.contains('hidden') ? 'Raw log anzeigen' : 'Raw log ausblenden', onClick: () => rawLog.classList.toggle('hidden') },
      {
        label: 'Log-Datei herunterladen',
        icon: 'download',
        onClick: () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([rawLog.textContent], { type: 'text/plain' }));
          a.download = 'output.log';
          a.click();
          URL.revokeObjectURL(a.href);
        },
      },
    ])
  );

  btnToggle.addEventListener('click', toggle);
  btnBack.addEventListener('click', hide);

  return { show, hide, toggle, isOpen, setLog };
}
