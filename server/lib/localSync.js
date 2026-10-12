// Desktop offline copy: two-way sync of one project folder against the server,
// using the hash each file had at the last sync ("base") to tell who changed it.
//   only server changed -> download      only local changed -> upload
//   both changed        -> server keeps its version, the local one is kept
//                          next to it as "<name>.offline-konflikt.<ext>" (uploaded too)
// Text edited inside the IDE goes through Yjs (conflicts land in Review);
// such files are marked base = 'ide' and the server copy always wins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isIgnored } = require('./fsTree');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Only "gone in the meantime" (ENOENT) counts as absent. Any other read error (no
// permission, locked file, unplugged drive) must abort the sync: an unreadable file
// would otherwise look deleted and be deleted on the server.
function walkLocal(dir) {
  const out = new Map(); // rel -> sha1
  const gone = (e) => e.code === 'ENOENT';
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (e) {
      if (gone(e)) return;
      throw new Error(`Lokaler Ordner nicht lesbar (${e.code}): ${rel || '.'} - Sync abgebrochen.`);
    }
    for (const d of entries) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) {
        try {
          out.set(r, sha1(fs.readFileSync(path.join(dir, r))));
        } catch (e) {
          if (!gone(e)) throw new Error(`Lokale Datei nicht lesbar (${e.code}): ${r} - Sync abgebrochen.`);
        }
      }
    }
  };
  walk('');
  return out;
}

// macOS/Windows: "Kapitel.tex" and "kapitel.tex" are the same file. Probe the folder
// itself; a name without letters falls back to the platform default.
function caseInsensitive(dir) {
  const base = path.basename(dir);
  const flipped = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase();
  if (flipped === base) return process.platform === 'win32' || process.platform === 'darwin';
  return fs.existsSync(path.join(path.dirname(dir), flipped));
}
const fold = (rel) => rel.normalize('NFC').toLowerCase();

// More remote deletions than this in one run look like a lost or emptied local folder,
// not like intended work: they are held back and reported instead.
const tooManyRemoteDeletes = (n, serverFiles) => n >= 5 && n * 3 >= serverFiles;

function conflictName(rel) {
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)}.offline-konflikt${ext}`;
}

// Pure decision per file - kept separate so it can be checked without a server.
function decide(s, l, b) {
  if (s === l) return 'same';
  if (b === 'ide') return s ? 'download' : 'deleteLocal';
  if (l === b) return s ? 'download' : 'deleteLocal';
  if (s === b) return l ? 'upload' : 'deleteRemote';
  if (!s) return 'upload'; // deleted on server, changed locally -> keep the local work
  if (!l) return 'download'; // deleted locally, changed on server -> keep the server work
  return 'conflict';
}

// io: { manifest(), download(rel) -> Buffer, upload(rel, buf), remove(rel) }
// Returns { ..., conflicts, skipped, heldBack } - skipped: names that differ only in case on
// the server (cannot both exist here), heldBack: remote deletions stopped by the safety limit.
async function syncFolder(dir, indexPath, io) {
  const man = await io.manifest();
  let index = readJson(indexPath, {});
  const server = new Map(man.files.map((f) => [f.path, f.sha1]));
  // Missing folder (deleted, other disk, new install) = start over: download only. Its old
  // index would turn every file into a remote deletion.
  if (!fs.existsSync(dir)) index = {};
  fs.mkdirSync(dir, { recursive: true });
  let local = walkLocal(dir);
  if (!local.size && Object.keys(index).length) index = {}; // emptied folder: same as missing

  // Case-insensitive disk: use the server's spelling for local and index paths, so a rename
  // that only changes case is "same" instead of download + delete of the same file.
  const clash = new Set();
  if (caseInsensitive(dir)) {
    const canon = new Map();
    for (const rel of server.keys()) {
      if (canon.has(fold(rel))) clash.add(fold(rel));
      else canon.set(fold(rel), rel);
    }
    const rekey = (rel) => (clash.has(fold(rel)) ? rel : canon.get(fold(rel)) || rel);
    local = new Map([...local].map(([rel, h]) => [rekey(rel), h]));
    for (const rel of Object.keys(index)) {
      const to = rekey(rel);
      if (to === rel) continue;
      if (!(to in index)) index[to] = index[rel];
      delete index[rel];
    }
  }
  const abs = (rel) => {
    const a = path.resolve(dir, rel);
    if (!a.startsWith(path.resolve(dir) + path.sep)) throw new Error('Ungültiger Pfad.');
    return a;
  };
  const write = (rel, buf) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), buf);
  };
  const conflicts = [];
  const skipped = [];
  const plan = [];
  for (const rel of new Set([...server.keys(), ...local.keys(), ...Object.keys(index)])) {
    if (clash.has(fold(rel))) {
      skipped.push(rel);
      continue;
    }
    const s = server.get(rel) || null;
    const l = local.get(rel) || null;
    plan.push({ rel, s, l, act: decide(s, l, index[rel]) });
  }
  const deletes = plan.filter((p) => p.act === 'deleteRemote');
  const heldBack = tooManyRemoteDeletes(deletes.length, server.size) ? deletes.map((p) => p.rel) : [];

  // The index stores the hash of the bytes actually written: the server file may have
  // changed between manifest and download (live editing), which must not look like a
  // local change next time.
  const pull = async (rel) => {
    const buf = await io.download(rel);
    write(rel, buf);
    return sha1(buf);
  };
  for (const { rel, s, l, act } of plan) {
    if (heldBack.includes(rel)) continue; // index entry stays: asked again next run
    let base = act === 'upload' ? l : s;
    if (act === 'download') base = await pull(rel);
    else if (act === 'deleteLocal') fs.rmSync(abs(rel), { force: true });
    else if (act === 'upload') await io.upload(rel, fs.readFileSync(abs(rel)));
    else if (act === 'deleteRemote') await io.remove(rel);
    else if (act === 'conflict') {
      const copy = conflictName(rel);
      const mine = fs.readFileSync(abs(rel));
      write(copy, mine);
      await io.upload(copy, mine);
      base = await pull(rel);
      index[copy] = sha1(mine);
      conflicts.push(rel);
    }
    if (act === 'deleteLocal' || act === 'deleteRemote' || (act === 'same' && !s)) delete index[rel];
    else index[rel] = base;
  }
  writeJson(indexPath, index);
  return { mainFile: man.mainFile, settings: man.settings || {}, projectId: man.projectId, conflicts, skipped, heldBack };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Moves the named project folders from src to dst: copy, compare file count + bytes, then delete
// the originals. A failed check removes the copy and throws - the originals stay untouched.
function treeStat(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// Step 1 of a move: copy + verify. On failure the copies are removed and the originals stay.
// The caller switches to dst BEFORE removeDirs: if deleting the originals then fails halfway,
// the sync must not see a half-empty old folder (it would delete those files on the server).
function copyDirs(src, dst, names) {
  const todo = names.filter((n) => fs.existsSync(path.join(src, n)));
  fs.mkdirSync(dst, { recursive: true });
  try {
    for (const n of todo) {
      fs.cpSync(path.join(src, n), path.join(dst, n), { recursive: true });
      const a = treeStat(path.join(src, n));
      const b = treeStat(path.join(dst, n));
      if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`Kopie von "${n}" unvollständig (${b.files}/${a.files} Dateien) - nichts gelöscht.`);
    }
  } catch (e) {
    for (const n of todo) fs.rmSync(path.join(dst, n), { recursive: true, force: true });
    throw e;
  }
  return todo;
}

// Step 2: delete the originals. Never throws; returns the names that could not be removed
// completely (e.g. a file still open in another program on Windows).
function removeDirs(src, names) {
  const left = [];
  for (const n of names) {
    try {
      fs.rmSync(path.join(src, n), { recursive: true, force: true });
    } catch (e) {
      left.push(`${n} (${e.code || e.message})`);
    }
  }
  return left;
}

module.exports = { syncFolder, decide, conflictName, copyDirs, removeDirs, caseInsensitive };

if (require.main === module) {
  const assert = require('assert');
  assert.equal(decide('a', 'a', 'x'), 'same');
  assert.equal(decide('b', 'a', 'a'), 'download');
  assert.equal(decide('a', 'b', 'a'), 'upload');
  assert.equal(decide(null, 'a', 'a'), 'deleteLocal');
  assert.equal(decide('a', null, 'a'), 'deleteRemote');
  assert.equal(decide('b', 'c', 'a'), 'conflict');
  assert.equal(decide('b', 'c', 'ide'), 'download');
  assert.equal(decide('b', 'c', undefined), 'conflict');
  assert.equal(decide('b', null, undefined), 'download');
  assert.equal(decide(null, 'c', undefined), 'upload');
  assert.equal(conflictName('kap/a.tex'), 'kap/a.offline-konflikt.tex');

  // syncFolder against an in-memory server (node server/lib/localSync.js).
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localsync-'));
  const dir = path.join(tmp, 'Thesis');
  const idx = path.join(tmp, 'index.json');
  const files = new Map(); // server: rel -> Buffer
  const removed = [];
  let onDownload = null;
  const io = {
    manifest: async () => ({ files: [...files].map(([p, b]) => ({ path: p, sha1: sha1(b) })) }),
    download: async (rel) => {
      if (onDownload) onDownload(rel);
      return files.get(rel);
    },
    upload: async (rel, buf) => files.set(rel, buf),
    remove: async (rel) => (removed.push(rel), files.delete(rel)),
  };
  const put = (rel, text) => files.set(rel, Buffer.from(text));
  (async () => {
    for (let i = 0; i < 9; i++) put(`kap/k${i}.tex`, `Kapitel ${i}`);
    put('main.tex', 'main');
    await syncFolder(dir, idx, io);
    assert.equal(fs.readFileSync(path.join(dir, 'kap/k3.tex'), 'utf8'), 'Kapitel 3');

    // Lost local folder: download again, delete nothing on the server.
    fs.rmSync(dir, { recursive: true });
    await syncFolder(dir, idx, io);
    assert.deepEqual(removed, []);
    assert.equal(files.size, 10);
    assert.ok(fs.existsSync(path.join(dir, 'main.tex')));

    // Emptied local folder: same.
    for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true });
    await syncFolder(dir, idx, io);
    assert.deepEqual(removed, []);

    // One deliberate local deletion still reaches the server.
    fs.rmSync(path.join(dir, 'kap/k8.tex'));
    await syncFolder(dir, idx, io);
    assert.deepEqual(removed, ['kap/k8.tex']);

    // Many at once are held back and asked again next time; the server keeps the files.
    for (let i = 0; i < 6; i++) fs.rmSync(path.join(dir, `kap/k${i}.tex`));
    let r = await syncFolder(dir, idx, io);
    assert.equal(r.heldBack.length, 6);
    assert.deepEqual(removed, ['kap/k8.tex']);
    r = await syncFolder(dir, idx, io);
    assert.equal(r.heldBack.length, 6);
    for (let i = 0; i < 6; i++) put(`kap/k${i}.tex`, `Kapitel ${i}`);
    fs.rmSync(dir, { recursive: true });
    await syncFolder(dir, idx, io);

    // Unreadable subfolder: abort, delete nothing.
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      fs.chmodSync(path.join(dir, 'kap'), 0o000);
      await assert.rejects(syncFolder(dir, idx, io), /nicht lesbar/);
      fs.chmodSync(path.join(dir, 'kap'), 0o755);
      assert.deepEqual(removed, ['kap/k8.tex']);
    }

    // Server file changes between manifest and download (live editing): no false conflict.
    put('main.tex', 'main v2');
    onDownload = (rel) => rel === 'main.tex' && put('main.tex', 'main v3');
    await syncFolder(dir, idx, io);
    onDownload = null;
    put('main.tex', 'main v4');
    r = await syncFolder(dir, idx, io);
    assert.deepEqual(r.conflicts, []);
    assert.equal(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), 'main v4');

    // Case-only rename on the server (case-insensitive disk only): the file survives everywhere.
    if (caseInsensitive(dir)) {
      put('Kap/k0.tex', files.get('kap/k0.tex').toString());
      files.delete('kap/k0.tex');
      for (let i = 0; i < 3; i++) await syncFolder(dir, idx, io);
      assert.ok(files.has('Kap/k0.tex'));
      assert.ok(fs.existsSync(path.join(dir, 'Kap/k0.tex')));
      assert.deepEqual(removed, ['kap/k8.tex']);
    }
    fs.rmSync(tmp, { recursive: true });
    console.log('localSync ok');
  })().catch((e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
  });
}
