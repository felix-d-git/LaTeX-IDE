import { adminApi, authApi } from './api.js';
import { copyText } from './clipboard.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const note = (text) => el('p', 'settings-inert-note', text);
const formatDate = (iso) => new Date(iso).toLocaleString('de-DE');

// Account things (logout, password, desktop apps, delete account) -
// separate from the editor settings, reachable from the rail and the dashboard.
export function setupProfileDialog({ currentUser, onLogout, onShowAdmin }) {
  const modal = document.getElementById('profile-dialog');
  const body = document.getElementById('profile-body');

  const pw = (placeholder, autocomplete) => {
    const i = el('input', 'settings-pw-input');
    i.type = 'password';
    i.placeholder = placeholder;
    i.autocomplete = autocomplete;
    return i;
  };

  function renderPasswordSection() {
    const box = el('div');
    const current = pw('Aktuelles Passwort', 'current-password');
    const next = pw('Neues Passwort (mind. 8 Zeichen)', 'new-password');
    const repeat = pw('Neues Passwort wiederholen', 'new-password');
    const msg = note('');
    const btn = el('button', 'primary', 'Passwort ändern');
    btn.addEventListener('click', async () => {
      msg.textContent = '';
      if (next.value !== repeat.value) return (msg.textContent = 'Neue Passwörter stimmen nicht überein.');
      try {
        await authApi.changePassword(current.value, next.value);
        current.value = next.value = repeat.value = '';
        msg.textContent = 'Passwort geändert. Alle anderen Sitzungen wurden abgemeldet.';
      } catch (e) {
        msg.textContent = e.message;
      }
    });
    box.append(el('h4', null, 'Passwort ändern'), current, next, repeat, btn, msg);
    return box;
  }

  // Desktop-app logins (API tokens). Revoking logs that app out immediately.
  function renderDesktopSection() {
    const box = el('div');
    const list = el('div');
    box.append(el('h4', null, 'Verbundene Desktop-Apps'), list);
    async function refresh() {
      list.innerHTML = '';
      try {
        const { tokens } = await authApi.listDesktopTokens();
        if (!tokens.length) return list.appendChild(note('Keine Desktop-App verbunden.'));
        for (const t of tokens) {
          const row = el('div', 'invite-row');
          const status = el('span', 'invite-status', `${t.label} – verbunden ${formatDate(t.createdAt)}${t.lastUsedAt ? `, zuletzt aktiv ${formatDate(t.lastUsedAt)}` : ''}`);
          const revoke = el('button', 'danger', 'Trennen');
          revoke.addEventListener('click', async () => {
            await authApi.revokeDesktopToken(t.id);
            refresh();
          });
          row.append(status, revoke);
          list.appendChild(row);
        }
      } catch (e) {
        list.appendChild(note(e.message));
      }
    }
    refresh();
    return box;
  }

  // Installers from this server's release, with this server's address built in.
  function renderDownloadSection() {
    const box = el('div');
    const list = el('div');
    // Gleiche Version wie dieser Server, also gilt sein Quellcode-Link auch für die Installer.
    const link = (text, href) => Object.assign(el('a', null, text), { href, target: '_blank', rel: 'noopener' });
    const legal = note('Freie Software (AGPL-3.0-only) · ');
    legal.append(link('Quellcode', '/source'), ' · ', link('Lizenzen', '/licenses'));
    box.append(el('h4', null, 'Desktop-App herunterladen'), list, legal);
    authApi.desktopRelease().then(
      (rel) => {
        const links = [['windows', 'Windows'], ['macos', 'macOS']].filter(([os]) => rel[os]);
        if (!links.length) return list.appendChild(note(`Für Version ${rel.version} ist noch kein Installationspaket verfügbar${rel.error ? ` (${rel.error})` : ''}.`));
        list.appendChild(note(`Version ${rel.version}, mit der Adresse dieses Servers. Der erste Download kann etwas dauern.`));
        for (const [os, label] of links) {
          const btn = el('button', 'primary', `${label} herunterladen`);
          btn.addEventListener('click', () => (location.href = `/api/desktop/download/${os}`));
          list.appendChild(btn);
        }
      },
      (e) => list.appendChild(note(e.message))
    );
    return box;
  }

  // Deletes the account plus every project in the user's own folder (server side).
  function renderDeleteSection() {
    const box = el('div');
    box.appendChild(el('h4', null, 'Konto löschen'));
    if (currentUser.isAdmin) {
      box.appendChild(note('Das Admin-Konto kann nicht gelöscht werden (es besitzt die Hauptprojekte).'));
      return box;
    }
    const password = pw('Passwort zur Bestätigung', 'current-password');
    const msg = note('');
    const btn = el('button', 'danger', 'Konto und alle eigenen Projekte endgültig löschen');
    btn.addEventListener('click', async () => {
      msg.textContent = '';
      if (!confirm('Konto, alle eigenen Projekte und Dateien endgültig löschen? Das lässt sich nicht rückgängig machen.')) return;
      try {
        await authApi.deleteAccount(password.value);
        location.reload();
      } catch (e) {
        msg.textContent = e.message;
      }
    });
    box.append(note('Löscht dein Konto und alle Projekte, die dir gehören. Für dich freigegebene Projekte anderer bleiben erhalten.'), password, btn, msg);
    return box;
  }

  function render() {
    body.innerHTML = '';
    // 100 % lokal: kein Konto, also nichts zum Abmelden/Einladen/Löschen.
    if (currentUser.localMode) return body.append(el('p', null, 'Lokaler Modus: nur dieser Rechner, ohne Anmeldung.'));
    body.appendChild(el('p', null, `Angemeldet als ${currentUser.username} (${currentUser.email})${currentUser.isAdmin ? ' – Admin' : ''}.`));
    const logoutBtn = el('button', 'danger', 'Abmelden');
    logoutBtn.addEventListener('click', () => onLogout && onLogout());
    body.appendChild(logoutBtn);
    body.appendChild(renderPasswordSection());
    body.appendChild(renderDownloadSection());
    body.appendChild(renderDesktopSection());
    if (currentUser.isAdmin) {
      const adminBtn = el('button', null, 'Server-Verwaltung (Nutzer, Einladungen, Update) …');
      adminBtn.addEventListener('click', () => { hide(); onShowAdmin(); });
      body.append(el('h4', null, 'Verwaltung'), adminBtn);
    }
    body.appendChild(renderDeleteSection());
  }

  const show = () => {
    render();
    modal.classList.remove('hidden');
  };
  const hide = () => modal.classList.add('hidden');
  const isOpen = () => !modal.classList.contains('hidden');
  document.getElementById('btn-close-profile').addEventListener('click', hide);
  modal.querySelector('.modal-backdrop').addEventListener('click', hide);
  return { show, hide, isOpen };
}

// Admin-only central page: server version/update, accounts, invite links.
export function setupAdminDialog({ currentUser, onUpdateRequested }) {
  const modal = document.getElementById('admin-dialog');
  const body = document.getElementById('admin-body');
  const MODES = {
    off: 'aus – keine Prüfung',
    notify: 'nur Hinweis – Installation per scripts/server-update.sh auf dem Server',
    button: 'per Button – Cron auf dem Server führt die Anforderung innerhalb einer Minute aus',
    auto: 'automatisch – Cron installiert nachts (mit Backup)',
  };
  const STATES = { running: 'läuft', done: 'fertig', failed: 'fehlgeschlagen' };

  function renderUpdateSection() {
    const box = el('div');
    box.appendChild(el('h4', null, 'Version & Update'));
    const info = note('Lade …');
    box.appendChild(info);
    adminApi.updateStatus().then((u) => {
      info.remove();
      const ver = (x) => String(x || '').replace(/^v/, '');
      const latest = u.error ? `nicht abrufbar (${u.error})` : u.version ? `${u.version}${u.available ? ' – Update verfügbar' : ' – aktuell'}` : '–';
      const dl = el('dl', 'admin-facts');
      for (const [k, v] of [['Installiert', u.current], ['Neueste', latest], ['Update-Modus', `${u.mode}: ${MODES[u.mode] || ''}`]]) dl.append(el('dt', null, k), el('dd', null, v));
      if (u.url) {
        const a = Object.assign(el('a', null, 'Release-Notizen'), { href: u.url, target: '_blank', rel: 'noopener' });
        const dd = el('dd');
        dd.appendChild(a);
        dl.append(el('dt'), dd);
      }
      const st = u.status;
      if (st) dl.append(el('dt', null, 'Letzter Lauf'), el('dd', null, `${STATES[st.state] || st.state}${st.to ? ` (${ver(st.from) || '?'} → ${ver(st.to)})` : ''}, ${formatDate(st.at)}`));
      box.appendChild(dl);
      if (st && st.log) {
        const log = el('details');
        log.append(el('summary', null, 'Protokoll des letzten Laufs'), el('pre', 'admin-log', st.log));
        box.appendChild(log);
      }
      // Changing the mode means changing the host cron line, so it stays in the server .env.
      box.appendChild(note('Modus ändern: UPDATE_MODE in der .env des Servers setzen und die passende Cron-Zeile aus scripts/server-update.sh eintragen, dann Container neu starten.'));
      const busy = u.requested || (st && st.state === 'running');
      if (u.mode === 'button' && u.available && !busy) {
        const btn = el('button', 'primary', `Jetzt auf ${u.version} aktualisieren`);
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try { await adminApi.requestUpdate(); } catch (e) { btn.disabled = false; return alert(e.message); }
          hide();
          onUpdateRequested();
        });
        box.appendChild(btn);
      } else if (busy) box.appendChild(note('Update läuft bzw. ist angefordert – Fortschritt im Banner oben.'));
    }).catch((e) => { info.textContent = e.message; });
    return box;
  }

  function renderUserSection() {
    const box = el('div');
    const list = el('div');
    list.id = 'admin-user-list';
    box.append(el('h4', null, 'Nutzer'), list);
    async function refresh() {
      const { users } = await adminApi.listUsers();
      list.innerHTML = '';
      for (const u of users) {
        const row = el('div', 'invite-row');
        row.appendChild(el('span', 'invite-status', `${u.username} (${u.email})${u.isAdmin ? ' – Admin' : ''}${u.verified ? '' : ' – E-Mail unbestätigt'}, seit ${formatDate(u.createdAt)}`));
        if (!u.isAdmin) {
          const del = el('button', 'danger', 'Löschen');
          del.addEventListener('click', async () => {
            if (!confirm(`Konto ${u.username} (${u.email}) mit allen eigenen Projekten endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
            try { await adminApi.deleteUser(u.id); } catch (e) { return alert(e.message); }
            refresh();
          });
          row.appendChild(del);
        }
        list.appendChild(row);
      }
    }
    refresh().catch((e) => list.appendChild(note(e.message)));
    return box;
  }

  function renderInviteSection() {
    const box = el('div');
    const createBtn = el('button', 'primary', '+ Neue Einladung erstellen');
    const list = el('div');
    list.id = 'invite-list';
    box.append(
      el('h4', null, 'Einladungen (selbst registrieren lassen)'),
      note('Neuer Link erzeugt eine Registrierungs-URL (7 Tage gültig, einmal verwendbar) - manuell an die Person schicken (WhatsApp/Mail/…), es wird nichts automatisch versendet.'),
      createBtn,
      list
    );
    async function refresh() {
      const { invites, baseUrl } = await adminApi.listInvites();
      list.innerHTML = '';
      if (!invites.length) return list.appendChild(note('Noch keine Einladungen erstellt.'));
      for (const invite of invites) {
        const row = el('div', 'invite-row' + (invite.usedByEmail ? ' used' : invite.expired ? ' expired' : ''));
        const text = invite.usedByEmail
          ? `Verwendet von ${invite.usedByEmail} am ${formatDate(invite.usedAt || invite.createdAt)}`
          : invite.expired
            ? `Abgelaufen (erstellt ${formatDate(invite.createdAt)})`
            : `Offen, gültig bis ${formatDate(invite.expiresAt)}`;
        row.appendChild(el('span', 'invite-status', text));
        if (!invite.usedByEmail && !invite.expired) {
          const copyBtn = el('button', null, 'Link kopieren');
          copyBtn.addEventListener('click', async () => {
            const link = `${baseUrl}/?invite=${invite.token}`;
            if (!(await copyText(link))) prompt('Einladungslink (zum Kopieren markieren):', link);
          });
          const revokeBtn = el('button', 'danger', 'Widerrufen');
          revokeBtn.addEventListener('click', async () => {
            await adminApi.revokeInvite(invite.token);
            refresh();
          });
          row.append(copyBtn, revokeBtn);
        }
        list.appendChild(row);
      }
    }
    createBtn.addEventListener('click', async () => {
      const { url } = await adminApi.createInvite();
      await navigator.clipboard.writeText(url);
      alert('Einladungslink wurde in die Zwischenablage kopiert:\n' + url);
      refresh();
    });
    refresh();
    return box;
  }

  function render() {
    body.innerHTML = '';
    body.append(renderUpdateSection(), renderUserSection(), renderInviteSection());
  }

  const show = () => {
    if (!currentUser.isAdmin || currentUser.localMode) return;
    render();
    modal.classList.remove('hidden');
  };
  const hide = () => modal.classList.add('hidden');
  document.getElementById('btn-close-admin').addEventListener('click', hide);
  modal.querySelector('.modal-backdrop').addEventListener('click', hide);
  const dashBtn = document.getElementById('btn-dash-admin');
  dashBtn.classList.toggle('hidden', !currentUser.isAdmin || !!currentUser.localMode);
  dashBtn.addEventListener('click', show);
  return { show, hide };
}
