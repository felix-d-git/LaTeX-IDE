// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Installer-Downloads im Build und in den Installern nur mit Hash-/Signaturpruefung (#175): statische Textpruefung.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

test('install-tl.zip: feste SHA-512 in Windows-Installer und CI', () => {
  for (const y of [read('installer', 'windows', 'install-texlive.ps1'), read('.github', 'workflows', 'synctex-windows.yml')]) {
    assert.match(y, /Get-FileHash[^\n]*SHA512/);
    assert.match(y, /[0-9a-f]{128}/);
    assert.match(y, /C78B82D8C79512F79CC0D7C80D5E5D9106BAB6BC/);
  }
});

test('MacTeX: feste Datei, SHA-512 und Team-ID-Pruefung, kein Listing-Scrape', () => {
  const s = read('installer', 'macos', 'install.command');
  assert.match(s, /MACTEX_PKG="mactex-\d+\.pkg"/);
  assert.match(s, /shasum -a 512/);
  assert.match(s, /pkgutil --check-signature/);
  assert.match(s, /MACTEX_TEAM_ID="[A-Z0-9]{10}"/);
  assert.ok(s.indexOf('pkgutil --check-signature') < s.indexOf('sudo installer'));
  assert.doesNotMatch(s, /href=/);
});

test('release.yml: Inno Setup mit fester Version und SHA-256', () => {
  const y = read('.github', 'workflows', 'release.yml');
  assert.match(y, /choco install innosetup --version \d+\.\d+\.\d+/);
  assert.match(y, /Get-FileHash[^\n]*SHA256/);
  assert.doesNotMatch(y, /choco install innosetup -y/);
});
