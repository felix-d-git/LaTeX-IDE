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
