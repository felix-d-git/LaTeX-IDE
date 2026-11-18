// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #178: dieselbe Einladung parallel eingeloest -> genau ein Konto.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, client, ADMIN_PASSWORD } = require('./_server');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('parallele Registrierung mit derselben Einladung: nur eine erfolgreich', async () => {
  const admin = client(srv.base);
  await admin.login('admin', ADMIN_PASSWORD);
  const { token } = (await admin.call('POST', '/api/admin/invites')).body;
  const rs = await Promise.all([1, 2, 3, 4].map(async (i) => {
    const c = client(srv.base);
    await c.call('GET', '/api/auth/me');
    return c.call('POST', '/api/auth/register', { token, username: `race${i}`, email: `race${i}@example.test`, password: 'geheim-passwort-123' });
  }));
  assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join());
  const users = (await admin.call('GET', '/api/admin/users')).text;
  assert.strictEqual((users.match(/race\d@example/g) || []).length, 1);
});

test('fehlgeschlagene Registrierung gibt die Einladung wieder frei', async () => {
  const admin = client(srv.base);
  await admin.login('admin', ADMIN_PASSWORD);
  const { token } = (await admin.call('POST', '/api/admin/invites')).body;
  const c = client(srv.base);
  await c.call('GET', '/api/auth/me');
  const bad = await c.call('POST', '/api/auth/register', { token, username: 'xuser1', email: 'xuser1@example.test', password: 'kurz' });
  assert.strictEqual(bad.status, 400);
  const ok = await c.call('POST', '/api/auth/register', { token, username: 'xuser1', email: 'xuser1@example.test', password: 'geheim-passwort-123' });
  assert.strictEqual(ok.status, 200, ok.text);
});

test('Einladungsliste enthaelt keinen Klartext-Token, Widerruf per id', async () => {
  const admin = client(srv.base);
  await admin.login('admin', ADMIN_PASSWORD);
  const { token } = (await admin.call('POST', '/api/admin/invites')).body;
  const list = await admin.call('GET', '/api/admin/invites');
  assert.ok(!list.text.includes(token));
  const id = list.body.invites[0].id;
  assert.strictEqual((await admin.call('DELETE', `/api/admin/invites/${id}`)).status, 200);
  const c = client(srv.base);
  await c.call('GET', '/api/auth/me');
  assert.strictEqual((await c.call('POST', '/api/auth/register', { token, username: 'rv', email: 'rv@example.test', password: 'geheim-passwort-123' })).status, 400);
});
