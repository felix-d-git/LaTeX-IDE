// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #163: Start-Schlüssel für Desktop-Proxy und LOCAL_MODE (?k= -> HttpOnly-Cookie, sonst 403, auch WebSocket).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { startServer } = require('./_server');

const REPO = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// Gemeinsame Prüfungen: ohne Cookie 403, falscher Schlüssel 403, ?k= setzt Cookie + leitet ohne k um, Cookie -> OK, WS.
async function checkKey({ base, port, key, apiPath, wsPath }) {
  const nokey = await fetch(base + apiPath);
  assert.strictEqual(nokey.status, 403, 'ohne Cookie');
  assert.strictEqual((await fetch(base + apiPath, { headers: { cookie: 'lideLocal=falsch' } })).status, 403, 'falsches Cookie');
  assert.strictEqual((await fetch(base + '/?k=falsch', { redirect: 'manual' })).status, 403, 'falscher Schlüssel');

  const r = await fetch(`${base}/?k=${key}&x=1`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/?x=1', 'k wird entfernt');
  const setCookie = r.headers.getSetCookie()[0];
  assert.match(setCookie, new RegExp(`^lideLocal=${key}; .*HttpOnly`));
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.strictEqual((await fetch(base + apiPath, { headers: { cookie } })).status, 200, 'mit Cookie');

  const open = (cookieHeader) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, { headers: { origin: base, ...(cookieHeader ? { cookie: cookieHeader } : {}) } });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', () => resolve('abgelehnt'));
      ws.on('unexpected-response', () => resolve('abgelehnt'));
    });
  assert.strictEqual(await open(null), 'abgelehnt', 'WebSocket ohne Cookie');
  return { open, cookie };
}

test('LOCAL_MODE: Start-Schlüssel nötig für API und /ws', async () => {
  const srv = await startServer({ LOCAL_MODE: '1', LOCAL_NO_BROWSER: '1' });
  try {
    const key = srv.localKey();
    assert.match(key, /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(srv.dataDir, '.launch-key')).mode & 0o777, 0o600);
    const { open, cookie } = await checkKey({ base: srv.base, port: srv.port, key, apiPath: '/api/auth/me', wsPath: '/ws' });
    assert.strictEqual(await open(cookie), 'open', 'WebSocket mit Cookie');
    assert.strictEqual((await fetch(srv.base + '/healthz')).status, 200, 'Healthcheck bleibt offen');
  } finally {
    await srv.stop();
  }
});

test('Desktop-Proxy: Start-Schlüssel nötig für alle Anfragen und /ws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-desk-key-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'lide_test' }));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), LATEX_IDE_DATA: data, LATEX_IDE_LOCAL: path.join(dir, 'local'), REMOTE_URL: `http://127.0.0.1:${await freePort()}`, LOCAL_NO_BROWSER: '1' };
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'desktop.js')], { env, stdio: 'ignore', windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try {
        await fetch(base + '/');
        break;
      } catch {
        if (i > 150 || child.exitCode !== null) throw new Error('Desktop startet nicht');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const key = fs.readFileSync(path.join(data, '.launch-key'), 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    // Zweite Anfrage ohne Cookie auf eine Desktop-Route: ebenfalls 403.
    assert.strictEqual((await fetch(base + '/api/desktop/info')).status, 403);
    await checkKey({ base, port, key, apiPath: '/api/desktop/info', wsPath: '/ws' });
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
