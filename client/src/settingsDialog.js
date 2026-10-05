import { api } from './api.js';

const APPEARANCE_KEY = 'latex-ide-appearance-v1';
const SPELLING_KEY = 'latex-ide-spelling-v1';

const DEFAULT_APPEARANCE = { theme: 'light', fontSize: '14.5px', fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.5' };
const DEFAULT_SPELLING = { enabled: true, lang: 'de' };

function loadJson(key, fallback) {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key)) || {}) };
  } catch (e) {
    return { ...fallback };
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setupSettingsDialog({ editorMgr, onShowHotkeys } = {}) {
  const modal = document.getElementById('settings-dialog');
  const btnClose = document.getElementById('btn-close-settings');
  const tabsBar = document.getElementById('settings-tabs');
  const body = document.getElementById('settings-tab-body');

  let appearance = loadJson(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  let spelling = loadJson(SPELLING_KEY, DEFAULT_SPELLING);
  let serverSettings = { compiler: 'pdflatex', stopOnFirstError: false, autocompile: false };
  let activeTab = 'editor';

  // Restore persisted, genuinely-applied preferences on startup, not just
  // when the dialog is opened - font/theme/spellcheck should survive reloads.
  applyTheme(appearance.theme);
  if (editorMgr) {
    editorMgr.setFontSettings(appearance);
    editorMgr.setSpellcheck(spelling);
  }

  let desktopInfo = null;
  function show() {
    modal.classList.remove('hidden');
    if (!desktopInfo) {
      fetch('/api/desktop/info').then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || !d.desktop || desktopInfo) return;
        desktopInfo = d;
        const b = Object.assign(document.createElement('button'), { className: 'tab-btn', textContent: 'Lokale Kopie' });
        b.dataset.settingsTab = 'local';
        tabsBar.appendChild(b);
      }).catch(() => {});
    }
    // No active project (dashboard) -> project tabs keep their defaults.
    api.getSettings().then(({ settings }) => {
      serverSettings = settings;
      render();
    }).catch(() => {});
    render();
  }

  function hide() {
    modal.classList.add('hidden');
  }

  function toggle() {
    modal.classList.contains('hidden') ? show() : hide();
  }

  function isOpen() {
    return !modal.classList.contains('hidden');
  }

  function field(labelText, inputEl) {
    const row = document.createElement('label');
    row.className = 'settings-field';
    const span = document.createElement('span');
    span.textContent = labelText;
    row.appendChild(span);
    row.appendChild(inputEl);
    return row;
  }

  function selectField(labelText, options, value, onChange) {
    const select = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => onChange(select.value));
    return field(labelText, select);
  }

  function checkboxField(labelText, checked, onChange) {
    const row = document.createElement('label');
    row.className = 'settings-field settings-field-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(input);
    const span = document.createElement('span');
    span.textContent = labelText;
    row.appendChild(span);
    return row;
  }

  function textField(labelText, value, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    return field(labelText, input);
  }

  function inertNote(text) {
    const p = document.createElement('p');
    p.className = 'settings-inert-note';
    p.textContent = '🚧 ' + text;
    return p;
  }

  function renderEditorTab() {
    const wrap = document.createElement('div');
    const hotkeysBtn = document.createElement('button');
    hotkeysBtn.textContent = 'Tastenkürzel bearbeiten…';
    hotkeysBtn.addEventListener('click', () => onShowHotkeys && onShowHotkeys());
    wrap.appendChild(hotkeysBtn);
    wrap.appendChild(inertNote('Keybindings-Preset (Vim/Emacs), PDF-Viewer-Wahl, Code-Check, Breadcrumbs und die restlichen Editor-Toggles aus der Overleaf-Analyse sind noch nicht verdrahtet.'));
    return wrap;
  }

  function renderSpellingTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(
      selectField(
        'Spellcheck language',
        [
          { value: 'de', label: 'German' },
          { value: 'en', label: 'English' },
          { value: 'off', label: 'Aus' },
        ],
        spelling.lang === 'off' ? 'off' : spelling.lang,
        (value) => {
          spelling = { ...spelling, lang: value === 'off' ? 'de' : value, enabled: value !== 'off' };
          saveJson(SPELLING_KEY, spelling);
          editorMgr && editorMgr.setSpellcheck(spelling);
        }
      )
    );
    wrap.appendChild(inertNote('Eigenes Wörterbuch bearbeiten und "AI language suggestions" sind nicht umgesetzt - Rechtschreibprüfung läuft über die Browser-eigene Prüfung.'));
    return wrap;
  }

  function renderCompilerTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(
      selectField(
        'Compiler',
        [
          { value: 'pdflatex', label: 'pdfLaTeX' },
          { value: 'xelatex', label: 'XeLaTeX' },
          { value: 'lualatex', label: 'LuaLaTeX' },
        ],
        serverSettings.compiler,
        async (value) => {
          serverSettings = (await api.saveSettings({ compiler: value })).settings;
        }
      )
    );
    wrap.appendChild(
      selectField(
        'Kompilieren im geteilten Projekt',
        [
          { value: 'individual', label: 'Jeder kompiliert für sich (eigenes PDF)' },
          { value: 'group', label: 'Gruppen-Kompilieren (ein PDF für alle)' },
        ],
        serverSettings.compileMode || 'individual',
        async (value) => {
          serverSettings = (await api.saveSettings({ compileMode: value })).settings;
        }
      )
    );
    wrap.appendChild(
      checkboxField('Stop on first error', serverSettings.stopOnFirstError, async (checked) => {
        serverSettings = (await api.saveSettings({ stopOnFirstError: checked })).settings;
      })
    );
    wrap.appendChild(
      checkboxField('Autocompile (nach jedem Autosave neu kompilieren)', serverSettings.autocompile, async (checked) => {
        serverSettings = (await api.saveSettings({ autocompile: checked })).settings;
      })
    );
    wrap.appendChild(inertNote('TeX-Live-Version ist informativ (lokal installierte Distribution wird verwendet, keine Versionsauswahl).'));
    return wrap;
  }

  function renderReferencesTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(inertNote('Bibliography-Datei-Auswahl, Reference-Format (BibTeX/BibLaTeX) und Reference-Suche sind noch nicht umgesetzt (Backlog, siehe STATUS.md) - dafür müsste .bib-Parsing eingebaut werden.'));
    return wrap;
  }

  function renderAppearanceTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(
      selectField('Overall theme', [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], appearance.theme, (value) => {
        appearance = { ...appearance, theme: value };
        saveJson(APPEARANCE_KEY, appearance);
        applyTheme(value);
      })
    );
    wrap.appendChild(
      textField('Editor font size', appearance.fontSize, (value) => {
        appearance = { ...appearance, fontSize: value };
        saveJson(APPEARANCE_KEY, appearance);
        editorMgr && editorMgr.setFontSettings(appearance);
      })
    );
    wrap.appendChild(
      textField('Editor font family', appearance.fontFamily, (value) => {
        appearance = { ...appearance, fontFamily: value };
        saveJson(APPEARANCE_KEY, appearance);
        editorMgr && editorMgr.setFontSettings(appearance);
      })
    );
    wrap.appendChild(
      textField('Editor line height', appearance.lineHeight, (value) => {
        appearance = { ...appearance, lineHeight: value };
        saveJson(APPEARANCE_KEY, appearance);
        editorMgr && editorMgr.setFontSettings(appearance);
      })
    );
    wrap.appendChild(inertNote('"Editor-Theme" (Syntax-Farbschema) bleibt hell, unabhängig vom Overall-Theme - nur die umgebende Oberfläche wechselt auf Dark.'));
    return wrap;
  }


  // Desktop app only: folder of the local copy; the server moves the projects there.
  function renderLocalTab(info) {
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = info.localDir;
    const msg = document.createElement('p');
    const btn = document.createElement('button');
    btn.textContent = 'Ordner ändern und Projekte verschieben';
    btn.addEventListener('click', async () => {
      if (!confirm(`Alle lokalen Projekte nach
${input.value}
verschieben? Der alte Ordner bleibt danach leer. Der Zielordner muss leer oder neu sein.`)) return;
      btn.disabled = true;
      msg.textContent = 'Verschiebe…';
      const csrf = document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
      const r = await fetch('/api/desktop/local-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ? decodeURIComponent(csrf[1]) : '' },
        body: JSON.stringify({ dir: input.value }),
      }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      btn.disabled = false;
      if (r && r.ok) desktopInfo.localDir = d.localDir;
      msg.textContent = r && r.ok ?`Fertig: ${d.moved} Projekt(e) nach ${d.localDir} verschoben.` : `Fehler: ${d.error || 'Keine Antwort'}`;
    });
    wrap.appendChild(field('Ordner der lokalen Kopie', input));
    wrap.appendChild(btn);
    wrap.appendChild(msg);
    return wrap;
  }

  const TAB_RENDERERS = {
    editor: renderEditorTab,
    spelling: renderSpellingTab,
    compiler: renderCompilerTab,
    references: renderReferencesTab,
    appearance: renderAppearanceTab,
  };

  function render() {
    body.innerHTML = '';
    body.appendChild(activeTab === 'local' ? renderLocalTab(desktopInfo) : TAB_RENDERERS[activeTab]());
    for (const btn of tabsBar.querySelectorAll('.tab-btn')) {
      btn.classList.toggle('active', btn.dataset.settingsTab === activeTab);
    }
  }

  tabsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-settings-tab]');
    if (!btn) return;
    activeTab = btn.dataset.settingsTab;
    render();
  });

  btnClose.addEventListener('click', hide);

  return { show, hide, toggle, isOpen };
}
