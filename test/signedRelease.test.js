// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #172: Server-Update nur mit signiertem Tag (host-eigene .release-signers) und Infra-Stopp.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const upd = fs.readFileSync(path.join(root, 'scripts', 'server-update.sh'), 'utf8');
const rel = fs.readFileSync(path.join(root, '.github', 'workflows', 'auto-release.yml'), 'utf8');

test('server-update.sh: verify-tag gegen host-eigene .release-signers', () => {
  assert.match(upd, /SIGNERS="\$APP_DIR\/\.release-signers"/);
  assert.match(upd, /\[ -f "\$SIGNERS" \] \|\| \{/);
  assert.match(upd, /gpg\.format=ssh/);
  assert.match(upd, /gpg\.ssh\.allowedSignersFile=\$SIGNERS/);
  assert.match(upd, /verify-tag "\$tag"/);
});

test('server-update.sh: Quelle aus verifiziertem Tag, kein ungeprueftes Tarball', () => {
  assert.match(upd, /git -C "\$tmp\/git" archive/);
  assert.doesNotMatch(upd, /\/tarball\//);
});

test('server-update.sh: Verifikation vor Backup und Kopie', () => {
  const v = upd.indexOf('verify-tag');
  assert.ok(v > 0 && v < upd.indexOf('# 1. Backup'));
  assert.ok(v < upd.indexOf('cp -a "$tmp/src/."'));
});

test('server-update.sh: Infra-Stopp ausser ALLOW_INFRA_CHANGES=1', () => {
  assert.match(upd, /ALLOW_INFRA_CHANGES:-\}" != 1/);
  assert.match(upd, /docker-compose\* Dockerfile scripts\/server-update\.sh/);
});

test('.release-signers wird nie vom Release ueberschrieben', () => {
  assert.doesNotMatch(upd, /\.release-signers" *>/);
  assert.ok(!fs.existsSync(path.join(root, '.release-signers')));
});

test('auto-release.yml: signierter Tag, fehlendes Secret bricht ab', () => {
  assert.match(rel, /secrets\.RELEASE_SIGNING_KEY/);
  assert.match(rel, /gpg\.format ssh/);
  assert.match(rel, /git tag -s "\$next"/);
  assert.doesNotMatch(rel, /git tag "\$next"/);
  assert.ok(rel.indexOf('RELEASE_SIGNING_KEY" ] ||') < rel.indexOf('git tag -s'));
});
