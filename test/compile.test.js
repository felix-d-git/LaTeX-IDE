// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Paket P7 (#36): a main file in a subfolder finds its PDF and its \input files,
// log paths stay tree-relative.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compile, parseLog, pdfNameFor } = require('../server/lib/compile');

const hasTex = spawnSync('latexmk', ['-v'], { windowsHide: true }).status === 0;
const hasLua = hasTex && spawnSync('lualatex', ['--version'], { windowsHide: true }).status === 0;

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-compile-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('pdfNameFor: Jobname = Basisname, auch im Unterordner (#36)', () => {
  assert.strictEqual(pdfNameFor('main.tex'), 'main.pdf');
  assert.strictEqual(pdfNameFor('thesis/main.tex'), 'main.pdf');
  assert.strictEqual(pdfNameFor('a/b/Arbeit.TEX'), 'Arbeit.pdf');
});

test('parseLog: Hauptdatei im Unterordner liefert baumrelative Pfade (#36)', () => {
  const root = path.join(os.tmpdir(), 'proj');
  const log = [
    '(./thesis/main.tex',
    'LaTeX2e <2024-11-01>',
    '(./thesis/kapitel.tex',
    './thesis/kapitel.tex:2: Undefined control sequence.',
    'l.2 \\foo',
    '',
    'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.',
    '',
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 4--5',
  ].join('\n');
  const { errors, warnings, infos } = parseLog(log, root);
  assert.deepStrictEqual(errors.map((e) => [e.file, e.line]), [['thesis/kapitel.tex', 2]]);
  assert.deepStrictEqual(warnings.map((w) => [w.file, w.line]), [['thesis/kapitel.tex', 3]]);
  assert.deepStrictEqual(infos.map((i) => [i.file, i.line]), [['thesis/kapitel.tex', 4]]);
});

test('parseLog: TeX-Abschlusszeilen keine eigenen Fehler, lange Zeilen ohne Folgezeile (#138)', () => {
  const root = path.join(os.tmpdir(), 'proj');
  const long = './main.tex:5: Font TU/X(0)/m/n/10="Noto Serif CJK SC/OT" at 10.0pt not loadable: Metric (TFM) file or installed font not found.';
  const log = ['./main.tex:4: Undefined control sequence.', 'l.4 \\undefinedA', '', long, '<to be read again>', './main.tex:4:  ==> Fatal error occurred, no output PDF file produced!'].join('\n');
  const { errors } = parseLog(log, root);
  assert.deepStrictEqual(errors.map((e) => e.message), ['Undefined control sequence.', long.replace('./main.tex:5: ', '')]);
  // ohne anderen Fehler bleibt die Abschlusszeile stehen (sonst wäre die Liste leer)
  assert.strictEqual(parseLog('./main.tex:3: Emergency stop.', root).errors.length, 1);
});

test('Kompilieren: Hauptdatei im Unterordner -> PDF gefunden, \\input relativ dazu, Fehler mit Pfad (#36)', { skip: !hasTex && 'latexmk fehlt' }, async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'thesis'));
  fs.writeFileSync(path.join(root, 'thesis', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHallo\n\\input{kapitel}\n\\end{document}\n');
  fs.writeFileSync(path.join(root, 'thesis', 'kapitel.tex'), 'Kapitel\n\\foobarundefined\n');
  const r = await compile(root, 'thesis/main.tex', {}, '.latex-ide-out', 120000);
  assert.strictEqual(r.pdfPath, '.latex-ide-out/main.pdf', r.log.slice(-2000));
  assert.ok(fs.existsSync(path.join(root, r.pdfPath)));
  assert.ok(fs.existsSync(path.join(root, '.latex-ide-out', 'main.synctex.gz')));
  assert.deepStrictEqual(r.errors.map((e) => [e.file, e.line]), [['thesis/kapitel.tex', 2]]);
});

// openin_any=p kept luaotfload from its own files in texmf-dist: every lualatex run aborted (#119).
test('Kompilieren mit LuaLaTeX: fontspec und \\directlua -> PDF (#119)', { skip: !hasLua && 'latexmk/lualatex fehlt', timeout: 900000 }, async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Latin Modern Roman}\n\\begin{document}\nHallo \\directlua{tex.sprint("aus Lua")}\n\\end{document}\n');
  const r = await compile(root, 'main.tex', { compiler: 'lualatex' }, '.latex-ide-out', 600000);
  assert.strictEqual(r.pdfPath, '.latex-ide-out/main.pdf', r.log.slice(-3000));
  assert.ok(r.success, r.log.slice(-3000));
});
