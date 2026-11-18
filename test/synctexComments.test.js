// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #184 (SyncTeX-Parameter, keine Pfade in Fehlern) und #185 (Kommentar-path/anchorText, reconcile).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, client, ADMIN_PASSWORD } = require('./_server');
const comments = require('../server/lib/comments');
const synctex = require('../server/lib/synctex');

test('synctex-Routen: ungültige Parameter -> 400 ohne Pfad', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', ADMIN_PASSWORD);
    const created = await admin.call('POST', '/api/projects/create', { name: 'sx' });
    await admin.call('POST', '/api/projects/open', { root: created.body.root });
    const urls = [
      '/api/synctex/forward?file=main.tex&line=1:2:/etc/x',
      '/api/synctex/forward?file=main.tex&line=-1',
      '/api/synctex/forward?file=main.tex&line=0',
      '/api/synctex/forward?file=main.tex&line=99999999999',
      '/api/synctex/inverse?page=1&x=-5&y=2',
      '/api/synctex/inverse?page=0&x=1&y=2',
      '/api/synctex/inverse?page=1&x=abc&y=2',
      '/api/synctex/inverse?page=1&x=1&y=Infinity',
    ];
    for (const u of urls) {
      const r = await admin.call('GET', u);
      assert.strictEqual(r.status, 400, u);
      assert.ok(!r.text.includes('projects'), u);
    }
  } finally { await srv.stop(); }
});

test('synctex: checkForward/checkInverse', () => {
  assert.doesNotThrow(() => synctex.checkForward('12'));
  assert.doesNotThrow(() => synctex.checkInverse('1', '10.5', '0'));
  assert.throws(() => synctex.checkForward('1:2'));
  assert.throws(() => synctex.checkInverse('1', '-1', '0'));
});

test('POST /api/comments: reservierte/ungültige path -> 400, gültiger -> 200', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', ADMIN_PASSWORD);
    const created = await admin.call('POST', '/api/projects/create', { name: 'cm' });
    await admin.call('POST', '/api/projects/open', { root: created.body.root });
    const post = (b) => admin.call('POST', '/api/comments', { from: 0, to: 1, text: 'x', ...b });
    for (const p of ['_orphaned', '__proto__', 'constructor', 'prototype', 'gibtsnicht.tex', 42, ['main.tex'], '../x.tex', 'main.png']) {
      assert.strictEqual((await post({ path: p })).status, 400, String(p));
    }
    assert.strictEqual((await post({ path: 'main.tex', anchorText: 5 })).status, 400);
    assert.strictEqual((await post({ path: 'main.tex', anchorText: 'a'.repeat(20001) })).status, 400);
    assert.strictEqual((await post({ path: 'main.tex', anchorText: 'ok' })).status, 200);
    assert.strictEqual((await admin.call('GET', '/api/comments')).status, 200);
  } finally { await srv.stop(); }
});

test('reconcile: Bucket mit falscher Form wirft nicht', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-'));
  try {
    fs.writeFileSync(path.join(root, 'a.tex'), 'hallo');
    for (const bad of [[{ id: '1', text: 'x' }], 'str', 5, { 'x.tex': 'kaputt', 'y.tex': { a: 1 } }]) {
      fs.writeFileSync(path.join(root, comments.COMMENTS_FILE), JSON.stringify({ [comments.ORPHANED]: bad, 'weg.tex': 'kaputt' }));
      assert.doesNotThrow(() => comments.listAll(root));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
