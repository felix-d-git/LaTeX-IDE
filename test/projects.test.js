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
  assert.throws(() => projects.trashArchivedProject(dir, '../C'), /Archiv nicht gefunden/);
  assert.ok(fs.existsSync(path.join(dir, 'C', 'marker.txt')));
});
