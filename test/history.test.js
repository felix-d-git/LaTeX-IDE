// Paket P7 (#37): version history must not grow without bound - content-addressed
// blobs, autocompile throttled like autosave, retention with a hard cap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../server/lib/history');

const H = '.latex-ide-history';

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-hist-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}

const index = (root) => JSON.parse(fs.readFileSync(path.join(root, H, 'index.json'), 'utf8'));
const blobCount = (root) => fs.readdirSync(path.join(root, H, 'blobs')).length;

test('Snapshots speichern jeden Inhalt nur einmal, identische Stände nicht doppelt (#37)', () => {
  const chapters = {};
  for (let i = 0; i < 20; i++) chapters[`kap/k${i}.tex`] = `Kapitel ${i}\n`.repeat(500);
  const root = project({ 'main.tex': 'v0', ...chapters });
  for (let i = 1; i <= 30; i++) {
    fs.writeFileSync(path.join(root, 'main.tex'), `v${i}`);
    assert.ok(history.snapshot(root, { trigger: 'compile' }));
    assert.strictEqual(history.snapshot(root, { trigger: 'compile' }), null, 'identischer Stand');
  }
  assert.strictEqual(index(root).length, 30);
  assert.strictEqual(blobCount(root), 20 + 30); // 20 unchanged chapters once + one per main.tex version
  const [newest, older] = history.list(root);
  assert.strictEqual(history.readSnapshotFile(root, older.id, 'main.tex'), 'v29');
  assert.strictEqual(history.readSnapshotFile(root, newest.id, 'kap/k3.tex'), chapters['kap/k3.tex']);
  assert.strictEqual(history.readSnapshotBuffer(root, newest.id, 'fehlt.tex'), null);
  assert.deepStrictEqual(history.diffBetween(root, older.id, newest.id, 'main.tex').map((p) => [!!p.added, !!p.removed, p.value]),
    [[false, true, 'v29'], [true, false, 'v30']]);
});

test('Autocompile wird wie Autosave gedrosselt, manuelles Kompilieren nicht (#37)', () => {
  const root = project({ 'main.tex': 'a' });
  assert.ok(history.snapshot(root, { trigger: 'autocompile' }));
  fs.writeFileSync(path.join(root, 'main.tex'), 'b');
  assert.strictEqual(history.snapshot(root, { trigger: 'autocompile' }), null);
  assert.strictEqual(history.snapshot(root, { trigger: 'autosave' }), null);
  assert.ok(history.snapshot(root, { trigger: 'compile' }));
});

test('Alte Snapshots (Vollkopie ohne hashes) bleiben lesbar und vergleichbar (#37)', () => {
  const root = project({ 'main.tex': 'alt' });
  const snap = path.join(root, H, 'snapshots', 'old1');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'main.tex'), 'alt');
  fs.writeFileSync(path.join(root, H, 'index.json'), JSON.stringify([
    { id: 'old1', createdAt: new Date(Date.now() - 3600e3).toISOString(), label: null, trigger: 'compile', files: ['main.tex'] },
  ]));
  assert.strictEqual(history.readSnapshotFile(root, 'old1', 'main.tex'), 'alt');
  assert.strictEqual(history.snapshot(root, { trigger: 'compile' }), null, 'gleicher Inhalt wie der Legacy-Snapshot');
  fs.writeFileSync(path.join(root, 'main.tex'), 'neu');
  assert.ok(history.snapshot(root, { trigger: 'compile' }).hashes);
});

test('Ausdünnen: 24 h alles, bis 7 Tage stündlich, danach täglich, Obergrenze; Label/restore bleiben (#37)', () => {
  const now = Date.UTC(2026, 9, 13, 12);
  const at = (msAgo, extra = {}) => ({ id: `e${msAgo}`, createdAt: new Date(now - msAgo).toISOString(), label: null, trigger: 'compile', files: [], ...extra });
  const min = 60e3;
  const hour = 60 * min;
  const day = 24 * hour;
  const entries = [
    at(30 * day + 5 * min, { label: 'Abgabe' }),
    at(30 * day + 4 * min, { trigger: 'restore' }),
    at(10 * day + 2 * hour), at(10 * day + 1 * hour), // same day -> newest stays
    at(3 * day + 50 * min), at(3 * day + 10 * min), // same hour -> newest stays
    at(3 * day - 2 * hour),
    at(2 * hour), at(2 * hour - min), at(min), // < 24 h: all
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const kept = history.retained(entries, now).map((e) => e.id);
  assert.deepStrictEqual(kept, [
    `e${30 * day + 5 * min}`, `e${30 * day + 4 * min}`,
    `e${10 * day + 1 * hour}`,
    `e${3 * day + 10 * min}`, `e${3 * day - 2 * hour}`,
    `e${2 * hour}`, `e${2 * hour - min}`, `e${min}`,
  ]);

  const many = [];
  for (let i = 0; i < history.MAX_ENTRIES + 50; i++) many.push(at((history.MAX_ENTRIES + 50 - i) * 1000));
  many.unshift(at(day / 2, { label: 'x' }));
  many.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const capped = history.retained(many, now);
  assert.strictEqual(capped.filter((e) => !e.label).length, history.MAX_ENTRIES);
  assert.ok(capped.some((e) => e.label === 'x'));
  assert.strictEqual(capped[capped.length - 1], many[many.length - 1], 'neuester Stand bleibt');
});

test('prune löscht nicht mehr referenzierte Blobs und Legacy-Ordner (#37)', () => {
  const root = project({ 'main.tex': 'a' });
  const old = history.snapshot(root, { trigger: 'compile' });
  fs.writeFileSync(path.join(root, 'main.tex'), 'b');
  history.snapshot(root, { trigger: 'compile' });
  fs.mkdirSync(path.join(root, H, 'snapshots', 'weg'), { recursive: true });
  // Push the first entry 30 days back -> thinned out together with its blob.
  const idx = index(root);
  idx[0].createdAt = new Date(Date.now() - 30 * 864e5).toISOString();
  idx.unshift({ ...idx[0], id: 'zweiter', createdAt: new Date(Date.now() - 30 * 864e5 + 1000).toISOString() });
  fs.writeFileSync(path.join(root, H, 'index.json'), JSON.stringify(idx.sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
  history.prune(root);
  const ids = index(root).map((e) => e.id);
  assert.ok(!ids.includes(old.id) && ids.includes('zweiter'));
  assert.strictEqual(blobCount(root), 2, 'Blob von "a" bleibt, weil "zweiter" ihn noch nutzt');
  assert.ok(!fs.existsSync(path.join(root, H, 'snapshots', 'weg')));
  assert.ok(!fs.readdirSync(path.join(root, H)).some((f) => f.endsWith('.tmp')));
});
