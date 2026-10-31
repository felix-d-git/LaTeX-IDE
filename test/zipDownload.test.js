// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// ZIP download via archiver: project files are in it, build files are not, the archive is complete.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, client } = require('./_server');

test('ZIP-Download enthält Projektdateien, aber keine Build-Dateien', async () => {
  const srv = await startServer();
  test.after(() => srv.stop());
  const admin = client(srv.base);
  await admin.login('admin', 'bitte-sofort-aendern');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Zip' })).body;
  fs.mkdirSync(path.join(root, 'kap'));
  fs.writeFileSync(path.join(root, 'kap', 'eins.tex'), 'inhalt');
  fs.writeFileSync(path.join(root, 'main.aux'), 'weg');
  await admin.call('POST', '/api/projects/open', { root });

  const res = await fetch(`${srv.base}/api/download/zip`, { headers: { Cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.strictEqual(res.status, 200);
  const zip = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(zip.subarray(0, 2).toString(), 'PK');
  assert.ok(zip.includes('kap/eins.tex'));
  assert.ok(!zip.includes('main.aux'));
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'End-of-central-directory fehlt');
});
