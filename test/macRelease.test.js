// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Das macOS-Release-ZIP muss install.command ausführbar enthalten (#56).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('Release-Workflow packt das macOS-ZIP auf Linux mit chmod +x', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const [desktop, macos] = yml.split(/^  macos:\s*$/m);
  assert.ok(macos, 'Job "macos" fehlt');
  assert.match(macos, /runs-on: (ubuntu|macos)-/);
  assert.match(macos, /needs: desktop/);
  assert.match(macos, /chmod \+x staging\/install\.command/);
  assert.match(macos, /zip -r -X/);
  assert.match(macos, /gh release upload .*LatexIDE-macOS\.zip/);
  // Das Windows-ZIP (ohne Unix-Rechte) darf nicht mehr hochgeladen werden
  assert.doesNotMatch(desktop, /gh release upload .*LatexIDE-macOS\.zip/);
  assert.match(desktop, /-MacStagingOut installer\/out\/macos/);
  assert.match(desktop, /path: installer\/out\/macos/);
});

test('install.command ist in git ausführbar', () => {
  const out = execFileSync('git', ['ls-files', '-s', 'installer/macos/install.command'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /^100755 /);
});
