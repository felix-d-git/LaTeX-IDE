// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Regression #155: user-controlled regex must not block the server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { searchProject } = require('../server/lib/search');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-redos-'));
fs.writeFileSync(path.join(root, 'a.tex'), 'hello world\n' + 'a'.repeat(4000) + '!\n');

test('catastrophic pattern is aborted by the timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(searchProject(root, '(a+)+$', { regex: true }, 500), /Zeitlimit/);
  assert.ok(Date.now() - t0 < 3000);
});

test('too long pattern is rejected', async () => {
  await assert.rejects(searchProject(root, 'a'.repeat(501), { regex: true }), /zu lang/);
});

test('lines over the length limit are skipped', async () => {
  fs.writeFileSync(path.join(root, 'b.tex'), 'x'.repeat(6000) + ' needle\n');
  assert.deepStrictEqual((await searchProject(root, 'needle')).length, 0);
});

test('normal search still finds matches', async () => {
  const r = await searchProject(root, 'wor.d', { regex: true });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].line, 1);
});
