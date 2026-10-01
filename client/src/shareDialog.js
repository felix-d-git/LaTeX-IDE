import { shareApi } from './api.js';

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
        const input = document.createElement('input');
        input.readOnly = true;
        input.value = `${location.origin}/?join=${link.token}`;
        if (link.maxUses) input.title = `${link.uses} von ${link.maxUses} Beitritten genutzt`;
        input.addEventListener('focus', () => input.select());
        el.append(
          input,
          button('Kopieren', () => navigator.clipboard.writeText(input.value)),
          button('Deaktivieren', () => run(() => shareApi.revokeLink(role)))
        );
      } else {
        const max = document.createElement('input');
        max.type = 'number';
        max.min = '0';
        max.placeholder = 'max. Beitritte (leer = ∞)';
        max.className = 'share-link-max';
        el.append(max, button('Link erstellen', () => run(() => shareApi.createLink(role, max.value))));
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
