// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { api } from './api.js';
import { linkify } from './helpDialog.js';
import { renderMcpTab } from './mcpTab.js';
import { REFERENCES_KEY, referencePrefs } from './latexCompletions.js';
import { normalizeLtUrl, testLanguageTool } from './languageTool.js';

const APPEARANCE_KEY = 'latex-ide-appearance-v1';
const SPELLING_KEY = 'latex-ide-spelling-v1';
const EDITOR_KEY = 'latex-ide-editor-v1';

const DEFAULT_APPEARANCE = { theme: 'light', fontSize: '14.5px', fontFamily: '"Cascadia Code", Consolas, monospace', lineHeight: '1.5' };
const DEFAULT_SPELLING = { enabled: true, lang: 'de', grammar: false, dictionary: [] };
const DEFAULT_EDITOR = { keybindings: 'none', autocomplete: true, closeBrackets: true, codeCheck: true, pdfViewer: 'builtin', breadcrumbs: true };

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

export function setupSettingsDialog({ editorMgr, onShowHotkeys, onPdfViewer, onBreadcrumbs, onShowAccount } = {}) {
  const modal = document.getElementById('settings-dialog');
  const btnClose = document.getElementById('btn-close-settings');
  const tabsBar = document.getElementById('settings-tabs');
  const body = document.getElementById('settings-tab-body');

  let appearance = loadJson(APPEARANCE_KEY, DEFAULT_APPEARANCE);
  let spelling = loadJson(SPELLING_KEY, DEFAULT_SPELLING);
  let editorPrefs = loadJson(EDITOR_KEY, DEFAULT_EDITOR);
  let references = referencePrefs();
  let serverSettings = { compiler: 'pdflatex', stopOnFirstError: false, autocompile: false };
  let ltEnabled = null; // LANGUAGETOOL_URL auf dem Server gesetzt?
  let zotero = {};
  let bibFiles = [];
  let activeTab = 'editor';

  // Restore persisted, genuinely-applied preferences on startup, not just
  // when the dialog is opened - font/theme/spellcheck should survive reloads.
  applyTheme(appearance.theme);
  if (editorMgr) {
    editorMgr.setFontSettings(appearance);
    editorMgr.setSpellcheck(spelling);
  }
  applyEditorPrefs();
  onPdfViewer && onPdfViewer(editorPrefs.pdfViewer);
  onBreadcrumbs && onBreadcrumbs(editorPrefs.breadcrumbs);

  function applyEditorPrefs() {
    if (!editorMgr) return;
    editorMgr.setPrefs(
      { ...editorPrefs, dark: appearance.theme === 'dark', grammar: !!spelling.grammar, ltUrl: spelling.ltUrl || '', lang: spelling.lang, dictionary: spelling.dictionary || [] },
      {
        onAddWord: (word) => {
          spelling = { ...spelling, dictionary: [...new Set([...(spelling.dictionary || []), word])].sort() };
          saveJson(SPELLING_KEY, spelling);
          applyEditorPrefs();
          if (isOpen() && activeTab === 'spelling') render();
        },
      }
    );
  }

  function setEditorPref(key, value) {
    editorPrefs = { ...editorPrefs, [key]: value };
    saveJson(EDITOR_KEY, editorPrefs);
    applyEditorPrefs();
  }

  let desktopInfo = null;
  let mcpEl = null;
  function show() {
    mcpEl = null;
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
    api.languageToolStatus().then(({ enabled }) => {
      ltEnabled = enabled;
      render();
    }).catch(() => {});
    api.getZotero().then((z) => {
      zotero = z;
      render();
    }).catch(() => {});
    api.getTree().then(({ tree }) => {
      bibFiles = [];
      const walk = (nodes) => (nodes || []).forEach((n) => (n.type === 'dir' ? walk(n.children) : /\.bib$/i.test(n.path) && bibFiles.push(n.path)));
      walk(tree);
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

  function note(text) {
    const p = document.createElement('p');
    p.className = 'settings-note';
    p.textContent = text;
    return p;
  }

  function renderEditorTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(
      selectField(
        'Keybindings',
        [
          { value: 'none', label: 'Standard' },
          { value: 'vim', label: 'Vim' },
          { value: 'emacs', label: 'Emacs' },
        ],
        editorPrefs.keybindings,
        (v) => setEditorPref('keybindings', v)
      )
    );
    wrap.appendChild(
      selectField(
        'PDF-Viewer',
        [
          { value: 'builtin', label: 'Eingebaut (PDF.js, SyncTeX)' },
          { value: 'browser', label: 'Browser' },
        ],
        editorPrefs.pdfViewer,
        (v) => {
          setEditorPref('pdfViewer', v);
          onPdfViewer && onPdfViewer(v);
        }
      )
    );
    wrap.appendChild(checkboxField('Code-Check (Compile-Fehler im Gutter)', editorPrefs.codeCheck, (c) => setEditorPref('codeCheck', c)));
    wrap.appendChild(checkboxField('Auto-Vervollständigung', editorPrefs.autocomplete, (c) => setEditorPref('autocomplete', c)));
    wrap.appendChild(checkboxField('Klammern automatisch schließen', editorPrefs.closeBrackets, (c) => setEditorPref('closeBrackets', c)));
    wrap.appendChild(
      checkboxField('Breadcrumbs (Datei › Abschnitt)', editorPrefs.breadcrumbs, (c) => {
        setEditorPref('breadcrumbs', c);
        onBreadcrumbs && onBreadcrumbs(c);
      })
    );
    const hotkeysBtn = document.createElement('button');
    hotkeysBtn.textContent = 'Tastenkürzel bearbeiten…';
    hotkeysBtn.addEventListener('click', () => onShowHotkeys && onShowHotkeys());
    wrap.appendChild(hotkeysBtn);
    return wrap;
  }

  function renderSpellingTab() {
    const wrap = document.createElement('div');
    const saveSpelling = (patch) => {
      spelling = { ...spelling, ...patch };
      saveJson(SPELLING_KEY, spelling);
      editorMgr && editorMgr.setSpellcheck(spelling);
      applyEditorPrefs();
    };
    wrap.appendChild(
      selectField('Sprache', [{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'Englisch' }], spelling.lang, (v) => saveSpelling({ lang: v }))
    );
    wrap.appendChild(checkboxField('Rechtschreibprüfung des Browsers', spelling.enabled, (c) => saveSpelling({ enabled: c })));
    const noServerLt = ltEnabled === false && !spelling.ltUrl;
    const lt = checkboxField('Grammatik & Rechtschreibung (LanguageTool)', !!spelling.grammar && !noServerLt, (c) => saveSpelling({ grammar: c }));
    if (noServerLt) lt.querySelector('input').disabled = true;
    wrap.appendChild(lt);
    if (noServerLt) wrap.appendChild(note('Auf diesem Server ist kein LanguageTool eingerichtet (LANGUAGETOOL_URL in der .env). Alternativ unten die URL eines LanguageTool auf deinem eigenen Rechner eintragen.'));
    wrap.appendChild(textField('LanguageTool-URL (eigener Rechner)', spelling.ltUrl || '', (v) => {
      const ltUrl = normalizeLtUrl(v);
      // Wer eine Adresse einträgt, will die Prüfung auch an haben.
      saveSpelling(ltUrl && ltUrl !== spelling.ltUrl ? { ltUrl, grammar: true } : { ltUrl });
      render();
    }));
    const testRow = document.createElement('div');
    testRow.className = 'settings-field';
    testRow.style.cssText = 'flex-direction:row;align-items:center;gap:12px';
    const testBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn-secondary', textContent: 'Verbindung testen' });
    const testOut = document.createElement('span');
    testBtn.disabled = noServerLt;
    testBtn.addEventListener('click', async () => {
      testOut.textContent = 'Prüfe …';
      try {
        const n = await testLanguageTool(spelling.ltUrl || '', spelling.lang);
        testOut.textContent = n ? `LanguageTool antwortet (${spelling.ltUrl || 'Server'}), Testfehler erkannt.` : 'LanguageTool antwortet, hat den Testfehler aber nicht erkannt (Sprache installiert?).';
      } catch (e) {
        testOut.textContent = `Fehler: ${e.message}`;
      }
    });
    testRow.append(testBtn, testOut);
    wrap.appendChild(testRow);
    wrap.appendChild(note("Lokal starten: java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081 --allow-origin und hier http://localhost:8081 eintragen. Die Desktop-App spricht ihn über ihren Proxy an; im Web fragt der Browser direkt (--allow-origin nötig; Safari blockiert HTTPS→http, Chrome fragt ggf. nach Zugriff auf lokale Geräte)."));
    const dict = document.createElement('textarea');
    dict.rows = 6;
    dict.value = (spelling.dictionary || []).join('\n');
    dict.addEventListener('change', () => saveSpelling({ dictionary: [...new Set(dict.value.split(/\s+/).filter(Boolean))].sort() }));
    wrap.appendChild(field('Eigenes Wörterbuch (ein Wort pro Zeile; gilt für LanguageTool, die Browser-Prüfung führt ihr eigenes über das Kontextmenü)', dict));
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
          await saveServer({ compiler: value });
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
          await saveServer({ compileMode: value });
        }
      )
    );
    wrap.appendChild(
      checkboxField('Stop on first error', serverSettings.stopOnFirstError, async (checked) => {
        await saveServer({ stopOnFirstError: checked });
      })
    );
    wrap.appendChild(
      checkboxField('Autocompile (nach jedem Autosave neu kompilieren)', serverSettings.autocompile, async (checked) => {
        await saveServer({ autocompile: checked });
      })
    );
    return wrap;
  }

  // Fehler (z. B. Server weg) nicht verschlucken; Anzeige bleibt dann beim alten Stand
  async function saveServer(patch) {
    try {
      serverSettings = (await api.saveSettings(patch)).settings;
    } catch (e) {
      alert('Speichern fehlgeschlagen: ' + e.message);
      render();
    }
  }

  function renderReferencesTab() {
    const wrap = document.createElement('div');
    const saveRefs = (patch) => {
      references = { ...references, ...patch };
      saveJson(REFERENCES_KEY, references);
    };
    wrap.appendChild(
      selectField(
        'Literatursuche bei \\cite',
        [
          { value: 'advanced', label: 'Erweitert (Key, Titel, Autor)' },
          { value: 'simple', label: 'Einfach (nur Key)' },
        ],
        references.search,
        (v) => saveRefs({ search: v })
      )
    );
    wrap.appendChild(
      selectField('Format beim Zotero-Import', [{ value: 'bibtex', label: 'BibTeX' }, { value: 'biblatex', label: 'BibLaTeX' }], references.format, (v) => saveRefs({ format: v }))
    );
    if (bibFiles.length) {
      const box = document.createElement('div');
      box.className = 'settings-field';
      box.appendChild(Object.assign(document.createElement('span'), { textContent: 'Literaturdateien für \\cite (keine Auswahl = alle)' }));
      for (const f of bibFiles) {
        box.appendChild(
          checkboxField(f, references.bibFiles.includes(f), (c) =>
            saveRefs({ bibFiles: c ? [...references.bibFiles, f] : references.bibFiles.filter((x) => x !== f) })
          )
        );
      }
      wrap.appendChild(box);
    }
    const zType = document.createElement('select');
    for (const [v, l] of [['user', 'Eigene Bibliothek'], ['group', 'Gruppe']]) zType.appendChild(new Option(l, v, false, zotero.libraryType === v));
    const zId = Object.assign(document.createElement('input'), { type: 'text', value: zotero.libraryId || '', placeholder: 'Zahl, siehe zotero.org/settings/keys' });
    const zKey = Object.assign(document.createElement('input'), { type: 'password', placeholder: zotero.hasKey ? '•••• gespeichert' : 'nur für private Bibliotheken' });
    const zSave = Object.assign(document.createElement('button'), { textContent: 'Zotero-Zugang speichern' });
    const zMsg = note('');
    zSave.addEventListener('click', async () => {
      try {
        await api.saveZotero({ libraryType: zType.value, libraryId: zId.value.trim(), apiKey: zKey.value.trim() });
        zotero = await api.getZotero();
        zMsg.textContent = zotero.libraryId ? 'Gespeichert.' : 'Zotero-Zugang entfernt.';
        zKey.value = '';
      } catch (e) {
        zMsg.textContent = e.message;
      }
    });
    const zHelp = document.createElement('ol');
    zHelp.className = 'settings-note';
    for (const s of [
      '[zotero.org/settings/keys](https://www.zotero.org/settings/keys) öffnen ▸ „Create new private key“.',
      'Unter „Personal Library“ „Allow library access“ (Lesen) aktivieren, speichern, den Schlüssel kopieren und unten als API-Key einfügen.',
      'Library-ID = „Your userID for use in API calls“ auf der Keys-Seite. Bei Gruppen: Zahl aus der Gruppen-URL (zotero.org/groups/<ID>/…) und Bibliothek „Gruppe“.',
      'Speichern, dann Neue Datei ▸ References ▸ Zotero.',
    ]) zHelp.appendChild(linkify(document.createElement('li'), s));
    wrap.appendChild(zHelp);
    wrap.appendChild(note('Der API-Key wird auf dem Server gespeichert und nur für Abrufe bei api.zotero.org verwendet. Zotero ist eine Marke der Corporation for Digital Scholarship; dieses Projekt steht in keiner Verbindung dazu.'));
    wrap.appendChild(field('Zotero-Bibliothek', zType));
    wrap.appendChild(field('Zotero User-/Gruppen-ID (leer = Zugang löschen)', zId));
    wrap.appendChild(field('Zotero API-Key', zKey));
    wrap.appendChild(zSave);
    wrap.appendChild(zMsg);
    return wrap;
  }

  function renderAppearanceTab() {
    const wrap = document.createElement('div');
    wrap.appendChild(
      selectField('Overall theme', [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], appearance.theme, (value) => {
        appearance = { ...appearance, theme: value };
        saveJson(APPEARANCE_KEY, appearance);
        applyTheme(value);
        applyEditorPrefs();
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
      msg.textContent = r && r.ok ? `Fertig: ${d.moved} Projekt(e) nach ${d.localDir} verschoben.${d.warning ? ` ${d.warning}` : ''}` : `Fehler: ${d.error || 'Keine Antwort'}`;
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
    mcp: () => (mcpEl = mcpEl || renderMcpTab()), // kept while open, so a fresh token survives tab switches
  };

  function render() {
    body.innerHTML = '';
    body.appendChild(activeTab === 'local' ? renderLocalTab(desktopInfo) : TAB_RENDERERS[activeTab]());
    for (const btn of tabsBar.querySelectorAll('.tab-btn')) {
      btn.classList.toggle('active', btn.dataset.settingsTab === activeTab);
    }
  }

  tabsBar.addEventListener('click', (e) => {
    if (e.target.closest('[data-settings-link="account"]')) {
      hide();
      onShowAccount && onShowAccount();
      return;
    }
    const btn = e.target.closest('[data-settings-tab]');
    if (!btn) return;
    activeTab = btn.dataset.settingsTab;
    render();
  });

  btnClose.addEventListener('click', hide);

  return { show, hide, toggle, isOpen };
}
