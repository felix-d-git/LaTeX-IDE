// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Statische Prüfungen: Installer schreibt kein Admin-Passwort (#181), REUSE.toml ohne Pauschalregel (#200), luaSandbox.lua Doppellizenz (#199).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('#181: Windows-Installer schreibt/fragt kein ADMIN_PASSWORD', () => {
  const iss = read('installer/windows/LatexIDE.iss');
  assert.doesNotMatch(iss, /ADMIN_PASSWORD/);
  assert.match(iss, /initial-admin-password\.txt/);
  assert.doesNotMatch(read('installer/macos/install.command'), /ADMIN_PASSWORD/);
});

test('#200: REUSE.toml ohne path="**"', () => {
  const toml = read('REUSE.toml');
  assert.doesNotMatch(toml, /path\s*=\s*"\*\*"/);
  assert.match(toml, /THIRD_PARTY_NOTICES\.md/);
  assert.match(toml, /package-lock\.json/);
});

test('#199: luaSandbox.lua ist AGPL-3.0-only OR MIT', () => {
  assert.match(read('server/lib/luaSandbox.lua').split('\n')[0], /AGPL-3\.0-only OR MIT/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'LICENSES/MIT.txt')));
});
