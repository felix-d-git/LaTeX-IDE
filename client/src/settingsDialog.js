import { api, adminApi } from './api.js';

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

export function setupSettingsDialog({ editorMgr, onShowHotkeys, currentUser, onLogout } = {}) {
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

  function show() {
    modal.classList.remove('hidden');
    api.getSettings().then(({ settings }) => {
      serverSettings = settings;
      render();
    });
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

  function stubButton(label) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.disabled = true;
    return btn;
  }

  function stubRow(label, btn) {
    const row = document.createElement('div');
    row.className = 'settings-field settings-stub-row';
    const span = document.createElement('span');
    span.textContent = label;
    row.appendChild(span);
    row.appendChild(btn);
    return row;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString('de-DE');
  }

  function renderInviteList(container, invites, baseUrl, onRevoke) {
    container.innerHTML = '';
    if (invites.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings-inert-note';
      empty.textContent = 'Noch keine Einladungen erstellt.';
      container.appendChild(empty);
      return;
    }
    for (const invite of invites) {
      const row = document.createElement('div');
      row.className = 'invite-row' + (invite.usedByEmail ? ' used' : invite.expired ? ' expired' : '');
      const status = document.createElement('span');
      status.className = 'invite-status';
      if (invite.usedByEmail) status.textContent = `Verwendet von ${invite.usedByEmail} am ${formatDate(invite.usedAt || invite.createdAt)}`;
      else if (invite.expired) status.textContent = `Abgelaufen (erstellt ${formatDate(invite.createdAt)})`;
      else status.textContent = `Offen, gültig bis ${formatDate(invite.expiresAt)}`;
      row.appendChild(status);
      if (!invite.usedByEmail && !invite.expired) {
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Link kopieren';
        copyBtn.addEventListener('click', () => navigator.clipboard.writeText(`${baseUrl}/?invite=${invite.token}`));
        row.appendChild(copyBtn);
        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'danger';
        revokeBtn.textContent = 'Widerrufen';
        revokeBtn.addEventListener('click', () => onRevoke(invite.token));
        row.appendChild(revokeBtn);
      }
      container.appendChild(row);
    }
  }

  function renderAccountTab() {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = `Angemeldet als ${currentUser.email}${currentUser.isAdmin ? ' (Admin)' : ''}.`;
    wrap.appendChild(p);

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'danger';
    logoutBtn.textContent = 'Abmelden';
    logoutBtn.addEventListener('click', () => onLogout && onLogout());
    wrap.appendChild(logoutBtn);

    if (currentUser.isAdmin) {
      const inviteHeading = document.createElement('h4');
      inviteHeading.textContent = 'Einladungen (selbst registrieren lassen)';
      wrap.appendChild(inviteHeading);

      const inviteHint = document.createElement('p');
      inviteHint.className = 'settings-inert-note';
      inviteHint.textContent =
        'Neuer Link erzeugt eine Registrierungs-URL (7 Tage gültig, einmal verwendbar) - manuell an die Person schicken (WhatsApp/Mail/…), es wird nichts automatisch versendet.';
      wrap.appendChild(inviteHint);

      const createBtn = document.createElement('button');
      createBtn.className = 'primary';
      createBtn.textContent = '+ Neue Einladung erstellen';
      wrap.appendChild(createBtn);

      const list = document.createElement('div');
      list.id = 'invite-list';
      wrap.appendChild(list);

      async function refreshInvites() {
        const { invites, baseUrl } = await adminApi.listInvites();
        renderInviteList(list, invites, baseUrl, async (token) => {
          await adminApi.revokeInvite(token);
          refreshInvites();
        });
      }

      createBtn.addEventListener('click', async () => {
        const { url } = await adminApi.createInvite();
        await navigator.clipboard.writeText(url);
        alert('Einladungslink wurde in die Zwischenablage kopiert:\n' + url);
        refreshInvites();
      });

      refreshInvites();
    }

    const heading = document.createElement('h4');
    heading.textContent = 'Project synchronisation';
    wrap.appendChild(heading);
    wrap.appendChild(stubRow('Dropbox Sync', stubButton('Link')));
    wrap.appendChild(stubRow('GitHub Sync', stubButton('Link')));
    wrap.appendChild(stubRow('Git authentication token', stubButton('Generate token')));

    const heading2 = document.createElement('h4');
    heading2.textContent = 'Reference managers';
    wrap.appendChild(heading2);
    wrap.appendChild(stubRow('Zotero', stubButton('Link')));
    wrap.appendChild(stubRow('Mendeley', stubButton('Link')));

    const heading3 = document.createElement('h4');
    heading3.textContent = 'Linked accounts';
    wrap.appendChild(heading3);
    wrap.appendChild(stubRow('Google', stubButton('Log in with Google')));
    wrap.appendChild(stubRow('ORCID', stubButton('Link')));

    wrap.appendChild(
      inertNote(
        'Dropbox/GitHub/Zotero/Mendeley/ORCID sind weiterhin reine Vorschau-Platzhalter. Google-Login ist bewusst zurückgestellt, bis der Pi-Deploy mit Portweiterleitung/echter Domain steht (Google OAuth verlangt eine öffentlich erreichbare HTTPS-Redirect-URI) - siehe STATUS.md.'
      )
    );
    return wrap;
  }

  const TAB_RENDERERS = {
    editor: renderEditorTab,
    spelling: renderSpellingTab,
    compiler: renderCompilerTab,
    references: renderReferencesTab,
    appearance: renderAppearanceTab,
    account: renderAccountTab,
  };

  function render() {
    body.innerHTML = '';
    body.appendChild(TAB_RENDERERS[activeTab]());
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
