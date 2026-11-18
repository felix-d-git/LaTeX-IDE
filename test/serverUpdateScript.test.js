// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #171: server-update.sh folgt keinen Symlinks im Datenordner, Vault-Modus aus .update.env.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const file = path.join(__dirname, '..', 'scripts', 'server-update.sh');
const src = fs.readFileSync(file, 'utf8');

test('Status atomar per Temp-Datei + mv -fT', () => {
  assert.match(src, /mv -fT/);
  assert.match(src, /mktemp "\$\(dirname "\$STATUS"\)/);
  assert.doesNotMatch(src, />\s*"\$STATUS"/);
});

test('.update-request: Symlink wird ignoriert', () => {
  assert.match(src, /-L "\$REQUEST"/);
});

test('Vault-Modus aus .update.env, nicht aus dem Datenordner', () => {
  assert.match(src, /\[ "\$\{VAULT:-\}" = 1 \]/);
  assert.match(src, /VAULT=1" >> "\$APP_DIR\/\.update\.env"/);
  assert.doesNotMatch(src, /if \[ -d "\$DATA_DIR\/vault" \]; then\s*\n\s*BACKUP_SRC/);
});

test('LF-Zeilenenden', () => assert.ok(!src.includes('\r')));

test('bash -n', (t) => {
  const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  if (r.error) return t.skip('bash fehlt');
  assert.strictEqual(r.status, 0, r.stderr);
});
