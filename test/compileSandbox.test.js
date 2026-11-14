// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Security audit #117: project files must not run code via latexmk (#111, #112) and TeX
// must not see the server's secrets (#114).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compile, findMainCandidate, mainPathError } = require('../server/lib/compile');
const { childEnv } = require('../server/lib/childEnv');
// ADMIN_PASSWORD: the throwaway servers' admin login once #116 is merged, until then the old fallback.
const { startServer, client, ADMIN_PASSWORD = 'bitte-sofort-aendern' } = require('./_server');

const hasTex = spawnSync('latexmk', ['-v'], { windowsHide: true }).status === 0;
const DOC = '\\documentclass{article}\n\\begin{document}\nHallo\n\\end{document}\n';

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sandbox-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('mainPathError: Optionen, Shell-Zeichen und Pfade aus dem Projekt heraus abgelehnt (#112)', () => {
  for (const ok of ['main.tex', 'thesis/main.tex', 'Kapitel (Entwurf) ä.tex', 'a b/c-d.TEX', 'x&y.tex']) assert.strictEqual(mainPathError(ok), null, ok);
  for (const bad of ['-pdflatex=touch x;.tex', 'sub/-x.tex', '`touch x`.tex', 'a$(id).tex', 'a%b.tex', 'a~b.tex', 'a"b.tex', 'a\nb.tex', '&x.tex', '../x.tex', '/etc/x.tex', 'main.bib', '', null]) {
    assert.ok(mainPathError(bad), String(bad));
  }
});

test('findMainCandidate überspringt Dateien, die latexmk nicht sicher übergeben werden können', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '-pdflatex=x;.tex'), DOC);
  fs.writeFileSync(path.join(root, 'arbeit.tex'), DOC);
  assert.strictEqual(findMainCandidate(root), 'arbeit.tex');
});

test('childEnv: keine Secrets, aber PATH und TeX-Variablen (#114)', () => {
  const keys = ['DATA_KEY', 'SESSION_SECRET', 'UPDATE_TOKEN', 'ADMIN_PASSWORD', 'SMTP_PASS', 'TS_AUTHKEY', 'TEXMFHOME', 'BIBINPUTS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = 'x';
    const env = childEnv();
    for (const k of ['DATA_KEY', 'SESSION_SECRET', 'UPDATE_TOKEN', 'ADMIN_PASSWORD', 'SMTP_PASS', 'TS_AUTHKEY']) assert.ok(!(k in env), k);
    assert.strictEqual(env.TEXMFHOME, 'x');
    assert.strictEqual(env.BIBINPUTS, 'x');
    assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'PATH'));
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('Hauptdatei mit Backtick/Option im Namen: kein latexmk-Lauf, Fehlermeldung (#112)', async () => {
  const root = tmp();
  for (const name of ['`touch PWNED`.tex', '-pdflatex=touch PWNED;.tex']) {
    fs.writeFileSync(path.join(root, name), DOC);
    const r = await compile(root, name, {}, '.latex-ide-out', 60000);
    assert.strictEqual(r.pdfPath, null);
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0].message, /Hauptdatei/);
    assert.ok(!fs.existsSync(path.join(root, 'PWNED')), name);
  }
});

test('latexmkrc im Projekt wird nicht ausgeführt (#111)', { skip: !hasTex && 'latexmk fehlt' }, async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.tex'), DOC);
  for (const rc of ['latexmkrc', '.latexmkrc']) fs.writeFileSync(path.join(root, rc), `system("touch PWNED${rc}");\n`);
  const r = await compile(root, 'main.tex', {}, '.latex-ide-out', 120000);
  assert.ok(r.pdfPath, r.log.slice(-2000));
  assert.deepStrictEqual(fs.readdirSync(root).filter((f) => f.startsWith('PWNED')), []);
});

test('TeX sieht keine Secrets aus der Umgebung (#114)', { skip: !hasTex && 'latexmk fehlt' }, async () => {
  const root = tmp();
  // kpathsea expands $VAR in file names: the file is only found if TeX can read DATA_KEY.
  fs.writeFileSync(path.join(root, 'geheimwert.tex'), '% leer\n');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\IfFileExists{$DATA_KEY.tex}{\\typeout{SECRET-LEAKED}}{\\typeout{SECRET-HIDDEN}}\n\\begin{document}\nHallo\n\\end{document}\n');
  const saved = process.env.DATA_KEY;
  process.env.DATA_KEY = 'geheimwert';
  try {
    const r = await compile(root, 'main.tex', {}, '.latex-ide-out', 120000);
    assert.ok(r.pdfPath, r.log.slice(-2000));
    assert.match(r.log, /SECRET-HIDDEN/);
    assert.doesNotMatch(r.log, /SECRET-LEAKED/);
  } finally {
    if (saved === undefined) delete process.env.DATA_KEY;
    else process.env.DATA_KEY = saved;
  }
});

test('POST /api/main-file prüft den Namen der Hauptdatei (#112)', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    await c.login('admin', ADMIN_PASSWORD);
    const root = (await c.call('POST', '/api/projects/create', { name: 'Sandbox' })).body.root;
    const h = { 'X-Project-Id': (await c.call('POST', '/api/projects/open', { root })).body.projectId };
    for (const name of ['-pdflatex=touch PWNED;.tex', '`touch PWNED`.tex', 'ok.tex']) {
      const r = await c.call('POST', '/api/tree/file', { path: name }, h);
      assert.strictEqual(r.status, 200, `${name}: ${r.text}`);
    }
    for (const name of ['-pdflatex=touch PWNED;.tex', '`touch PWNED`.tex', 'fehlt.tex', '../x.tex']) {
      const r = await c.call('POST', '/api/main-file', { path: name }, h);
      assert.strictEqual(r.status, 400, name);
    }
    assert.strictEqual((await c.call('POST', '/api/main-file', { path: 'ok.tex' }, h)).status, 200);
    assert.strictEqual((await c.call('GET', '/api/tree', undefined, h)).body.mainFile, 'ok.tex');
  } finally {
    await srv.stop();
  }
});
