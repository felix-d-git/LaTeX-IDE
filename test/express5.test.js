// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Express 5: a POST without a body must not end in a TypeError (500), and raw routes still get a Buffer.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, client } = require('./_server');

test('POST ohne Body gibt keinen 500 und Param-Routen gehen', async () => {
  const srv = await startServer();
  test.after(() => srv.stop());
  const admin = client(srv.base);
  await admin.login('admin', 'bitte-sofort-aendern');
  const noBody = await admin.call('POST', '/api/projects/create');
  assert.ok(noBody.status < 500, `Status ${noBody.status}`);
  const raw = await admin.call('POST', '/api/projects/upload-zip?name=x');
  assert.strictEqual(raw.status, 400);
  const param = await admin.call('DELETE', '/api/projects/trash/gibtsnicht');
  assert.ok(param.status < 500, `Status ${param.status}`);
});
