// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../server/lib/projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function mk(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
}

test('archiviertes Projekt in den Papierkorb, gleichnamiges aktives bleibt', () => {
  const dir = path.join(tmp, 'u1');
  mk(path.join(dir, '.archive', 'A'), 'archiv-A');
  mk(path.join(dir, '.archive', 'B'), 'archiv-B');
  mk(path.join(dir, 'B'), 'aktiv-B');
  projects.trashArchivedProject(dir, 'A');
  projects.trashArchivedProject(dir, 'B');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.trash', 'A', 'marker.txt'), 'utf8'), 'archiv-A');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.trash', 'B', 'marker.txt'), 'utf8'), 'archiv-B');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'B', 'marker.txt'), 'utf8'), 'aktiv-B');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.archive')), []);
});

test('trashArchivedProject: unbekannt oder Pfad statt Name -> Fehler', () => {
  const dir = path.join(tmp, 'u2');
  mk(path.join(dir, 'C'), 'aktiv-C');
  assert.throws(() => projects.trashArchivedProject(dir, 'C'), /Archiv nicht gefunden/);
  assert.throws(() => projects.trashArchivedProject(dir, '../C'), /Ungültiger Projektname/);
  assert.ok(fs.existsSync(path.join(dir, 'C', 'marker.txt')));
});

test('Quellnamen mit Path-Traversal werden abgelehnt (#144)', () => {
  const dir = path.join(tmp, 'users', 'u144');
  mk(dir, 'eigen');
  mk(path.join(tmp, 'users', 'fremd'), 'fremd');
  mk(path.join(dir, '.trash', 'x'), 'x');
  const bad = ['..', '../fremd', 'a/../../fremd', '..\\fremd', path.join(tmp, 'users', 'fremd'), '', '.', '.trash', 'users', undefined];
  const calls = [
    (n) => projects.renameProject(dir, n, 'neu'),
    (n) => projects.copyProject(dir, n, 'kopie'),
    (n) => projects.copyProject(dir, n),
    (n) => projects.trashProject(dir, n),
    (n) => projects.archiveProject(dir, n),
    (n) => projects.unarchiveProject(dir, n),
    (n) => projects.restoreProject(dir, n),
    (n) => projects.trashArchivedProject(dir, n),
    (n) => projects.deleteProjectPermanently(dir, n),
  ];
  for (const call of calls) for (const n of bad) assert.throws(() => call(n), /Ungültiger Projektname/, `${call} mit ${n}`);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'users', 'fremd', 'marker.txt'), 'utf8'), 'fremd');
  assert.ok(fs.existsSync(path.join(dir, '.trash', 'x')));
  assert.ok(!fs.existsSync(path.join(dir, 'neu')) && !fs.existsSync(path.join(dir, 'kopie')));
});
