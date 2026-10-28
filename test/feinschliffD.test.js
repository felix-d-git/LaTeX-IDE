// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncFolder, conflictName } = require('../server/lib/localSync');

test('conflictName zählt hoch statt die erste Konfliktkopie zu überschreiben', () => {
  assert.equal(conflictName('a.tex'), 'a.offline-konflikt.tex');
  const taken = new Set(['a.offline-konflikt.tex', 'a.offline-konflikt-2.tex']);
  assert.equal(conflictName('a.tex', (n) => taken.has(n)), 'a.offline-konflikt-3.tex');
});

test('syncFolder: ein fehlerhafter Download blockiert die übrigen Dateien nicht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12d-'));
  const idx = path.join(dir, 'idx.json');
  const proj = path.join(dir, 'p');
  const files = { 'bad.tex': 'x', 'good.tex': 'y' };
  const sha = require('../server/lib/localSync').sha1;
  const r = await syncFolder(proj, idx, {
    caseInsensitive: false,
    manifest: async () => ({ files: Object.entries(files).map(([path, c]) => ({ path, sha1: sha(Buffer.from(c)) })) }),
    download: async (rel) => {
      if (rel === 'bad.tex') throw new Error('kaputt');
      return Buffer.from(files[rel]);
    },
    upload: async () => {},
    remove: async () => {},
  });
  assert.equal(r.errors.length, 1);
  assert.equal(fs.readFileSync(path.join(proj, 'good.tex'), 'utf8'), 'y');
  assert.ok(!(JSON.parse(fs.readFileSync(idx, 'utf8'))['bad.tex']));
  // fatal (Server weg) bricht weiterhin ab
  await assert.rejects(
    syncFolder(proj, idx, { caseInsensitive: false, manifest: async () => ({ files: [{ path: 'n.tex', sha1: 'z' }] }), download: async () => { throw Object.assign(new Error('off'), { fatal: true }); } }),
    /off/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
