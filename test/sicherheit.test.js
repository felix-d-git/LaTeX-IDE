// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, client, ADMIN_PASSWORD } = require('./_server');

test('Mail-/Token-Routen sind nur im lokalen Modus gesperrt', async () => {
  const routes = ['verify', 'resend-verification', 'forgot-password', 'reset-password'];
  const local = await startServer({ LOCAL_MODE: '1', LOCAL_NO_BROWSER: '1' });
  try {
    const c = client(local.base);
    await c.call('GET', '/api/auth/me');
    for (const r of routes) assert.strictEqual((await c.call('POST', `/api/auth/${r}`, {})).status, 404, r);
  } finally {
    await local.stop();
  }
  const srv = await startServer();
  try {
    const c = client(srv.base);
    await c.call('GET', '/api/auth/me');
    assert.strictEqual((await c.call('POST', '/api/auth/forgot-password', { login: 'niemand' })).status, 200);

    // POST /mcp: ohne Token 401, nach dem Budget pro Minute 429.
    const post = () => fetch(srv.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lmcp_falsch' }, body: '{}' }).then((r) => r.status);
    assert.strictEqual(await post(), 401);
    for (let i = 0; i < 299; i++) await post();
    assert.strictEqual(await post(), 429);
  } finally {
    await srv.stop();
  }
});

// #152: Passwortwechsel und -Reset widerrufen Desktop- und MCP-Token.
test('Passwortwechsel/-Reset widerruft Desktop- und MCP-Token', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    await c.login('admin', ADMIN_PASSWORD);
    const tokens = async () => [
      (await c.call('POST', '/api/auth/desktop-token', { label: 'Test' })).body.token,
      (await c.call('POST', '/api/auth/mcp-token', { name: 'Test', perms: ['read'] })).body.token,
    ];
    const status = async ([desktop, mcp]) => [
      (await fetch(srv.base + '/api/auth/me', { headers: { Authorization: `Bearer ${desktop}` } })).status,
      (await fetch(srv.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${mcp}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status,
    ];

    let t = await tokens();
    assert.deepStrictEqual(await status(t), [200, 200]);
    assert.strictEqual((await c.call('POST', '/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'neues-passwort-456' })).status, 200);
    assert.deepStrictEqual(await status(t), [401, 401]);

    t = await tokens();
    assert.deepStrictEqual(await status(t), [200, 200]);
    assert.strictEqual((await c.call('POST', '/api/auth/forgot-password', { login: 'admin' })).status, 200);
    const outbox = fs.readFileSync(path.join(srv.dataDir, 'mail-outbox.log'), 'utf8');
    const reset = [...outbox.matchAll(/reset=([\w-]+)/g)].pop()[1];
    assert.strictEqual((await c.call('POST', '/api/auth/reset-password', { token: reset, password: 'drittes-passwort-789' })).status, 200);
    assert.deepStrictEqual(await status(t), [401, 401]);
  } finally {
    await srv.stop();
  }
});
