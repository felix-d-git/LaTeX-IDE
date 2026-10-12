import { authApi } from './api.js';

function input(type, placeholder, autocomplete) {
  const el = document.createElement('input');
  el.type = type;
  el.placeholder = placeholder;
  el.autocomplete = autocomplete || (type === 'password' ? 'current-password' : 'email');
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

function note(text) {
  const p = document.createElement('p');
  p.className = 'auth-note';
  p.textContent = text || '';
  return p;
}

// Enter in any field submits the form's primary button.
function submitOnEnter(fields, btn) {
  for (const f of fields) f.addEventListener('keydown', (e) => e.key === 'Enter' && btn.click());
}

// Handles the logged-out state of the app: login, invite-gated
// self-registration with e-mail verification, forgot/reset password, and the
// desktop-app connect confirmation. Query params pick the first form:
// ?invite=<token> (admin link), ?verify=<token> (verification mail),
// ?reset=<token> (reset mail), ?desktop=<port>&state=<s> (desktop app login).
export function setupAuthView({ onAuthenticated }) {
  const view = document.getElementById('auth-view');
  const appEl = document.getElementById('app');
  const title = document.getElementById('auth-title');
  const body = document.getElementById('auth-body');
  const errorEl = document.getElementById('auth-error');

  // AGPL §13: source and licenses reachable without login.
  const link = (label, href) => Object.assign(document.createElement('a'), { textContent: label, href, target: '_blank', rel: 'noopener' });
  const legal = note('AGPL-3.0-only · ');
  legal.classList.add('auth-legal');
  legal.append(link('Quellcode', '/source'), ' · ', link('Lizenzen', '/licenses'));
  body.after(legal);

  const params = new URLSearchParams(location.search);
  let mode = params.has('invite') ? 'register' : params.has('reset') ? 'reset' : params.has('verify') ? 'verify' : 'login';
  const inviteToken = params.get('invite') || '';
  const resetToken = params.get('reset') || '';
  const verifyToken = params.get('verify') || '';
  const desktopPort = /^\d{2,5}$/.test(params.get('desktop') || '') ? params.get('desktop') : null;
  const desktopState = params.get('state') || '';
  let info = ''; // message shown above the login form (e.g. after verifying)
  let lastLogin = '';

  function setError(msg) {
    errorEl.textContent = msg || '';
    errorEl.classList.toggle('hidden', !msg);
  }

  // Desktop login must survive the login round-trip, everything else is one-shot.
  function clearQueryParams() {
    const keep = desktopPort ? `?desktop=${desktopPort}&state=${encodeURIComponent(desktopState)}` : '';
    window.history.replaceState({}, '', location.pathname + keep);
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
      return e;
    }
  }

  function go(m) {
    mode = m;
    render();
  }

  function renderLogin() {
    title.textContent = desktopPort ? 'Anmelden – Desktop-App verbinden' : 'Anmelden';
    const login = input('text', 'Benutzername oder E-Mail', 'username');
    login.value = lastLogin;
    const password = input('password', 'Passwort');
    const rememberRow = document.createElement('label');
    rememberRow.className = 'auth-checkbox-row';
    const rememberInput = document.createElement('input');
    rememberInput.type = 'checkbox';
    rememberInput.checked = true;
    rememberRow.append(rememberInput, document.createTextNode(' Angemeldet bleiben'));
    const resendBox = document.createElement('div');

    const submit = button(
      'Anmelden',
      async () => {
        lastLogin = login.value.trim();
        resendBox.innerHTML = '';
        const err = await withErrorHandling(async () => {
          await authApi.login(lastLogin, password.value, rememberInput.checked);
          clearQueryParams();
          onAuthenticated();
        });
        if (err && err.data && err.data.unverified) {
          const msg = note();
          resendBox.append(
            button('Bestätigungsmail erneut senden', () =>
              withErrorHandling(async () => {
                msg.textContent = (await authApi.resendVerification(lastLogin)).message;
              })
            ),
            msg
          );
        }
      },
      true
    );
    submitOnEnter([login, password], submit);

    if (info) body.append(note(info));
    body.append(login, password, rememberRow, submit, resendBox, linkRow('Passwort vergessen?', () => go('forgot')));
    info = '';
  }

  function renderRegister() {
    title.textContent = 'Konto erstellen (per Einladungslink)';
    const username = input('text', 'Benutzername (3–32 Zeichen)', 'username');
    const email = input('email', 'E-Mail');
    const password = input('password', 'Passwort (mind. 8 Zeichen)', 'new-password');
    const passwordConfirm = input('password', 'Passwort wiederholen', 'new-password');

    const submit = button(
      'Konto erstellen',
      () =>
        withErrorHandling(async () => {
          if (!inviteToken) throw new Error('Registrierung nur mit Einladungslink möglich.');
          if (password.value !== passwordConfirm.value) throw new Error('Passwörter stimmen nicht überein.');
          const { message } = await authApi.register(inviteToken, username.value.trim(), email.value.trim(), password.value);
          clearQueryParams();
          title.textContent = 'Bitte E-Mail bestätigen';
          body.innerHTML = '';
          body.append(note(`${message} Erst nach dem Klick auf den Link darin kannst du dich anmelden.`), linkRow('Zur Anmeldung', () => go('login')));
        }),
      true
    );
    submitOnEnter([username, email, password, passwordConfirm], submit);

    body.append(username, email, password, passwordConfirm, submit, linkRow('Schon ein Konto? Anmelden', () => go('login')));
  }

  function renderVerify() {
    title.textContent = 'E-Mail-Adresse bestätigen';
    const msg = note('Wird bestätigt …');
    body.append(msg);
    withErrorHandling(async () => {
      const { message } = await authApi.verify(verifyToken);
      clearQueryParams();
      info = message;
      go('login');
    }).then((err) => {
      if (!err) return;
      msg.textContent = '';
      clearQueryParams();
      body.append(linkRow('Zur Anmeldung', () => go('login')));
    });
  }

  function renderForgot() {
    title.textContent = 'Passwort vergessen';
    const login = input('text', 'Benutzername oder E-Mail', 'username');
    login.value = lastLogin;
    const msg = note();

    const submit = button(
      'Link anfordern',
      () =>
        withErrorHandling(async () => {
          msg.textContent = (await authApi.forgotPassword(login.value.trim())).message;
        }),
      true
    );
    submitOnEnter([login], submit);

    body.append(login, submit, msg, linkRow('Zurück zur Anmeldung', () => go('login')));
  }

  function renderReset() {
    title.textContent = 'Neues Passwort vergeben';
    const password = input('password', 'Neues Passwort (mind. 8 Zeichen)', 'new-password');
    const passwordConfirm = input('password', 'Passwort wiederholen', 'new-password');

    const submit = button(
      'Passwort setzen',
      () =>
        withErrorHandling(async () => {
          if (password.value !== passwordConfirm.value) throw new Error('Passwörter stimmen nicht überein.');
          await authApi.resetPassword(resetToken, password.value);
          clearQueryParams();
          info = 'Passwort geändert. Alle anderen Sitzungen wurden abgemeldet.';
          go('login');
        }),
      true
    );
    submitOnEnter([password, passwordConfirm], submit);

    body.append(password, passwordConfirm, submit);
  }

  const RENDERERS = { login: renderLogin, register: renderRegister, forgot: renderForgot, reset: renderReset, verify: renderVerify };

  function render() {
    setError('');
    body.innerHTML = '';
    RENDERERS[mode]();
  }

  // Logged in and the desktop app asked for a token: confirm, then hand the
  // token to the app's local callback (only ever localhost - never a remote host; same origin as the app so it shares the offline cache).
  function showDesktopConnect(user) {
    if (!desktopPort) return false;
    view.classList.remove('hidden');
    appEl.classList.add('hidden');
    setError('');
    body.innerHTML = '';
    title.textContent = 'Desktop-App verbinden';
    const cancel = () => {
      window.history.replaceState({}, '', location.pathname);
      location.reload();
    };
    body.append(
      note(
        `Die LaTeX-IDE-Desktop-App auf diesem Rechner (Port ${desktopPort}) möchte sich mit deinem Konto „${user.username}“ verbinden. ` +
          'Sie darf dann in deinem Namen Projekte öffnen und bearbeiten. Verbindungen kannst du jederzeit in den Einstellungen widerrufen.'
      ),
      button(
        'Verbinden',
        () =>
          withErrorHandling(async () => {
            const label = `Desktop-App (${navigator.platform || 'Rechner'}, ${new Date().toLocaleDateString('de-DE')})`;
            const { token } = await authApi.createDesktopToken(label);
            location.href = `http://localhost:${desktopPort}/desktop-callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(desktopState)}`;
          }),
        true
      ),
      linkRow('Abbrechen', cancel)
    );
    return true;
  }

  return { show, hide, showDesktopConnect };
}
