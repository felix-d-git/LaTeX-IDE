// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Paket P4 (#33, #34): one absolute, normalized path per project/file - self-write
// detection and every per-root setting must not depend on how a root was spelled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-pfade-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Old install with relative DATA_DIR: relative root keys next to absolute ones (shares were always absolute).
const DATA = tmp();
const BASE = path.join(__dirname, '..');
const relA = 'data/projects/A';
const absA = path.resolve(BASE, relA);
fs.writeFileSync(path.join(DATA, 'workspace.json'), JSON.stringify({
  activeRootByUser: { u1: relA },
  recentRootsByUser: { u1: [relA, absA, 'data/projects/B'] },
  mainFileByRoot: { [relA]: 'thesis.tex', [absA]: 'main.tex' },
  settingsByRoot: { [relA]: { compiler: 'xelatex' }, [absA]: { compiler: 'pdflatex' } },
  compileTimesByRoot: { [relA]: [{ ms: 1, at: 1 }, { ms: 3, at: 3 }], [absA]: [{ ms: 2, at: 2 }] },
  sharesByRoot: { [absA]: ['u2'] },
}));
process.env.DATA_DIR = DATA;
const state = require('../server/state');

test('relative Projektpfade aus workspace.json werden einmalig absolut (#34)', () => {
  const ws = JSON.parse(fs.readFileSync(path.join(DATA, 'workspace.json'), 'utf8'));
  assert.strictEqual(ws.activeRootByUser.u1, absA);
  assert.deepStrictEqual(ws.recentRootsByUser.u1, [absA, path.resolve(BASE, 'data/projects/B')]);
  assert.strictEqual(ws.mainFileByRoot[absA], 'thesis.tex'); // relative (UI) entry wins
  assert.strictEqual(ws.settingsByRoot[absA].compiler, 'xelatex');
  assert.deepStrictEqual(ws.compileTimesByRoot[absA].map((e) => e.ms), [1, 2, 3]); // merged
  assert.deepStrictEqual(ws.sharesByRoot[absA], ['u2']);
  for (const k of ['mainFileByRoot', 'settingsByRoot', 'compileTimesByRoot']) {
    assert.ok(Object.keys(ws[k]).every((r) => path.isAbsolute(r)), k);
  }
});

test('Projektschlüssel unabhängig von der Schreibweise des Pfads (#34)', () => {
  const root = path.join(tmp(), 'P');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'doc.tex'), 'x');
  const odd = root + path.sep + '.' + path.sep; // trailing "./"
  state.setProjectSettings(odd, { compiler: 'lualatex' });
  state.setMainFile(path.relative(process.cwd(), root), 'doc.tex');
  state.setActiveRoot('u3', odd);
  assert.strictEqual(state.getProjectSettings(root).compiler, 'lualatex');
  assert.strictEqual(state.getMainFile(root), 'doc.tex');
  assert.strictEqual(state.getActiveRoot('u3'), root);
});

test('Selbstschreib-Erkennung nach absolutem Pfad: gleichnamige Datei in zwei Projekten (#33)', async () => {
  const { startWatcher } = require('../server/lib/watcher');
  const [a, b] = [path.join(tmp(), 'A'), path.join(tmp(), 'B')];
  for (const r of [a, b]) {
    fs.mkdirSync(r);
    fs.writeFileSync(path.join(r, 'main.tex'), 'Anfang\n');
  }
  const events = [];
  const w = startWatcher(a, (m) => events.push(m));
  test.after(() => w.close());
  await new Promise((r) => w.on('ready', r));

  // A persists its doc, 50 ms later B persists its own main.tex.
  const textA = 'Anfang\nSatz eins.\n';
  state.markSelfWrite(path.join(a, 'main.tex'), textA);
  fs.writeFileSync(path.join(a, 'main.tex'), textA);
  await new Promise((r) => setTimeout(r, 50));
  state.markSelfWrite(path.join(b, 'main.tex'), 'B-Text\n');
  fs.writeFileSync(path.join(b, 'main.tex'), 'B-Text\n');
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepStrictEqual(events.filter((m) => m.type === 'fileChanged'), []);

  // B's own echo is still recognized, and an entry is consumed only once.
  const h = (s) => crypto.createHash('sha1').update(s).digest('hex');
  assert.strictEqual(state.takeSelfWrite(path.join(b, '.', 'main.tex'), h('B-Text\n')), true);
  assert.strictEqual(state.takeSelfWrite(path.join(b, 'main.tex'), h('B-Text\n')), false);
});
