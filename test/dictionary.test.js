// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Personal dictionary belongs to the account: saved per user, invalid input rejected.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, adminAndUser } = require('./_server');

test('Wörterbuch wird pro Konto gespeichert und geprüft', async () => {
  const srv = await startServer();
  test.after(() => srv.stop());
  const { admin, user } = await adminAndUser(srv);

  assert.strictEqual((await admin.call('POST', '/api/dictionary', { words: ['zwei', 'eins', 'zwei'] })).status, 200);
  assert.deepStrictEqual((await admin.call('GET', '/api/dictionary')).body.words, ['eins', 'zwei']);
  assert.deepStrictEqual((await user.call('GET', '/api/dictionary')).body.words, []);

  for (const words of ['x', ['zwei worte'], [1], ['a'.repeat(101)]]) {
    assert.strictEqual((await admin.call('POST', '/api/dictionary', { words })).status, 400);
  }
  assert.deepStrictEqual((await admin.call('GET', '/api/dictionary')).body.words, ['eins', 'zwei']);
});
