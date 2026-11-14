// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { authApi } from './api.js';

// "Passwort ändern" (current + new twice): in the profile and as the forced step after the first login
// with the generated one-time admin password. onChanged(msg) runs once the server took the new password;
// onError (optional) shows errors elsewhere instead of in the form's own message line.
export function createPasswordForm({ inputClass = '', noteClass = '', onChanged, onError }) {
  const pw = (placeholder, autocomplete) => {
    const i = document.createElement('input');
    if (inputClass) i.className = inputClass;
    i.type = 'password';
    i.placeholder = placeholder;
    i.autocomplete = autocomplete;
    return i;
  };
  const current = pw('Aktuelles Passwort', 'current-password');
  const next = pw('Neues Passwort (mind. 8 Zeichen)', 'new-password');
  const repeat = pw('Neues Passwort wiederholen', 'new-password');
  const msg = document.createElement('p');
  if (noteClass) msg.className = noteClass;
  const show = (text) => (onError ? onError(text) : (msg.textContent = text));
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Passwort ändern';
  btn.addEventListener('click', async () => {
    msg.textContent = '';
    show('');
    if (next.value !== repeat.value) return show('Neue Passwörter stimmen nicht überein.');
    try {
      await authApi.changePassword(current.value, next.value);
      current.value = next.value = repeat.value = '';
      onChanged(msg);
    } catch (e) {
      show(e.message);
    }
  });
  for (const f of [current, next, repeat]) f.addEventListener('keydown', (e) => e.key === 'Enter' && btn.click());
  return { current, nodes: [current, next, repeat, btn, msg] };
}
