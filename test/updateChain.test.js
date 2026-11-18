// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #177: hardened update chain (Dependabot cooldown, no instant release after
// automerge, release waiting period, no third-party lifecycle scripts).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const wf = (f) => read('.github', 'workflows', f);

test('every Dependabot ecosystem has a cooldown', () => {
  const blocks = read('.github', 'dependabot.yml').split(/\n  - package-ecosystem:/).slice(1);
  assert.strictEqual(blocks.length, 4);
  for (const b of blocks) assert.match(b, /\n    cooldown:\n      default-days: \d+/);
});

test('automerge does not trigger a release', () => {
  assert.doesNotMatch(wf('dependabot-automerge.yml'), /gh workflow run/);
});

test('auto-release waits MIN_AGE_H hours after the newest commit', () => {
  const y = wf('auto-release.yml');
  assert.match(y, /MIN_AGE_H: \d+/);
  assert.match(y, /-ge "\$MIN_AGE_H"/);
});

test('npm ci runs without lifecycle scripts', () => {
  const files = ['ci.yml', 'licenses.yml', 'synctex-windows.yml'].map(wf)
    .concat(read('Dockerfile'), read('installer', 'build-release.ps1'));
  for (const s of files) {
    assert.doesNotMatch(s, /^\s*(run: |RUN )?npm ci\s*$/m);
    assert.match(s, /npm ci --ignore-scripts/);
  }
});
