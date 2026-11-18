// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #156: interne .latex-ide-*-Pfade sind über die REST-Schreibrouten nicht erreichbar (kanonische Segmentprüfung).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, client, ADMIN_PASSWORD } = require('./_server');
const { assertUserPath } = require('../server/lib/fsTree');

test('#156: assertUserPath prüft jedes kanonische Segment', () => {
  const root = path.resolve('proj');
  for (const bad of ['x/../.latex-ide-comments.json', './.latex-ide-history/index.json', 'a/.latex-ide-yjs/b', '.git/config', 'a/.LaTeX-IDE-foo', '']) {
    assert.throws(() => assertUserPath(root, bad), bad);
  }
  assert.ok(assertUserPath(root, 'sub/../main.tex').endsWith('main.tex'));
  assert.strictEqual(assertUserPath(root, '', { allowRoot: true }), root);
});

test('#156: Routen weisen interne Pfade ab', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    await c.login('admin', ADMIN_PASSWORD);
    const { root } = (await c.call('POST', '/api/projects/create', { name: 'Intern' })).body;
    const projectId = (await c.call('POST', '/api/projects/open', { root })).body.projectId;
    const pid = { 'X-Project-Id': projectId };
    const marker = path.join(root, '.latex-ide-comments.json');
    fs.writeFileSync(marker, '[]');
    const b64 = Buffer.from('x').toString('base64');
    const bad = [
      ['POST', '/api/tree/upload', { dir: '', name: '.latex-ide-comments.json', content: b64, overwrite: true }],
      ['POST', '/api/tree/upload', { dir: '.latex-ide-history', name: 'a.txt', content: b64 }],
      ['POST', '/api/tree/file', { path: 'x/../.latex-ide-yjs/a' }],
      ['POST', '/api/tree/folder', { path: '.latex-ide-out' }],
      ['POST', '/api/tree/rename', { path: '.latex-ide-comments.json', newName: 'b.txt' }],
      ['POST', '/api/tree/move', { path: '.latex-ide-comments.json', targetDir: '' }],
    ];
    for (const [m, u, body] of bad) {
      const r = await c.call(m, u, body, pid);
      assert.notStrictEqual(r.status, 200, `${u} ${JSON.stringify(body)}: ${r.text}`);
    }
    assert.strictEqual((await c.call('DELETE', '/api/tree?path=x/../.latex-ide-comments.json', undefined, pid)).status === 200, false);
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), '[]');
    assert.ok(!fs.existsSync(path.join(root, '.latex-ide-yjs')) && !fs.existsSync(path.join(root, '.latex-ide-out')));
    // normale Dateien gehen weiter
    assert.strictEqual((await c.call('POST', '/api/tree/upload', { dir: '', name: 'ok.tex', content: b64 }, pid)).status, 200);
  } finally {
    await srv.stop();
  }
});
