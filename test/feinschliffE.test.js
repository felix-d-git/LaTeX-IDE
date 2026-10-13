const test = require('node:test');
const assert = require('node:assert');
const { isTextFile } = require('../server/lib/fsTree');

test('isTextFile: Endungen und Dateien ohne Endung', () => {
  for (const f of ['a.tex', 'sub/x.TIKZ', 'daten.csv', '.latexmkrc', 'ordner/latexmkrc', 'a\b.ltx']) assert.ok(isTextFile(f), f);
  for (const f of ['bild.png', 'a.pdf', 'x.exe', 'Makefile']) assert.ok(!isTextFile(f), f);
});
