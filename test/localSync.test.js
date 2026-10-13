// Desktop offline sync (server/lib/localSync.js) against a mock server, local side in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { syncFolder, moveDir } = require('../server/lib/localSync');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sync-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// files: rel -> content. caseInsensitive is passed through to syncFolder.
function mockServer(files, extra = {}) {
  const srv = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const io = {
    srv,
    removed: [],
    uploaded: [],
    manifest: async () => ({ projectId: 'p', mainFile: 'main.tex', files: [...srv].map(([p, b]) => ({ path: p, sha1: sha1(b) })) }),
    download: async (rel) => srv.get(rel),
    upload: async (rel, buf) => {
      io.uploaded.push(rel);
      srv.set(rel, Buffer.from(buf));
    },
    remove: async (rel) => {
      io.removed.push(rel);
      srv.delete(rel);
    },
    ...extra,
  };
  return io;
}

async function setup(files, extra) {
  const base = tmp();
  const dir = path.join(base, 'Thesis');
  const index = path.join(base, 'sync', 'p.json');
  const io = mockServer(files, extra);
  await syncFolder(dir, index, io);
  return { base, dir, index, io };
}

test('fehlender Projektordner: nichts auf dem Server löschen, neu herunterladen (#28)', async () => {
  const { dir, index, io } = await setup({ 'main.tex': 'x', 'kap/a.tex': 'a', 'bild.png': 'png' });
  fs.rmSync(dir, { recursive: true, force: true });
  await syncFolder(dir, index, io);
  assert.deepStrictEqual(io.removed, []);
  assert.strictEqual(io.srv.size, 3);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'kap/a.tex'), 'utf8'), 'a');
});

test('Lesefehler im lokalen Ordner bricht den Sync ab, ohne zu löschen (#28)', async () => {
  const { dir, index, io } = await setup({ 'main.tex': 'x', 'kap/a.tex': 'a', 'kap/b.tex': 'b' });
  const orig = fs.readdirSync;
  fs.readdirSync = (p, ...rest) => {
    if (path.basename(String(p)) === 'kap') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return orig(p, ...rest);
  };
  try {
    await assert.rejects(syncFolder(dir, index, io), /EACCES/);
  } finally {
    fs.readdirSync = orig;
  }
  assert.deepStrictEqual(io.removed, []);
  assert.strictEqual(io.srv.size, 3);
});

test('Notbremse: viele lokal fehlende Dateien werden nicht auf dem Server gelöscht (#28)', async () => {
  const files = { 'main.tex': 'x' };
  for (let i = 0; i < 12; i++) files[`fig/${i}.png`] = `p${i}`;
  const { dir, index, io } = await setup(files);
  fs.rmSync(path.join(dir, 'fig'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fig')); // folder still there, only emptied
  const r = await syncFolder(dir, index, io);
  assert.deepStrictEqual(io.removed, []);
  assert.strictEqual(io.srv.size, 13);
  assert.match(r.warning, /12/);
  assert.ok(fs.existsSync(path.join(dir, 'fig/3.png')), 'fehlende Dateien wieder geholt');
});

test('Notbremse greift nicht bei einer einzelnen bewussten Löschung (#28)', async () => {
  const { dir, index, io } = await setup({ 'main.tex': 'x', 'alt.tex': 'a', 'b.tex': 'b' });
  fs.rmSync(path.join(dir, 'alt.tex'));
  const r = await syncFolder(dir, index, io);
  assert.deepStrictEqual(io.removed, ['alt.tex']);
  assert.ok(!r.warning);
});

test('Änderung zwischen Manifest und Download erzeugt keinen Scheinkonflikt (#48)', async () => {
  const base = tmp();
  const dir = path.join(base, 'Thesis');
  const index = path.join(base, 'sync', 'p.json');
  const io = mockServer({ 'main.tex': 's1' });
  // Someone types right after the manifest: the download already returns s2.
  const man = io.manifest;
  io.manifest = async () => {
    const m = await man();
    io.srv.set('main.tex', Buffer.from('s2'));
    return m;
  };
  await syncFolder(dir, index, io);
  io.manifest = man;
  io.srv.set('main.tex', Buffer.from('s3'));
  const r = await syncFolder(dir, index, io);
  assert.deepStrictEqual(r.conflicts, []);
  assert.deepStrictEqual(io.uploaded, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), 's3');
});

test('Umbenennen nur in Groß-/Kleinschreibung löscht nichts (#47)', async () => {
  const { dir, index, io } = await setup({ 'main.tex': 'x', 'kapitel1.tex': 'k', 'kap/a.tex': 'a' }, { caseInsensitive: true });
  // Web-IDE on a case-sensitive server renames file and folder.
  io.srv.set('Kapitel1.tex', io.srv.get('kapitel1.tex'));
  io.srv.delete('kapitel1.tex');
  io.srv.set('Kap/a.tex', io.srv.get('kap/a.tex'));
  io.srv.delete('kap/a.tex');
  for (let i = 0; i < 3; i++) await syncFolder(dir, index, io);
  assert.deepStrictEqual(io.removed, []);
  assert.deepStrictEqual([...io.srv.keys()].sort(), ['Kap/a.tex', 'Kapitel1.tex', 'main.tex']);
  const names = fs.readdirSync(dir).map((n) => n.toLowerCase());
  assert.ok(names.includes('kapitel1.tex'));
  // Changes after the rename still sync both ways.
  io.srv.set('Kapitel1.tex', Buffer.from('neu'));
  await syncFolder(dir, index, io);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'kapitel1.tex'), 'utf8'), 'neu');
});

test('Paar a.tex/A.tex auf dem Server wird übersprungen statt gelöscht (#47)', async () => {
  const { dir, index, io } = await setup({ 'main.tex': 'x', 'a.tex': 'klein' }, { caseInsensitive: true });
  io.srv.set('A.tex', Buffer.from('groß'));
  const r = await syncFolder(dir, index, io);
  await syncFolder(dir, index, io);
  assert.deepStrictEqual(io.removed, []);
  assert.deepStrictEqual(io.uploaded, []);
  assert.deepStrictEqual(r.skipped.sort(), ['A.tex', 'a.tex']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.tex'), 'utf8'), 'klein');
});
