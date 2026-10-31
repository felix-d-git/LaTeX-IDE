// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const { startServer, client } = require('./_server');

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
