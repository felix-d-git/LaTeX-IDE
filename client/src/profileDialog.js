import { adminApi, authApi } from './api.js';

// Account things (logout, password, desktop apps, invites, delete account) -
// separate from the editor settings, reachable from the rail and the dashboard.
export function setupProfileDialog({ currentUser, onLogout }) {
  const modal = document.getElementById('profile-dialog');
  const body = document.getElementById('profile-body');

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const note = (text) => el('p', 'settings-inert-note', text);
  const formatDate = (iso) => new Date(iso).toLocaleString('de-DE');
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
          copyBtn.addEventListener('click', () => navigator.clipboard.writeText(`${baseUrl}/?invite=${invite.token}`));
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
    body.appendChild(el('p', null, `Angemeldet als ${currentUser.username} (${currentUser.email})${currentUser.isAdmin ? ' – Admin' : ''}.`));
    const logoutBtn = el('button', 'danger', 'Abmelden');
    logoutBtn.addEventListener('click', () => onLogout && onLogout());
    body.appendChild(logoutBtn);
    body.appendChild(renderPasswordSection());
    body.appendChild(renderDesktopSection());
    if (currentUser.isAdmin) body.appendChild(renderInviteSection());
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
