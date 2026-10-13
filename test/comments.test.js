const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const comments = require('../server/lib/comments');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comments-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function project(files, data) {
  const root = path.join(tmp, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.mkdirSync(root, { recursive: true });
  if (data) fs.writeFileSync(path.join(root, comments.COMMENTS_FILE), JSON.stringify(data));
  return root;
}
const stored = (root) => JSON.parse(fs.readFileSync(path.join(root, comments.COMMENTS_FILE), 'utf8'));
const c = (id, anchorText, from = 0) => ({ id, from, to: from + anchorText.length, anchorText, text: 'x' });

test('movePath: Kommentare folgen Datei und Ordner, Löschen entfernt sie', () => {
  const root = project({}, { 'a.tex': [c('1', 'x')], 'kap/b.tex': [c('2', 'y')], 'kapitel.tex': [c('3', 'z')] });
  assert.strictEqual(comments.movePath(root, 'a.tex', 'neu.tex'), true);
  assert.strictEqual(comments.movePath(root, 'kap', 'teile/kap'), true);
  let d = stored(root);
  assert.deepStrictEqual(Object.keys(d).sort(), ['kapitel.tex', 'neu.tex', 'teile/kap/b.tex']);
  comments.movePath(root, 'neu.tex', null);
  d = stored(root);
  assert.strictEqual(d['neu.tex'], undefined);
  assert.ok(d['kapitel.tex'], 'Präfix nur bis Ordnergrenze');
});

test('movePath: Ziel mit Kommentaren wird nach id zusammengeführt, nichts überschrieben', () => {
  const root = project({}, { 'a.tex': [c('1', 'x'), c('2', 'neu')], 'b.tex': [{ ...c('1', 'x'), text: 'behalten' }] });
  comments.movePath(root, 'a.tex', 'b.tex');
  const d = stored(root);
  assert.deepStrictEqual(d['b.tex'].map((k) => [k.id, k.text]), [['1', 'behalten'], ['2', 'x']]);
});

test('verwaist nach Umbenennen: einziger Treffer per anchorText, Positionen neu', () => {
  const root = project({ 'neu.tex': 'Vorspann\r\nHallo Welt\n', 'andere.tex': 'nichts' }, { 'alt.tex': [c('1', 'Hallo Welt', 99)] });
  const all = comments.listAll(root);
  assert.deepStrictEqual(Object.keys(all), ['neu.tex']);
  assert.deepStrictEqual([all['neu.tex'][0].from, all['neu.tex'][0].to], [9, 19]);
  assert.ok(stored(root)['neu.tex'], 'Zuordnung gespeichert');
});

test('verwaist nach Verschieben: gleicher Dateiname in anderem Ordner', () => {
  const root = project({ 'kap/einl.tex': 'ganz anders', 'main.tex': 'x' }, { 'einl.tex': [c('1', 'weg')] });
  const all = comments.listAll(root);
  assert.deepStrictEqual(Object.keys(all), ['kap/einl.tex']);
  assert.strictEqual(all['kap/einl.tex'][0].from, 0, 'anchorText nicht gefunden -> Position bleibt');
});

test('mehrdeutig und ohne Treffer: unsichtbar geparkt, nie gelöscht, taucht bei gleichnamiger Datei nicht auf', () => {
  const root = project(
    { 'a/x.tex': 'gleich', 'b/x.tex': 'gleich' },
    { 'x.tex': [c('1', 'gleich')], 'weg.tex': [c('2', 'nirgends')] }
  );
  assert.deepStrictEqual(comments.listAll(root), {});
  const d = stored(root);
  assert.deepStrictEqual(Object.keys(d[comments.ORPHANED]).sort(), ['weg.tex', 'x.tex']);
  // Neue Datei mit altem Namen: Kommentare bleiben geparkt.
  fs.writeFileSync(path.join(root, 'weg.tex'), 'neuer Inhalt');
  assert.deepStrictEqual(comments.listAll(root), {});
  // Später eindeutig: wird beim nächsten Lauf zugeordnet.
  fs.rmSync(path.join(root, 'b'), { recursive: true });
  const all = comments.listAll(root);
  assert.deepStrictEqual(all['a/x.tex'].map((k) => k.id), ['1']);
  assert.ok(stored(root)[comments.ORPHANED]['weg.tex'], 'weiter geparkt');
});

test('wieder auftauchende Datei: Kommentare unter existierendem Pfad bleiben, kein Schreiben', () => {
  const root = project({ 'main.tex': 'abc' }, { 'main.tex': [c('1', 'abc')] });
  const before = fs.statSync(path.join(root, comments.COMMENTS_FILE)).mtimeMs;
  assert.deepStrictEqual(Object.keys(comments.listAll(root)), ['main.tex']);
  assert.strictEqual(fs.statSync(path.join(root, comments.COMMENTS_FILE)).mtimeMs, before);
});
