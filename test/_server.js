// Throwaway server for API tests: server/ + package.json copied to a temp dir (so the repo's
// .env is never loaded), node_modules via NODE_PATH, fresh DATA_DIR, free port. Not a *.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-api-'));
  fs.cpSync(path.join(REPO, 'server'), path.join(dir, 'server'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, LATEX_IDE_LOCAL: path.join(dir, 'local'), NODE_PATH: path.join(REPO, 'node_modules') };
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SMTP_HOST', 'DATA_KEY', 'VAULT_DIR', 'LOCAL_MODE', 'UPDATE_MODE', 'REMOTE_URL']) delete env[k];
  const child = spawn(process.execPath, [path.join(dir, 'server', 'index.js')], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error('Server beendet:\n' + log);
    try {
      await fetch(base + '/');
      break;
    } catch {
      if (i > 150) throw new Error('Server startet nicht:\n' + log);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, dataDir, port, stop, log: () => log };
}

// One logged-in browser-like client: cookie jar + CSRF header.
function client(base) {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'X-CSRF-Token': jar.csrfToken || '', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  }
  return {
    jar,
    call,
    async login(login, password) {
      await call('GET', '/api/auth/me');
      const r = await call('POST', '/api/auth/login', { login, password });
      if (r.status !== 200) throw new Error('Login fehlgeschlagen: ' + r.text);
      return r.body.user;
    },
  };
}

// Admin + a second verified user (invite -> register [-> verify link from the mail outbox]).
async function adminAndUser(srv, username = 'bob') {
  const admin = client(srv.base);
  await admin.login('admin', 'bitte-sofort-aendern');
  const { token } = (await admin.call('POST', '/api/admin/invites')).body;
  const user = client(srv.base);
  await user.call('GET', '/api/auth/me');
  const reg = await user.call('POST', '/api/auth/register', { token, username, email: `${username}@example.test`, password: 'geheim-passwort-123' });
  if (reg.status !== 200) throw new Error('Registrierung: ' + reg.text);
  // Without SMTP the server verifies invitees automatically (no mail); otherwise use the outbox link.
  if (reg.body.needsVerification) {
    const outbox = fs.readFileSync(path.join(srv.dataDir, 'mail-outbox.log'), 'utf8');
    const verify = [...outbox.matchAll(/verify=([\w-]+)/g)].pop()[1];
    await user.call('POST', '/api/auth/verify', { token: verify });
  }
  const u = await user.login(username, 'geheim-passwort-123');
  return { admin, user, userId: u.id };
}

module.exports = { startServer, client, adminAndUser };
