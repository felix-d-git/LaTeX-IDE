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
