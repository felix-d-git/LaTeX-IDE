// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Desktop sync deletes (DELETE /api/collab/raw) go to the project's .trash instead of rmSync.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trashPath, purgeTrash } = require('../server/lib/treeOps');
const { findByName } = require('../server/lib/fsTree');

const DAY = 86400000;
const NOW = Date.parse('2026-10-31T12:00:00Z');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-trash-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('trashPath verschiebt nach .trash und überschreibt dort nichts (#28)', () => {
  const root = tmpRoot();
  const bucket = path.join(root, '.trash', 'deleted-2026-10-31', 'kap');
  fs.mkdirSync(path.join(root, 'kap'));
  fs.writeFileSync(path.join(root, 'kap', 'a.tex'), 'eins');
  trashPath(root, 'kap/a.tex', NOW);
  fs.writeFileSync(path.join(root, 'kap', 'a.tex'), 'zwei');
  trashPath(root, 'kap/a.tex', NOW);
  assert.ok(!fs.existsSync(path.join(root, 'kap', 'a.tex')));
  assert.strictEqual(fs.readFileSync(path.join(bucket, 'a.tex'), 'utf8'), 'eins');
  assert.strictEqual(fs.readFileSync(path.join(bucket, 'a_2.tex'), 'utf8'), 'zwei');
  assert.throws(() => trashPath(root, 'gibtsnicht.tex'), /Nicht gefunden/);
});

test('purgeTrash löscht nur abgelaufene Tage, Alt-Einträge laufen erst ab jetzt', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'neu.tex'), 'neu');
  fs.writeFileSync(path.join(root, 'alt.tex'), 'alt');
  trashPath(root, 'alt.tex', NOW - 31 * DAY);
  trashPath(root, 'neu.tex', NOW - 29 * DAY);
  fs.writeFileSync(path.join(root, '.trash', 'vorher.tex'), 'vorher');
  fs.mkdirSync(path.join(root, '.trash', '2020-01-01')); // gelöschter Ordner, kein Bucket
  purgeTrash(root, 30, NOW);
  assert.ok(!fs.existsSync(path.join(root, '.trash', 'deleted-2026-09-30')));
  assert.ok(fs.existsSync(path.join(root, '.trash', 'deleted-2026-10-02', 'neu.tex')));
  assert.ok(!fs.existsSync(path.join(root, '.trash', 'vorher.tex')));
  assert.ok(fs.existsSync(path.join(root, '.trash', 'deleted-2026-10-31', 'vorher.tex')));
  assert.ok(fs.existsSync(path.join(root, '.trash', 'deleted-2026-10-31', '2020-01-01')));
  purgeTrash(root, 30, NOW + 31 * DAY);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.trash')), []);
  purgeTrash(tmpRoot(), 30, NOW); // ohne .trash: nichts zu tun
});

test('findByName findet Dateien im Projekt, aber nicht in ignorierten Ordnern', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'lit'));
  fs.mkdirSync(path.join(root, '.trash'));
  fs.writeFileSync(path.join(root, 'lit', 'zotero.bib'), '');
  fs.writeFileSync(path.join(root, '.trash', 'zotero.bib'), '');
  assert.deepStrictEqual(findByName(root, 'zotero.bib'), ['lit/zotero.bib']);
  fs.writeFileSync(path.join(root, 'zotero.bib'), '');
  assert.strictEqual(findByName(root, 'zotero.bib').length, 2);
  assert.deepStrictEqual(findByName(root, 'fehlt.bib'), []);
});
