// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #116: without ADMIN_PASSWORD the first admin gets a random one-time password in initial-admin-password.txt
// (never the old public fallback), and the account is locked to "change password" until that happened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { startServer, client } = require('./_server');

const FILE = 'initial-admin-password.txt';
const readPw = (dir) => fs.readFileSync(path.join(dir, FILE), 'utf8').trim();
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Answer of the /ws socket to a ping: 'pong' (accepted) or 'closed' (rejected).
function wsPing(base, c) {
  const cookie = Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (ws.terminate(), reject(new Error('ws: keine Antwort'))), 5000);
    const done = (v) => (clearTimeout(timer), ws.terminate(), resolve(v));
    ws.on('error', reject);
    ws.on('open', () => ws.send('{"type":"ping"}'));
    ws.on('message', (d) => String(d).includes('pong') && done('pong'));
    ws.on('close', () => done('closed'));
  });
}

test('ohne ADMIN_PASSWORD: Einmal-Passwort in der Datei, Konto bis zur Änderung gesperrt', async () => {
  const srv = await startServer({ ADMIN_PASSWORD: undefined });
  test.after(() => srv.stop());
  const file = path.join(srv.dataDir, FILE);
  const initial = readPw(srv.dataDir);
  assert.match(initial, /^[A-Za-z0-9_-]{16}$/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(srv.log().includes(file), 'Konsole nennt die Datei');
  assert.ok(!srv.log().includes(initial), 'Passwort selbst nie in der Konsole');

  const c = client(srv.base);
  await c.call('GET', '/api/auth/me');
  assert.strictEqual((await c.call('POST', '/api/auth/login', { login: 'admin', password: 'bitte-sofort-aendern' })).status, 401);
  await c.login('admin', initial);
  const me = await c.call('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.user.mustChangePassword, true);

  // Everything else is refused: projects, admin pages, desktop/MCP tokens, websockets.
  for (const [method, url] of [['GET', '/api/projects/list'], ['POST', '/api/projects/create'], ['GET', '/api/admin/users'], ['POST', '/api/admin/invites'], ['POST', '/api/auth/desktop-token'], ['POST', '/api/auth/mcp-token']]) {
    const r = await c.call(method, url, method === 'GET' ? undefined : { name: 'x', perms: ['read'] });
    assert.strictEqual(r.status, 403, `${method} ${url}`);
    assert.strictEqual(r.body.mustChangePassword, true, `${method} ${url}`);
  }
  assert.strictEqual(await wsPing(srv.base, c), 'closed');

  assert.strictEqual((await c.call('POST', '/api/auth/change-password', { currentPassword: 'falsch', newPassword: 'mein-neues-passwort' })).status, 400);
  assert.ok(fs.existsSync(file));
  const changed = await c.call('POST', '/api/auth/change-password', { currentPassword: initial, newPassword: 'mein-neues-passwort' });
  assert.strictEqual(changed.status, 200, changed.text);
  assert.ok(!fs.existsSync(file), 'Datei nach der Änderung gelöscht');

  // Same session goes on normally.
  assert.strictEqual((await c.call('GET', '/api/auth/me')).body.user.mustChangePassword, false);
  assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 200);
  assert.strictEqual((await c.call('POST', '/api/admin/invites')).status, 200);
  assert.strictEqual(await wsPing(srv.base, c), 'pong');
  const again = client(srv.base);
  await again.call('GET', '/api/auth/me');
  assert.strictEqual((await again.call('POST', '/api/auth/login', { login: 'admin', password: initial })).status, 401);
  await again.login('admin', 'mein-neues-passwort');
});

test('öffentliche Beispielpasswörter zählen als nicht gesetzt, fehlende Datei gibt beim Neustart ein neues', async () => {
  const dataDir = tmpDir('lide-initpw-');
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await startServer({ ADMIN_PASSWORD: 'bitte-ein-echtes-passwort-setzen', DATA_DIR: dataDir });
  const initial = readPw(dataDir);
  try {
    const c = client(first.base);
    await c.call('GET', '/api/auth/me');
    assert.strictEqual((await c.call('POST', '/api/auth/login', { login: 'admin', password: 'bitte-ein-echtes-passwort-setzen' })).status, 401);
    await c.login('admin', initial);
  } finally {
    await first.stop();
  }

  fs.rmSync(path.join(dataDir, FILE)); // admin threw the file away before changing the password
  const second = await startServer({ ADMIN_PASSWORD: undefined, DATA_DIR: dataDir });
  try {
    const fresh = readPw(dataDir);
    assert.notStrictEqual(fresh, initial);
    const c = client(second.base);
    await c.call('GET', '/api/auth/me');
    assert.strictEqual((await c.call('POST', '/api/auth/login', { login: 'admin', password: initial })).status, 401);
    await c.login('admin', fresh);
    assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 403);
  } finally {
    await second.stop();
  }
});

test('bestehender Admin mit dem alten Fallback-Passwort bekommt beim Update ein Einmal-Passwort', async () => {
  const dataDir = tmpDir('lide-initpw-alt-');
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bcrypt = require('bcryptjs');
  const admin = { id: 'a1', email: 'admin@local.host', username: 'admin', passwordHash: bcrypt.hashSync('bitte-sofort-aendern', 4), isAdmin: true, emailVerified: true, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, 'auth-data.json'), JSON.stringify({ users: [admin] }));
  const srv = await startServer({ DATA_DIR: dataDir });
  try {
    const initial = readPw(dataDir);
    const c = client(srv.base);
    await c.call('GET', '/api/auth/me');
    assert.strictEqual((await c.call('POST', '/api/auth/login', { login: 'admin', password: 'bitte-sofort-aendern' })).status, 401);
    await c.login('admin', initial);
    assert.strictEqual((await c.call('GET', '/api/auth/me')).body.user.mustChangePassword, true);
    assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 403);
  } finally {
    await srv.stop();
  }
});

test('mit Verschlüsselung liegt die Datei in VAULT_DIR (für den Host), nicht im tmpfs-DATA_DIR', async () => {
  const vaultDir = tmpDir('lide-initpw-vault-');
  test.after(() => fs.rmSync(vaultDir, { recursive: true, force: true }));
  const env = { ADMIN_PASSWORD: undefined, DATA_KEY: crypto.randomBytes(32).toString('hex'), VAULT_DIR: vaultDir };
  const first = await startServer(env);
  const initial = readPw(vaultDir);
  try {
    assert.ok(!fs.existsSync(path.join(first.dataDir, FILE)));
  } finally {
    await first.stop();
  }
  // Restart on an empty DATA_DIR: the vault restore skips the plaintext file, the account is still locked.
  const second = await startServer(env);
  try {
    assert.strictEqual(readPw(vaultDir), initial);
    const c = client(second.base);
    await c.login('admin', initial);
    assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 403);
    assert.strictEqual((await c.call('POST', '/api/auth/change-password', { currentPassword: initial, newPassword: 'mein-neues-passwort' })).status, 200);
    assert.ok(!fs.existsSync(path.join(vaultDir, FILE)));
    assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 200);
  } finally {
    await second.stop();
  }
});

test('lokaler Modus bleibt ohne Login und ohne Einmal-Passwort', async () => {
  const srv = await startServer({ LOCAL_MODE: '1', LOCAL_NO_BROWSER: '1' });
  test.after(() => srv.stop());
  const c = client(srv.base);
  const me = await c.call('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.user.localMode, true);
  assert.strictEqual(me.body.user.mustChangePassword, false);
  assert.strictEqual((await c.call('GET', '/api/projects/list')).status, 200);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, FILE)));
});
