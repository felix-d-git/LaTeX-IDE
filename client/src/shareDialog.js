// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { publicOrigin, shareApi } from './api.js';
import { copyText } from './clipboard.js';

const ROLE_LABEL = { editor: 'Kann bearbeiten', reviewer: 'Kann kommentieren' };

// Owner adds members (by username/e-mail or share link) with a role and can
// change or remove them; a member can leave.
export function setupShareDialog({ currentUser, onLeft }) {
  const modal = document.getElementById('share-dialog');
  const btnOpen = document.getElementById('btn-share');
  const btnClose = document.getElementById('btn-close-share');
  const inviteRow = document.getElementById('share-invite-row');
  const loginInput = document.getElementById('share-login-input');
  const roleSelect = document.getElementById('share-role-select');
  const btnInvite = document.getElementById('btn-share-invite');
  const linksEl = document.getElementById('share-links');
  const errorEl = document.getElementById('share-error');
  const list = document.getElementById('share-members-list');

  function setError(msg) {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  }

  function button(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function row(name, role, ...actions) {
    const el = document.createElement('div');
    el.className = 'share-member';
    const n = document.createElement('span');
    n.textContent = name;
    const r = document.createElement('span');
    r.className = 'share-member-role';
    r.append(role, ...actions.flatMap((a) => (a ? [' ', a] : [])));
    el.append(n, r);
    return el;
  }

  function roleControl(m) {
    const sel = document.createElement('select');
    for (const [value, label] of Object.entries(ROLE_LABEL)) sel.add(new Option(label, value, false, m.role === value));
    sel.addEventListener('change', () => run(() => shareApi.setRole(m.id, sel.value)));
    return sel;
  }

  const freshLinks = {}; // role -> plaintext token, only from the create response

  function renderLinks(links) {
    linksEl.innerHTML = '';
    for (const [role, label] of Object.entries(ROLE_LABEL)) {
      const el = document.createElement('div');
      el.className = 'share-link';
      const name = document.createElement('span');
      name.textContent = `Link: ${label}`;
      el.append(name);
      const link = links[role];
      if (link) {
        // #182: the server only stores a hash; the link is visible right after creation (this dialog session) only.
        const input = document.createElement('input');
        input.readOnly = true;
        const url = freshLinks[role] && `${publicOrigin()}/?join=${freshLinks[role]}`;
        input.value = url || 'Link nur bei Erstellung sichtbar – zum neuen Link deaktivieren und neu erstellen';
        const tip = [link.maxUses && `${link.uses} von ${link.maxUses} Beitritten genutzt`, link.expiresAt && `gültig bis ${new Date(link.expiresAt).toLocaleString()}`].filter(Boolean).join(', ');
        if (tip) input.title = tip;
        input.addEventListener('focus', () => input.select());
        el.append(input);
        if (url) el.append(button('Kopieren', () => copyText(url)));
        el.append(button('Deaktivieren', () => { delete freshLinks[role]; run(() => shareApi.revokeLink(role)); }));
      } else {
        const max = document.createElement('input');
        max.type = 'number';
        max.min = '0';
        max.placeholder = 'max. Beitritte (leer = ∞)';
        max.className = 'share-link-max';
        const days = document.createElement('input');
        days.type = 'number';
        days.min = '0';
        days.placeholder = 'Ablauf in Tagen (leer = nie)';
        days.className = 'share-link-max';
        el.append(max, days, button('Link erstellen', () => run(async () => {
          const info = await shareApi.createLink(role, max.value, days.value);
          if (info.newLink) freshLinks[info.newLink.role] = info.newLink.token;
          return info;
        })));
      }
      linksEl.append(el);
    }
  }

  function render(info) {
    inviteRow.classList.toggle('hidden', !info.canManage);
    linksEl.classList.toggle('hidden', !info.canManage);
    if (info.canManage) renderLinks(info.links || {});
    list.innerHTML = '';
    const label = (u) => `${u.username}${u.id === currentUser.id ? ' (du)' : ''}`;
    if (info.owner) list.append(row(label(info.owner), 'Eigentümer'));
    for (const m of info.members) {
      if (info.canManage) {
        list.append(row(label(m), '', roleControl(m), button('Entfernen', () => remove(m))));
      } else {
        list.append(row(label(m), ROLE_LABEL[m.role] || m.role, m.id === currentUser.id ? button('Verlassen', () => remove(m)) : null));
      }
    }
  }

  async function run(fn) {
    setError('');
    try {
      render(await fn());
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(m) {
    if (m.id === currentUser.id) {
      if (!confirm('Projekt verlassen? Du verlierst den Zugriff.')) return;
      try {
        await shareApi.remove(m.id);
        hide();
        onLeft();
      } catch (e) {
        setError(e.message);
      }
      return;
    }
    run(() => shareApi.remove(m.id));
  }

  function invite() {
    const login = loginInput.value.trim();
    if (!login) return;
    run(async () => {
      const info = await shareApi.add(login, roleSelect.value);
      loginInput.value = '';
      return info;
    });
  }

  function show() {
    modal.classList.remove('hidden');
    list.innerHTML = '';
    run(() => shareApi.get());
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

  btnOpen.addEventListener('click', show);
  btnClose.addEventListener('click', hide);
  btnInvite.addEventListener('click', invite);
  loginInput.addEventListener('keydown', (e) => e.key === 'Enter' && invite());

  return { show, hide, toggle, isOpen };
}
