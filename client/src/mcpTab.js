import { authApi } from './api.js';

// Settings tab "MCP": tokens for external AI tools (Claude, Codex, Cursor) with single rights per project.
const DOCS_URL = 'https://github.com/felix-d-git/latex-web-ide/blob/multiuser/docs/MCP.md';
const PERMS = [
  ['read', 'Lesen'],
  ['comment', 'Kommentieren/Vorschlagen'],
  ['edit', 'Dateien bearbeiten'],
  ['create', 'Hochladen/Anlegen'],
  ['delete', 'Löschen'],
  ['move', 'Umbenennen/Verschieben'],
  ['compile', 'Kompilieren (dauert lange, belastet den Server stark)'],
];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const note = (text) => el('p', 'settings-inert-note', text);
const formatDate = (iso) => new Date(iso).toLocaleString('de-DE');

function copyField(value, label = 'Kopieren', multiline = false) {
  const row = el('div', 'mcp-copy');
  const input = el(multiline ? 'textarea' : 'input', 'settings-pw-input');
  input.readOnly = true;
  input.value = value;
  if (multiline) input.rows = 7;
  const btn = el('button', null, label);
  btn.addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      btn.textContent = 'Kopiert';
    } catch (e) {
      document.execCommand('copy');
    }
    setTimeout(() => (btn.textContent = label), 1500);
  });
  row.append(input, btn);
  return row;
}

// Prompt the user pastes into Claude Code / Codex so the agent sets up the connector itself.
function setupPrompt(token) {
  const url = `${location.origin}/mcp`;
  return `Richte den MCP-Server meiner LaTeX-Web-IDE als Connector ein (Streamable HTTP, Authentifizierung per Bearer-Token).

URL: ${url}
Header: Authorization: Bearer ${token}

Claude Code: führe aus
claude mcp add --transport http latex ${url} --header "Authorization: Bearer ${token}"

Codex: trage in ~/.codex/config.toml ein
[mcp_servers.latex]
url = "${url}"
http_headers = { Authorization = "Bearer ${token}" }

Danach: Sitzung neu starten und mit dem Werkzeug list_projects prüfen, ob die Verbindung steht. Beachte: compile ist teuer und läuft asynchron (Fortschritt mit compile_status), nur selten kompilieren.`;
}

// Rights editor: all projects with one set, or selected projects with their own. get() -> { perms, projects }.
function scopeEditor(initial, projectList) {
  const wrap = el('div', 'mcp-scope');
  const mode = el('select');
  for (const [v, t] of [['all', 'Alle Projekte'], ['sel', 'Ausgewählte Projekte']]) mode.appendChild(Object.assign(el('option', null, t), { value: v }));
  mode.value = initial.projects ? 'sel' : 'all';
  const body = el('div');
  const boxes = (state) => {
    const row = el('span', 'mcp-perms');
    for (const [p, t] of PERMS) {
      const l = el('label', 'mcp-perm');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = state.has(p);
      c.addEventListener('change', () => (c.checked ? state.add(p) : state.delete(p)));
      l.append(c, document.createTextNode(' ' + t));
      row.appendChild(l);
    }
    return row;
  };
  const allPerms = new Set(initial.perms || []);
  const selPerms = new Map(); // project id -> Set (only checked projects)
  for (const [id, l] of Object.entries(initial.projects || {})) selPerms.set(id, new Set(l));
  function draw() {
    body.innerHTML = '';
    if (mode.value === 'all') return body.appendChild(boxes(allPerms));
    // Tokens may still list projects that are gone or no longer reachable: keep them visible by id.
    const rows = [...projectList, ...[...selPerms.keys()].filter((id) => !projectList.some((p) => p.id === id)).map((id) => ({ id, name: id }))];
    if (!rows.length) body.appendChild(note('Keine Projekte vorhanden.'));
    for (const p of rows) {
      const row = el('div', 'mcp-project');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = selPerms.has(p.id);
      const perms = on.checked ? selPerms.get(p.id) : new Set(['read']);
      const detail = boxes(perms);
      detail.classList.toggle('hidden', !on.checked);
      on.addEventListener('change', () => {
        if (on.checked) selPerms.set(p.id, perms);
        else selPerms.delete(p.id);
        detail.classList.toggle('hidden', !on.checked);
      });
      const title = el('label', 'mcp-project-name');
      title.append(on, document.createTextNode(' ' + p.name + (p.shared ? ' (geteilt)' : '')));
      row.append(title, detail);
      body.appendChild(row);
    }
  }
  mode.addEventListener('change', draw);
  draw();
  wrap.append(mode, body);
  wrap.get = () => (mode.value === 'all' ? { perms: [...allPerms], projects: null } : { perms: [], projects: Object.fromEntries([...selPerms].map(([id, s]) => [id, [...s]])) });
  return wrap;
}

export function renderMcpTab() {
  const wrap = el('div', 'mcp-tab');
  const url = `${location.origin}/mcp`;
  wrap.append(
    el('h4', null, 'KI-Zugriff (MCP)'),
    note('Mit einem Token greifen externe KI-Tools (Claude Code/Desktop, Codex, Cursor) mit ihrem eigenen Abo auf deine Projekte zu. Du legst pro Token fest, was erlaubt ist – pro Projekt einzeln. Alles bleibt auf deinen eigenen Zugriff begrenzt.'),
    el('h4', null, 'Endpunkt'),
    copyField(url, 'URL kopieren'),
    note('Verbindung: HTTP (Streamable HTTP), Methode POST, Header „Authorization: Bearer <token>“ – den Token legst du unten an.')
  );
  const link = el('a', null, 'Dokumentation: Werkzeuge, Rechte, Compile-Hinweis ↗');
  link.href = DOCS_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  wrap.appendChild(el('p')).appendChild(link);

  const created = el('div');
  const list = el('div');
  const name = el('input', 'settings-pw-input');
  name.placeholder = 'Name (z. B. Claude Code)';
  const addBtn = el('button', 'primary', 'Token erstellen');
  const msg = note('');
  let projectList = [];
  let editor = scopeEditor({ perms: ['read'] }, projectList);
  const form = el('div');
  form.append(name, editor, addBtn, msg);
  wrap.append(el('h4', null, 'Neuer Token'), form, created, el('h4', null, 'Deine Tokens'), list);

  async function refresh() {
    list.innerHTML = '';
    try {
      const data = await authApi.listMcpTokens();
      const first = !projectList.length;
      projectList = data.projects;
      if (first) {
        editor.replaceWith((editor = scopeEditor({ perms: ['read'] }, projectList)));
      }
      if (!data.tokens.length) list.appendChild(note('Noch keine Tokens.'));
      for (const t of data.tokens) {
        const box = el('div', 'mcp-token');
        const ed = scopeEditor(t, projectList);
        const save = el('button', null, 'Rechte speichern');
        const revoke = el('button', 'danger', 'Widerrufen');
        const state = el('span', 'settings-inert-note');
        save.addEventListener('click', async () => {
          try {
            await authApi.updateMcpToken(t.id, ed.get());
            state.textContent = ' Gespeichert.';
          } catch (e) {
            state.textContent = ' ' + e.message;
          }
        });
        revoke.addEventListener('click', async () => {
          if (!confirm(`Token „${t.name}“ widerrufen? Verbundene Tools verlieren sofort den Zugriff.`)) return;
          await authApi.revokeMcpToken(t.id);
          refresh();
        });
        box.append(el('strong', null, t.name), note(`erstellt ${formatDate(t.createdAt)}${t.lastUsedAt ? `, zuletzt benutzt ${formatDate(t.lastUsedAt)}` : ''}`), ed, save, revoke, state);
        list.appendChild(box);
      }
    } catch (e) {
      list.appendChild(note(e.message));
    }
  }

  addBtn.addEventListener('click', async () => {
    msg.textContent = '';
    try {
      const { perms, projects } = editor.get();
      const { token } = await authApi.createMcpToken(name.value, perms, projects);
      name.value = '';
      created.innerHTML = '';
      created.append(
        el('strong', null, 'Token (jetzt kopieren, wird nicht erneut angezeigt):'),
        copyField(token, 'Token kopieren'),
        el('strong', null, 'Prompt für Claude Code / Codex (richtet den Connector selbst ein):'),
        copyField(setupPrompt(token), 'Prompt kopieren', true)
      );
      refresh();
    } catch (e) {
      msg.textContent = e.message;
    }
  });

  wrap.append(
    el('h4', null, 'Prompt-Vorlage'),
    note('Ohne frischen Token: Platzhalter <TOKEN> durch einen Token ersetzen.'),
    copyField(setupPrompt('<TOKEN>'), 'Prompt kopieren', true)
  );
  refresh();
  return wrap;
}
