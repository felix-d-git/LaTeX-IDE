// P12 Bereich A (Server index.js + Hilfsmodule): Feinschliff-Fixes aus BEFUNDE-P12.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('pdfNameFor: Unterordner und Backslashes', () => {
  const { pdfNameFor } = require('../server/lib/compile');
  assert.strictEqual(pdfNameFor('kap/haupt.tex'), 'haupt.pdf');
  assert.strictEqual(pdfNameFor('kap\\haupt.TEX'), 'haupt.pdf');
  assert.strictEqual(pdfNameFor('main.tex'), 'main.pdf');
});

test('rateLimit mit countIf zählt nur Fehlschläge', () => {
  const { rateLimit } = require('../server/lib/authMiddleware');
  const mw = rateLimit('t-countif', 2, 60000, () => 'k', { countIf: (res) => res.statusCode >= 400 });
  const call = (status) => {
    let finish;
    const res = { statusCode: status, set() {}, status(c) { this.statusCode = c; return this; }, json() { return this; }, on(ev, fn) { if (ev === 'finish') finish = fn; } };
    let passed = false;
    mw({}, res, () => { passed = true; });
    if (passed) { res.statusCode = status; finish(); }
    return { passed, code: res.statusCode };
  };
  for (let i = 0; i < 5; i++) assert.ok(call(200).passed); // Erfolge zählen nicht
  assert.ok(call(401).passed);
  assert.ok(call(401).passed);
  const blocked = call(200);
  assert.strictEqual(blocked.passed, false);
  assert.strictEqual(blocked.code, 429);
});

test('auth: beschädigte Datei bricht ab, Passwort-Mindestlänge, doppelte E-Mail', () => {
  const dir = tmp('lide-auth-');
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'auth-data.json'), '{ kaputt');
  const authPath = path.join(__dirname, '..', 'server', 'lib', 'auth.js');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(authPath)})`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /beschädigt/);

  fs.rmSync(path.join(dir, 'auth-data.json'));
  const code = `
    const a = require(${JSON.stringify(authPath)});
    (async () => {
      let e1; try { a.validatePassword('kurz'); } catch (e) { e1 = e.message; }
      if (!/8 Zeichen/.test(e1)) throw new Error('validate');
      await a.createUser({ email: 'a@b.de', username: 'alice', password: 'langgenug1' });
      let dup; try { await a.createUser({ email: 'A@b.de', username: 'bob', password: 'langgenug1' }); } catch (e) { dup = e; }
      if (!dup) throw new Error('duplicate email accepted');
      console.log('OK');
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const r2 = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /OK/);
});

test('treeOps: Projektwurzel geschützt, Groß/Klein-Umbenennung erlaubt', () => {
  const t = require('../server/lib/treeOps');
  const root = tmp('lide-tree-');
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.tex'), 'x');
  assert.throws(() => t.deletePath(root, ''));
  assert.throws(() => t.deletePath(root, '.'));
  assert.throws(() => t.renamePath(root, '', 'neu'));
  assert.ok(fs.existsSync(root));
  t.renamePath(root, 'a.tex', 'A.tex'); // gleiche Datei, nur Schreibweise
  assert.ok(fs.readdirSync(root).includes('A.tex'));
});

test('state.copyRoot kopiert Hauptdatei/Einstellungen, nicht Freigaben', () => {
  const dir = tmp('lide-state-');
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // getMainFile ignores a main file that does not exist (P12-B)
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b', 'haupt.tex'), 'x');
  const code = `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'state.js'))});
    const a = ${JSON.stringify(path.join(dir, 'a'))}, b = ${JSON.stringify(path.join(dir, 'b'))};
    s.setMainFile(a, 'haupt.tex');
    s.copyRoot(a, b);
    if (s.getMainFile(b) !== 'haupt.tex') throw new Error('main');
    s.setMainFile(a, 'x.tex');
    if (s.getMainFile(b) !== 'haupt.tex') throw new Error('shared reference');
    console.log('OK');`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, DATA_DIR: dir, LATEX_IDE_LOCAL: dir }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});
