import { authApi } from './api.js';

function input(type, placeholder) {
  const el = document.createElement('input');
  el.type = type;
  el.placeholder = placeholder;
  el.autocomplete = type === 'password' ? 'current-password' : 'email';
  return el;
}

function button(label, onClick, primary) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (primary) btn.classList.add('primary');
  btn.addEventListener('click', onClick);
  return btn;
}

function linkRow(label, onClick) {
  const row = document.createElement('div');
  row.className = 'auth-link-row';
  row.appendChild(button(label, onClick, false));
  return row;
}

// Handles the logged-out state of the app: login, invite-gated
// self-registration, and the forgot/reset-password flow. Query params drive
// which form opens first (?invite=<token> from an admin-generated link,
// ?reset=<token> from a password-reset e-mail/console link).
export function setupAuthView({ onAuthenticated }) {
  const view = document.getElementById('auth-view');
  const appEl = document.getElementById('app');
  const title = document.getElementById('auth-title');
  const body = document.getElementById('auth-body');
  const errorEl = document.getElementById('auth-error');

  const params = new URLSearchParams(location.search);
  let mode = params.has('invite') ? 'register' : params.has('reset') ? 'reset' : 'login';
  const inviteToken = params.get('invite') || '';
  const resetToken = params.get('reset') || '';

  function setError(msg) {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  }

  function clearQueryParams() {
    window.history.replaceState({}, '', location.pathname);
  }

  function show() {
    view.classList.remove('hidden');
    appEl.classList.add('hidden');
    render();
  }

  function hide() {
    view.classList.add('hidden');
    appEl.classList.remove('hidden');
  }

  async function withErrorHandling(fn) {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
  }

  function renderLogin() {
    title.textContent = 'Anmelden';
    body.innerHTML = '';
    const email = input('email', 'E-Mail');
    const password = input('password', 'Passwort');
    const rememberRow = document.createElement('label');
    rememberRow.className = 'auth-checkbox-row';
    const rememberInput = document.createElement('input');
    rememberInput.type = 'checkbox';
    rememberInput.checked = true;
    rememberRow.append(rememberInput, document.createTextNode(' Angemeldet bleiben'));

    const submit = button(
      'Anmelden',
      () =>
        withErrorHandling(async () => {
          await authApi.login(email.value.trim(), password.value, rememberInput.checked);
          clearQueryParams();
          onAuthenticated();
        }),
      true
    );

    body.append(
      email,
      password,
      rememberRow,
      submit,
      linkRow('Passwort vergessen?', () => {
        mode = 'forgot';
        render();
      })
    );
  }

  function renderRegister() {
    title.textContent = 'Konto erstellen (per Einladungslink)';
    body.innerHTML = '';
    const email = input('email', 'E-Mail');
    const password = input('password', 'Passwort (mind. 8 Zeichen)');
    const passwordConfirm = input('password', 'Passwort wiederholen');

    const submit = button(
      'Konto erstellen',
      () =>
        withErrorHandling(async () => {
          if (password.value !== passwordConfirm.value) throw new Error('Passwörter stimmen nicht überein.');
          await authApi.register(inviteToken, email.value.trim(), password.value);
          clearQueryParams();
          onAuthenticated();
        }),
      true
    );

    body.append(
      email,
      password,
      passwordConfirm,
      submit,
      linkRow('Schon ein Konto? Anmelden', () => {
        mode = 'login';
        render();
      })
    );
  }

  function renderForgot() {
    title.textContent = 'Passwort vergessen';
    body.innerHTML = '';
    const email = input('email', 'E-Mail');
    const note = document.createElement('p');
    note.style.fontSize = '12.5px';
    note.style.color = '#5a6675';

    const submit = button(
      'Link anfordern',
      () =>
        withErrorHandling(async () => {
          const { message } = await authApi.forgotPassword(email.value.trim());
          note.textContent = message;
        }),
      true
    );

    body.append(
      email,
      submit,
      note,
      linkRow('Zurück zur Anmeldung', () => {
        mode = 'login';
        render();
      })
    );
  }

  function renderReset() {
    title.textContent = 'Neues Passwort vergeben';
    body.innerHTML = '';
    const password = input('password', 'Neues Passwort (mind. 8 Zeichen)');
    const passwordConfirm = input('password', 'Passwort wiederholen');

    const submit = button(
      'Passwort setzen',
      () =>
        withErrorHandling(async () => {
          if (password.value !== passwordConfirm.value) throw new Error('Passwörter stimmen nicht überein.');
          await authApi.resetPassword(resetToken, password.value);
          clearQueryParams();
          mode = 'login';
          setError('');
          render();
        }),
      true
    );

    body.append(password, passwordConfirm, submit);
  }

  const RENDERERS = { login: renderLogin, register: renderRegister, forgot: renderForgot, reset: renderReset };

  function render() {
    setError('');
    RENDERERS[mode]();
  }

  return { show, hide };
}
