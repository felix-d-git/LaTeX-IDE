import { shareApi } from './api.js';

// Owner adds/removes members by username or e-mail; a member can leave.
export function setupShareDialog({ currentUser, onLeft }) {
  const modal = document.getElementById('share-dialog');
  const btnOpen = document.getElementById('btn-share');
  const btnClose = document.getElementById('btn-close-share');
  const inviteRow = document.getElementById('share-invite-row');
  const loginInput = document.getElementById('share-login-input');
  const btnInvite = document.getElementById('btn-share-invite');
  const errorEl = document.getElementById('share-error');
  const list = document.getElementById('share-members-list');

  function setError(msg) {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  }

  function row(name, role, action) {
    const el = document.createElement('div');
    el.className = 'share-member';
    const n = document.createElement('span');
    n.textContent = name;
    const r = document.createElement('span');
    r.className = 'share-member-role';
    r.textContent = role;
    if (action) r.append(' ', action);
    el.append(n, r);
    return el;
  }

  function render(info) {
    inviteRow.classList.toggle('hidden', !info.canManage);
    list.innerHTML = '';
    const label = (u) => `${u.username}${u.id === currentUser.id ? ' (du)' : ''}`;
    if (info.owner) list.append(row(label(info.owner), 'Eigentümer'));
    for (const m of info.members) {
      let action = null;
      if (info.canManage || m.id === currentUser.id) {
        action = document.createElement('button');
        action.textContent = m.id === currentUser.id ? 'Verlassen' : 'Entfernen';
        action.addEventListener('click', () => remove(m));
      }
      list.append(row(label(m), 'Bearbeiten', action));
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
      const info = await shareApi.add(login);
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
