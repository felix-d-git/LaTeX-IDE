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

process.env.DATA_DIR = tmp();
const state = require('../server/state');

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
