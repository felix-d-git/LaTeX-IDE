// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Issue #64 A: Robustheit (Schreibfehler, Verlaufsindex, Datenordner, Pfad-Normalisierung).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-p12a-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
process.env.DATA_DIR = tmp();

test('1: Schreibfehler -> Doc bleibt dirty/geladen, Hinweis, editText wirft, danach wieder ok', () => {
  const collab = require('../server/lib/collab');
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.tex'), 'hallo');
  const events = [];
  collab.setHooks({ onSaveState: (r, rel, failed) => events.push([rel, failed]) });
  const orig = console.error;
  console.error = () => {};
  try {
    // Ziel ist plötzlich ein Ordner -> Rename schlägt fehl.
    const ws = Object.assign(new (require('events'))(), { readyState: 1, send() {}, close() {} });
    collab.handleConnection(ws, root, 'a.tex', null); // verbunden Client hält das Doc geladen
    fs.rmSync(path.join(root, 'a.tex'));
    fs.mkdirSync(path.join(root, 'a.tex'));
    assert.throws(() => collab.editText(root, 'a.tex', (t) => t + '!'), /Speichern fehlgeschlagen/);
    assert.deepStrictEqual(events, [['a.tex', true]]);
    assert.strictEqual(collab.readText(root, 'a.tex'), 'hallo!', 'Doc nicht entladen');
    fs.rmdirSync(path.join(root, 'a.tex'));
    collab.flushRoot(root); // Retry
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.tex'), 'utf8'), 'hallo!');
    assert.deepStrictEqual(events, [['a.tex', true], ['a.tex', false]]);
    ws.emit('close');
  } finally {
    console.error = orig;
    collab.setHooks({ onSaveState: () => {} });
  }
});

test('2: kaputter Verlaufsindex wird gesichert und aus snapshots/ neu aufgebaut', () => {
  const history = require('../server/lib/history');
  const root = tmp();
  const h = path.join(root, history.HISTORY_DIR);
  fs.mkdirSync(path.join(h, 'snapshots', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(h, 'snapshots', 'abc', 'main.tex'), 'alt');
  fs.writeFileSync(path.join(h, 'index.json'), '{kaputt');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const l = history.list(root);
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].id, 'abc');
    assert.deepStrictEqual(l[0].files, ['main.tex']);
    assert.strictEqual(history.readSnapshotFile(root, 'abc', 'main.tex'), 'alt');
  } finally {
    console.warn = warn;
  }
  assert.ok(fs.readdirSync(h).some((f) => f.startsWith('index.json.corrupt-')), 'Sicherung fehlt');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'index.json'), 'utf8')).length, 1);
});

test('3: Datenordner-Schreibtest + Startabbruch', () => {
  const { dataDirError } = require('../server/lib/fsTree');
  assert.strictEqual(dataDirError(tmp()), null);
  const file = path.join(tmp(), 'kein-ordner');
  fs.writeFileSync(file, 'x');
  const msg = dataDirError(file);
  assert.match(msg, /nicht beschreibbar für uid .*sudo chown 1000:1000/);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, DATA_DIR: file, PORT: '0', DATA_KEY: '', VAULT_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /nicht beschreibbar für uid/);
});

test('4: ./x.tex und a//b.tex sind dasselbe Live-Dokument wie x.tex / a/b.tex', () => {
  const collab = require('../server/lib/collab');
  const { canonRel } = require('../server/lib/fsTree');
  assert.strictEqual(canonRel('./x.tex'), 'x.tex');
  assert.strictEqual(canonRel('a//b.tex'), 'a/b.tex');
  assert.strictEqual(canonRel('a/./c/../b.tex'), 'a/b.tex');
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'b.tex'), 'eins');
  collab.editText(root, 'a/b.tex', (t) => t + '+x');
  assert.strictEqual(collab.readText(root, 'a//b.tex'), 'eins+x');
  assert.strictEqual(collab.readText(root, './a/b.tex'), 'eins+x');
  assert.strictEqual(collab.getEpoch(root, 'a/b.tex'), collab.getEpoch(root, './a//b.tex'));
});
