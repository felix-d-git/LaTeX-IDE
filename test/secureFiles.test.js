// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tightenSecrets } = require('../server/lib/secureFiles');

const skip = process.platform === 'win32' && 'POSIX-Dateirechte';

test('tightenSecrets setzt 0600 und warnt bei offenem Datenordner', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-perm-'));
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'auth-data.json'), '{}', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'auth-data.json'), 0o644);
  const warns = [];
  tightenSecrets(dir, { warn: (m) => warns.push(m) });
  assert.strictEqual(fs.statSync(path.join(dir, 'auth-data.json')).mode & 0o777, 0o600);
  assert.strictEqual(warns.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
