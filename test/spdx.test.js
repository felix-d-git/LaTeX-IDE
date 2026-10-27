// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Every source file carries an SPDX license and copyright header (#77); files
// without comment syntax, and the Dockerfile (no fixed owner name, p12restE.test.js),
// are covered by REUSE.toml. Full check: reuse lint (licenses.yml).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = /\.(js|css|html|py|sh|command|ps1|yml)$/;
const git = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });

test('SPDX: jede Quelldatei hat Lizenz- und Copyright-Kopf', { skip: git.status !== 0 && 'kein Git-Checkout' }, () => {
  const missing = git.stdout.split('\n').filter((f) => SOURCE.test(f) && fs.existsSync(path.join(ROOT, f))).filter((f) => {
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).slice(0, 6).join('\n');
    return !/SPDX-License-Identifier: AGPL-3\.0-only/.test(head) || !/SPDX-FileCopyrightText: /.test(head);
  });
  assert.deepStrictEqual(missing, [], 'Kopf fehlt (siehe CONTRIBUTING.md)');
});
