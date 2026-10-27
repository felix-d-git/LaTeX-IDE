// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// P12-B Feinschliff: Dateien, Kompilieren, Verlauf.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feinschliffB-'));
process.env.DATA_DIR = tmp; // state.js liest workspace.json von hier
const state = require('../server/state');
const treeOps = require('../server/lib/treeOps');
const projects = require('../server/lib/projects');
const { parseLog } = require('../server/lib/compile');
const { searchProject } = require('../server/lib/search');
const { stripComments } = require('../server/lib/wordcount');
const { decodeName } = require('../server/lib/unzip');
const { isIgnored, isTextFile } = require('../server/lib/fsTree');
const comments = require('../server/lib/comments');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parseLog: nur der letzte TeX-Lauf zählt, biber-Fehler und .sty-Fehler erscheinen', () => {
  const log = [
    "Run number 1 of rule 'pdflatex'",
    'LaTeX Warning: Citation `x\' on page 1 undefined on input line 5.',
    "Run number 2 of rule 'pdflatex'",
    './a.sty:3: Undefined control sequence.',
    "Run number 1 of rule 'biber main'",
    'ERROR - Cannot find x.bib',
  ].join('\n');
  const r = parseLog(log, '/root');
  assert.strictEqual(r.warnings.length, 0);
  assert.ok(r.errors.some((e) => e.file === 'a.sty' && e.line === 3));
  assert.ok(r.errors.some((e) => e.message.startsWith('biber:')));
});

test('Textdateien und mehrteilige ignorierte Endungen', () => {
  assert.ok(isTextFile('a/fig.tikz') && isTextFile('d.csv') && isTextFile('x.lua'));
  assert.ok(isIgnored('main.synctex.gz') && isIgnored('main.run.xml') && isIgnored('.latex-ide-comments.json.1.tmp'));
  assert.ok(!isIgnored('main.tex'));
});

test('treeOps: Projektwurzel ist kein gültiges Ziel', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'p-'));
  fs.writeFileSync(path.join(root, 'a.tex'), 'x');
  for (const p of ['.', '', undefined]) assert.throws(() => treeOps.deletePath(root, p), /Projektwurzel/);
  assert.throws(() => treeOps.renamePath(root, '.', 'neu'), /Projektwurzel/);
  assert.ok(fs.existsSync(root));
});

test('Projektnamen: reservierte Namen abgelehnt', () => {
  for (const n of ['users', 'Users', '.trash', '.x', 'abc.']) assert.throws(() => projects.createProject(tmp, n), /reserviert|Punkt/);
});

test('copyProject lässt Build-Ausgaben und Verlauf weg', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  const src = projects.createProject(dir, 'A');
  for (const d of ['.latex-ide-out', '.latex-ide-history']) {
    fs.mkdirSync(path.join(src, d));
    fs.writeFileSync(path.join(src, d, 'x'), '1');
  }
  const dest = projects.copyProject(dir, 'A', 'B');
  assert.ok(fs.existsSync(path.join(dest, 'main.tex')));
  assert.ok(!fs.existsSync(path.join(dest, '.latex-ide-out')) && !fs.existsSync(path.join(dest, '.latex-ide-history')));
});

test('listProjects: exclude', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'l-'));
  fs.mkdirSync(path.join(dir, 'users'));
  fs.mkdirSync(path.join(dir, 'p'));
  assert.deepStrictEqual(projects.listProjects(dir, ['users']).map((p) => p.name), ['p']);
});

test('Hauptdatei folgt Umbenennen/Verschieben und fällt bei Löschung weg', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'm-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'm.tex'), 'x');
  state.setMainFile(root, 'sub/m.tex');
  fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub2'));
  state.movePathInMainFile(root, 'sub', 'sub2');
  assert.strictEqual(state.getMainFile(root), 'sub2/m.tex');
  fs.rmSync(path.join(root, 'sub2'), { recursive: true });
  assert.strictEqual(state.getMainFile(root), null);
});

test('Suche: Ganzes Wort mit Umlauten, CRLF', () => {
  const root = fs.mkdtempSync(path.join(tmp, 's-'));
  fs.writeFileSync(path.join(root, 'a.tex'), 'Größe und Größen\r\nGröße\r\n');
  const r = searchProject(root, 'Größe', { wholeWord: true });
  assert.deepStrictEqual(r.map((x) => x.line), [1, 2]);
  assert.strictEqual(r[0].matches.length, 1);
  assert.ok(!r[1].lineText.includes('\r'));
});

test('stripComments: \% bleibt, \\% ist Kommentar', () => {
  assert.strictEqual(stripComments('50\\% a'), '50\\% a');
  assert.strictEqual(stripComments('a\\\\% c'), 'a\\\\');
  assert.strictEqual(stripComments('% \\input{x}'), '');
});

test('Zip-Namen: UTF-8 ohne Flag und CP437', () => {
  assert.strictEqual(decodeName(Buffer.from('Größe.tex'), 0), 'Größe.tex');
  assert.strictEqual(decodeName(Buffer.from([0x81, 0x8e, 0x94, 0xe1]), 0), 'üÄöß');
});

test('Kommentare: beschädigte Datei wird gesichert und nicht stillschweigend überschrieben', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'k-'));
  const f = path.join(root, '.latex-ide-comments.json');
  fs.writeFileSync(f, '{"a.tex": [{"id"');
  assert.deepStrictEqual(comments.load ? comments.load(root) : {}, {});
  if (comments.load) assert.ok(fs.existsSync(f + '.corrupt'));
});
