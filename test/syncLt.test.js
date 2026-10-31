// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// PDF→Code-Sprung (Projekt hinter Symlink/Junction, .cls-Treffer) und LanguageTool-URL ohne Schema.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const { toProjectPath, inverseInProject } = require('../server/lib/synctex');
const { compile } = require('../server/lib/compile');

const load = async (file) => {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../client/src', file)], bundle: true, format: 'esm', write: false, logLevel: 'silent',
  });
  return import('data:text/javascript,' + encodeURIComponent(outputFiles[0].text));
};

const has = (cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const hasTex = has('latexmk') && has('synctex');

test('normalizeLtUrl: localhost:8081 wird http://localhost:8081, API-Endung fällt weg', async () => {
  const { normalizeLtUrl, checkRequest } = await load('languageTool.js');
  assert.strictEqual(normalizeLtUrl('localhost:8081'), 'http://localhost:8081');
  assert.strictEqual(normalizeLtUrl(' 127.0.0.1:8081/ '), 'http://127.0.0.1:8081');
  assert.strictEqual(normalizeLtUrl('http://localhost:8081/v2/check'), 'http://localhost:8081');
  assert.strictEqual(normalizeLtUrl('https://lt.example.org/v2'), 'https://lt.example.org');
  assert.strictEqual(normalizeLtUrl(''), '');
  assert.strictEqual(checkRequest('localhost:8081', 'x', 'de-DE')[0], 'http://localhost:8081/v2/check');
});

test('toProjectPath: echter Pfad hinter Symlink, ./-Marke, fremde Dateien', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sync-'));
  fs.mkdirSync(path.join(real, 'kap'));
  fs.writeFileSync(path.join(real, 'main.tex'), '');
  fs.writeFileSync(path.join(real, 'kap', 'eins.tex'), '');
  const link = real + '-link';
  fs.symlinkSync(real, link, 'junction');
  try {
    const rp = fs.realpathSync(real).split(path.sep).join('/');
    assert.strictEqual(toProjectPath(link, `${rp}/./main.tex`), 'main.tex');
    assert.strictEqual(toProjectPath(link, `${rp}/./kap/eins.tex`), 'kap/eins.tex');
    assert.strictEqual(toProjectPath(link, path.join(rp, 'kap', 'eins.tex')), 'kap/eins.tex');
    assert.strictEqual(toProjectPath(link, 'kap/eins.tex'), 'kap/eins.tex');
    // Anderer (z. B. anders kodierter) Projektpfad vor der ./-Marke
    assert.strictEqual(toProjectPath(link, '/ganz/anders/./kap/eins.tex'), 'kap/eins.tex');
    assert.strictEqual(toProjectPath(link, '/usr/share/texlive/texmf-dist/tex/latex/base/article.cls'), null);
    assert.strictEqual(toProjectPath(link, `${rp}/./../geheim.tex`), null);
  } finally {
    fs.rmSync(link, { force: true, recursive: false });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('inverseInProject: Doppelklick im PDF findet die Zeile auch über einen Symlink', { skip: !hasTex && 'latexmk/synctex fehlt' }, async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sync-'));
  const link = real + '-link';
  fs.symlinkSync(real, link, 'junction');
  try {
    fs.mkdirSync(path.join(real, 'kap'));
    fs.writeFileSync(path.join(real, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nErster Absatz.\n\n\\input{kap/eins}\n\\end{document}\n');
    fs.writeFileSync(path.join(real, 'kap', 'eins.tex'), '\\vspace*{5cm}\nKapiteltext.\n');
    const r = await compile(link, 'main.tex', {}, '.latex-ide-out', 120000);
    assert.ok(r.pdfPath, r.log.slice(-2000));
    const pdf = path.join(link, r.pdfPath);
    assert.deepStrictEqual(await inverseInProject(link, pdf, 1, 150, 134), { file: 'main.tex', line: 3 });
    const hit = await inverseInProject(link, pdf, 1, 150, 134 + 5 * 28.45 + 12);
    assert.strictEqual(hit.file, 'kap/eins.tex');
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});
