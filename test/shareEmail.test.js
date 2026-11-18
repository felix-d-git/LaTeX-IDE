// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #170: E-Mail-Adressen nur für Verwalter sichtbar, Rate-Limit für Freigaben.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, adminAndUser } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

test('#170: Mitglied sieht nur eigene E-Mail, Verwalter alle; POST liefert Ziel-E-Mail nicht', async () => {
  const { admin, user } = await adminAndUser(srv, 'carol');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Mail' })).body;
  const pid = { 'X-Project-Id': (await admin.call('POST', '/api/projects/open', { root })).body.projectId };
  const add = await admin.call('POST', '/api/share', { login: 'carol', role: 'reviewer' }, pid);
  assert.strictEqual(add.status, 200);
  assert.ok(!JSON.stringify(add.body).includes('carol@example.test'));
  const mine = (await user.call('GET', '/api/share', undefined, pid)).body;
  assert.strictEqual(mine.owner.email, undefined);
  assert.strictEqual(mine.members[0].email, 'carol@example.test');
  const mgr = (await admin.call('GET', '/api/share', undefined, pid)).body;
  assert.strictEqual(mgr.members[0].email, 'carol@example.test');
});

test('#170: Rate-Limit nach 30 Fehlversuchen', async () => {
  const { admin } = await adminAndUser(srv, 'dave');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Limit' })).body;
  const pid = { 'X-Project-Id': (await admin.call('POST', '/api/projects/open', { root })).body.projectId };
  let last;
  for (let i = 0; i < 31; i++) last = await admin.call('POST', '/api/share', { login: 'nobody' + i, role: 'editor' }, pid);
  assert.strictEqual(last.status, 429);
});
