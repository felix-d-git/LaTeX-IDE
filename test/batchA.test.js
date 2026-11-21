// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #188 compile rights re-checked at job start, #183 no internals in 500 answers, #186 compiler allowlist.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { texCommand } = require('../server/lib/compile');
const { startServer, adminAndUser } = require('./_server');

const hasTex = spawnSync('latexmk', ['-v'], { windowsHide: true }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#186 texCommand: geerbte Object-Keys fallen auf pdflatex zurück', () => {
  const flag = (compiler) => texCommand('main.tex', { compiler }, 'out')[1].find((a) => /^-(pdf|xelatex|lualatex)$/.test(a));
  assert.strictEqual(flag('constructor'), '-pdf');
  assert.strictEqual(flag('xelatex'), '-xelatex');
});

test('#186 /api/settings: nur bekannte Compiler; #183 500 ohne Interna', async () => {
  const srv = await startServer();
  test.after(() => srv.stop());
  const { admin } = await adminAndUser(srv);
  const root = (await admin.call('POST', '/api/projects/create', { name: 'Eins' })).body.root;
  await admin.call('POST', '/api/projects/open', { root });
  for (const compiler of ['constructor', {}, 'x'.repeat(100000), 5]) {
    assert.strictEqual((await admin.call('POST', '/api/settings', { compiler })).status, 400);
  }
  assert.strictEqual((await admin.call('GET', '/api/settings')).body.settings.compiler, 'pdflatex');
  const ok = await admin.call('POST', '/api/settings', { compiler: 'xelatex' });
  assert.strictEqual(ok.body.settings.compiler, 'xelatex');
  // A non-string name throws a TypeError inside the handler: client gets only a reference id.
  const r = await admin.call('POST', '/api/projects/rename', { oldName: 5, newName: 'x' });
  assert.strictEqual(r.status, 500);
  const ref = /Referenz ([0-9a-f]{8})/.exec(r.body.error);
  assert.ok(ref, r.text);
  assert.ok(!/argument|string|projects/i.test(r.body.error), r.text);
  assert.ok(srv.log().includes(ref[1]), 'Referenz steht im Server-Log');
});

test('#188 wartender Compile: Freigabe-Entzug vor dem Start -> 403 ohne Log', { skip: !hasTex && 'latexmk fehlt', timeout: 60000 }, async () => {
  const srv = await startServer({ COMPILE_TIMEOUT_MS: '5000' });
  test.after(() => srv.stop());
  const { admin, user, userId } = await adminAndUser(srv);
  const root = (await admin.call('POST', '/api/projects/create', { name: 'Queue' })).body.root;
  fs.writeFileSync(path.join(root, 'main.tex'), String.raw`\documentclass{article}
\def\foo{\foo}
\begin{document}
\foo
\end{document}
`);
  await admin.call('POST', '/api/projects/open', { root });
  assert.strictEqual((await admin.call('POST', '/api/share', { login: 'bob' })).status, 200);
  await user.call('POST', '/api/projects/open', { root });
  const blocker = admin.call('POST', '/api/compile'); // occupies the global queue until the time limit
  await sleep(1000);
  const waiting = user.call('POST', '/api/compile');
  await sleep(500);
  assert.strictEqual((await admin.call('DELETE', `/api/share/${userId}`)).status, 200);
  const r = await waiting;
  assert.strictEqual(r.status, 403, r.text);
  assert.ok(!('log' in r.body));
  await blocker;
});
