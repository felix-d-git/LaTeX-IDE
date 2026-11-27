// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Einstellungen -> KI -> "Externe MCP-Server" (#126): Remote-HTTP-Server hinzufuegen, Werkzeugrechte, Config-Import.
// Tokens gehen nur zum Server und kommen nie zurueck (die API liefert nur Header-Namen).
const csrf = () => {
  const m = document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
};
async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': csrf() }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const PERM_LABELS = { ask: 'Immer fragen', allow: 'Erlauben', block: 'Blockieren' };

export function renderMcpClientSection() {
  const wrap = el('div');
  const msg = el('p', 'settings-note');
  const listBox = el('div');
  const say = (t) => (msg.textContent = t);

  const input = (placeholder, type = 'text') => Object.assign(el('input'), { type, placeholder, autocomplete: 'off' });
  const btn = (text, fn) => {
    const b = el('button', 'btn-secondary', text);
    b.type = 'button';
    b.addEventListener('click', () => fn().catch((e) => say(e.message)));
    return b;
  };

  async function load() {
    const { servers } = await call('GET', '/api/mcp-client/servers');
    listBox.replaceChildren(...servers.map(serverCard));
    if (!servers.length) listBox.appendChild(el('p', 'settings-note', 'Noch keine externen Server.'));
  }

  function serverCard(s) {
    const box = el('details', 'ai-tool');
    box.appendChild(el('summary', '', `${s.name} – ${s.status} – ${s.tools.length} Werkzeuge${s.enabled ? '' : ' (aus)'}`));
    box.appendChild(el('div', 'settings-note', `${s.url}${s.headerNames.length ? ' · gesetzt: ' + s.headerNames.join(', ') : ''}`));
    const on = Object.assign(el('input'), { type: 'checkbox', checked: s.enabled });
    on.addEventListener('change', () => call('PATCH', `/api/mcp-client/servers/${s.id}`, { enabled: on.checked }).then(load).catch((e) => say(e.message)));
    const onRow = el('label', 'settings-field settings-field-checkbox');
    onRow.append(on, el('span', '', 'Aktiv'));
    box.appendChild(onRow);
    for (const t of s.tools) {
      const row = el('div', 'settings-field');
      row.style.cssText = 'flex-direction:row;align-items:center;gap:8px';
      const sel = el('select');
      for (const [v, l] of Object.entries(PERM_LABELS)) sel.append(Object.assign(el('option'), { value: v, textContent: l, selected: v === t.perm }));
      sel.addEventListener('change', () => call('PATCH', `/api/mcp-client/servers/${s.id}`, { perms: { [t.name]: sel.value } }).catch((e) => say(e.message)));
      const label = el('span', '', `${s.ns}__${t.name}`);
      label.title = t.description;
      row.append(sel, label);
      box.appendChild(row);
    }
    box.append(
      btn('Werkzeuge neu laden', async () => (await call('POST', `/api/mcp-client/servers/${s.id}/refresh`), load())),
      btn('Entfernen', async () => (await call('DELETE', `/api/mcp-client/servers/${s.id}`), load()))
    );
    return box;
  }

  wrap.appendChild(el('h3', '', 'Externe MCP-Server'));
  wrap.appendChild(el('p', 'settings-note', 'Remote-Server per Streamable HTTP (z. B. Zotero, arXiv, eigene). Ihre Werkzeuge stehen dem KI-Assistenten zur Verfügung; Standard pro Werkzeug: „Immer fragen“. Die Verbindung läuft über den Server der IDE (nur öffentliche Adressen), Token werden dort gespeichert und nie wieder angezeigt. Antworten externer Server gelten als Fremddaten.'));
  wrap.appendChild(listBox);

  const name = input('Name (z. B. arxiv)');
  const url = input('https://…/mcp', 'url');
  const token = input('Bearer-Token (optional)', 'password');
  wrap.append(name, url, token, btn('Server hinzufügen', async () => {
    say('Verbinde …');
    const { server } = await call('POST', '/api/mcp-client/servers', { name: name.value.trim(), url: url.value.trim(), token: token.value.trim() });
    name.value = url.value = token.value = '';
    say(`${server.name}: ${server.status}`);
    await load();
  }));

  const cfg = Object.assign(el('textarea'), { rows: 4, placeholder: 'claude_desktop_config.json einfügen (nur URL-Einträge werden übernommen)' });
  const file = Object.assign(el('input'), { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    if (file.files[0]) cfg.value = await file.files[0].text();
  });
  wrap.append(cfg, file, btn('Config importieren', async () => {
    const r = await call('POST', '/api/mcp-client/import', { config: cfg.value });
    say(`${r.added.length} übernommen (alle Werkzeuge „Immer fragen“)` + (r.skipped.length ? `; übersprungen: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : '') + '.');
    cfg.value = '';
    await load();
  }));
  wrap.appendChild(msg);
  load().catch((e) => say(e.message));
  return wrap;
}
