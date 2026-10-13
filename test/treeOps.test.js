// Desktop sync deletes (DELETE /api/collab/raw) go to the project's .trash instead of rmSync.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trashPath } = require('../server/lib/treeOps');

test('trashPath verschiebt nach .trash und überschreibt dort nichts (#28)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-trash-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'kap'));
  fs.writeFileSync(path.join(root, 'kap', 'a.tex'), 'eins');
  trashPath(root, 'kap/a.tex');
  fs.writeFileSync(path.join(root, 'kap', 'a.tex'), 'zwei');
  trashPath(root, 'kap/a.tex');
  assert.ok(!fs.existsSync(path.join(root, 'kap', 'a.tex')));
  assert.strictEqual(fs.readFileSync(path.join(root, '.trash', 'kap', 'a.tex'), 'utf8'), 'eins');
  assert.strictEqual(fs.readFileSync(path.join(root, '.trash', 'kap', 'a_2.tex'), 'utf8'), 'zwei');
  assert.throws(() => trashPath(root, 'gibtsnicht.tex'), /Nicht gefunden/);
});
