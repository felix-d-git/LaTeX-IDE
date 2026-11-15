// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #146: the reviewer write lock must not be bypassable by changing the case of the path
// (Express routes case-insensitively by default, the lock compared case-sensitively).
const test = require('node:test');
const assert = require('node:assert');
const { startServer, adminAndUser } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

test('#146: Kommentierender kann über abweichende Schreibweise keine Dateien anlegen', async () => {
  const { admin, user } = await adminAndUser(srv, 'kommentator');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Review' })).body;
  const projectId = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
  const pid = { 'X-Project-Id': projectId };
  assert.strictEqual((await admin.call('POST', '/api/share', { login: 'kommentator', role: 'reviewer' }, pid)).status, 200);

  const body = (name) => ({ dir: '', name, content: Buffer.from('x').toString('base64') });
  for (const url of ['/api/tree/upload', '/api/TREE/upload', '/API/tree/upload', '/api/Tree/Upload']) {
    const r = await user.call('POST', url, body(url.replace(/\W/g, '') + '.tex'), pid);
    assert.notStrictEqual(r.status, 200, `${url}: ${r.status} ${r.text}`);
  }
  const files = JSON.stringify((await admin.call('GET', '/api/tree', undefined, pid)).body);
  assert.doesNotMatch(files, /upload\.tex/i);
  // The owner still writes on the canonical path.
  assert.strictEqual((await admin.call('POST', '/api/tree/upload', body('ok.tex'), pid)).status, 200);
});
