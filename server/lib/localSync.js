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

// Only "vanished while walking" (ENOENT) is tolerated. Any other read error throws and aborts the
// sync: a file we could not see would otherwise count as deleted locally and be deleted on the server.
// Hashes by (path, size, mtime): unchanged files are not read again on every run.
const hashCache = new Map(); // abs -> { size, mtimeMs, sha1 }

function walkLocal(dir) {
  const out = new Map(); // rel -> sha1
  const gone = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const walk = (rel) => {
    const entries = gone(() => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) || [];
    for (const d of entries) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) {
        const abs = path.join(dir, r);
        const st = gone(() => fs.statSync(abs));
        if (!st) continue;
        const c = hashCache.get(abs);
        if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) {
          out.set(r, c.sha1);
          continue;
        }
        const buf = gone(() => fs.readFileSync(abs));
        if (!buf) continue;
        const h = sha1(buf);
        hashCache.set(abs, { size: buf.length, mtimeMs: st.mtimeMs, sha1: h });
        out.set(r, h);
      }
    }
  };
  walk('');
  return out;
}

// taken(name) -> true if that name already exists (locally or on the server): a second conflict
// on the same file gets a counter instead of overwriting the first conflict copy.
function conflictName(rel, taken = () => false) {
  const ext = path.posix.extname(rel);
  const base = `${rel.slice(0, rel.length - ext.length)}.offline-konflikt`;
  let name = `${base}${ext}`;
  for (let n = 2; taken(name); n++) name = `${base}-${n}${ext}`;
  return name;
}

// Windows/macOS folders usually ignore case: "Kapitel1.tex" and "kapitel1.tex" are one file there.
function caseInsensitive(dir) {
  return dir.toUpperCase() !== dir.toLowerCase() && fs.existsSync(dir.toUpperCase()) && fs.existsSync(dir.toLowerCase());
}
const fold = (rel) => rel.normalize('NFC').toLowerCase();

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

// Emergency brake: more local deletions than this are not passed on to the server.
const MAX_REMOTE_DELETES = 10;
const MAX_REMOTE_DELETE_SHARE = 0.25;

// io: { manifest(), download(rel) -> Buffer, upload(rel, buf, base), remove(rel, base), caseInsensitive? (tests) }
// base = hash the server had in the manifest ('none' = no such file): the server answers 409
// (err.status) if the file changed since - treated like a conflict, nothing is overwritten.
async function syncFolder(dir, indexPath, io) {
  const man = await io.manifest();
  // Folder gone (deleted, other drive, new install with old data dir): start over like the first
  // sync - only download. With the old index every file would count as deleted locally.
  const index = fs.existsSync(dir) ? readJson(indexPath, {}) : {};
  fs.mkdirSync(dir, { recursive: true });
  const server = new Map(man.files.map((f) => [f.path, f.sha1]));
  let local = walkLocal(dir);
  // Case-insensitive folder: map local and index paths onto the server's spelling, so a rename
  // that only changes case is 'same' instead of download + deleteLocal (= the same file) and
  // then deleteRemote. Server names that collide after folding (a.tex/A.tex) are skipped.
  const clash = new Set();
  if (io.caseInsensitive ?? caseInsensitive(dir)) {
    const canon = new Map();
    for (const rel of server.keys()) {
      if (canon.has(fold(rel))) clash.add(fold(rel));
      else canon.set(fold(rel), rel);
    }
    const rekey = (rel) => (clash.has(fold(rel)) ? rel : canon.get(fold(rel)) || rel);
    local = new Map([...local].map(([r, h]) => [rekey(r), h]));
    for (const r of Object.keys(index)) {
      const w = rekey(r);
      if (w === r) continue;
      index[w] ??= index[r];
      delete index[r];
    }
  }
  const skipped = [];
  const abs = (rel) => {
    const a = path.resolve(dir, rel);
    if (!a.startsWith(path.resolve(dir) + path.sep)) throw new Error('Ungültiger Pfad.');
    return a;
  };
  const write = (rel, buf) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), buf);
  };
  const all = [...new Set([...server.keys(), ...local.keys(), ...Object.keys(index)])];
  for (const rel of all) if (clash.has(fold(rel))) skipped.push(rel);
  const plan = all.filter((rel) => !clash.has(fold(rel))).map((rel) => {
    const s = server.get(rel) || null;
    const l = local.get(rel) || null;
    return { rel, s, l, act: decide(s, l, index[rel]) };
  });
  // Many files missing locally at once looks like a broken/emptied folder, not intent:
  // fetch them again instead of deleting them on the server for every member.
  const dels = plan.filter((x) => x.act === 'deleteRemote');
  let warning = null;
  if (dels.length > MAX_REMOTE_DELETES || (dels.length > 1 && dels.length > server.size * MAX_REMOTE_DELETE_SHARE)) {
    for (const x of dels) x.act = 'download';
    warning = `${dels.length} Dateien fehlten in der lokalen Kopie. Sie wurden nicht auf dem Server gelöscht, sondern neu heruntergeladen. Absichtlich gelöscht? Dann bitte im Web-IDE löschen.`;
  }
  const conflicts = [];
  const errors = [];
  for (const { rel, s, l, act } of plan) {
    try {
    let act2 = act;
    let got = s; // hash of what we now have locally = the next sync's base
    // Base = hash of the bytes actually written: the file may change between manifest and download.
    const pull = async () => {
      const buf = await io.download(rel);
      write(rel, buf);
      got = sha1(buf);
    };
    if (act === 'download') await pull();
    else if (act === 'deleteLocal') fs.rmSync(abs(rel), { force: true });
    else if (act === 'upload') {
      try {
        await io.upload(rel, fs.readFileSync(abs(rel)), s || 'none');
      } catch (e) {
        if (e.status !== 409) throw e;
        act2 = 'conflict'; // server changed since the manifest: keep both
      }
    } else if (act === 'deleteRemote') await io.remove(rel, s);
    if (act2 === 'conflict') {
      const copy = conflictName(rel, (n) => server.has(n) || local.has(n) || index[n] !== undefined || fs.existsSync(abs(n)));
      const mine = fs.readFileSync(abs(rel));
      write(copy, mine);
      await io.upload(copy, mine, 'none');
      await pull();
      index[copy] = sha1(mine);
      conflicts.push(rel);
    }
    if (act === 'deleteLocal' || act === 'deleteRemote' || (act === 'same' && !s)) delete index[rel];
    else index[rel] = act2 === 'upload' ? l : got;
    } catch (e) {
      if (e.fatal) throw e; // server unreachable: abort like before
      errors.push(`${rel}: ${e.message}`); // index entry of this file stays as it was
    }
  }
  writeJson(indexPath, index);
  return { mainFile: man.mainFile, settings: man.settings || {}, projectId: man.projectId, conflicts, warning, skipped, errors };
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

// Moves the named project folders from src to dst in two phases:
// 1) copy + compare file count and bytes, then commit() switches the app to dst. A failure up to
//    here removes the copy and throws - the originals stay untouched and in use.
// 2) delete the originals. Failures (file open in a viewer: EBUSY/EPERM) are only collected:
//    the app no longer looks there, so a half-deleted old folder can't trigger server deletes.
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

function moveDir(src, dst, names, commit) {
  const todo = names.filter((n) => fs.existsSync(path.join(src, n)));
  fs.mkdirSync(dst, { recursive: true });
  try {
    for (const n of todo) {
      fs.cpSync(path.join(src, n), path.join(dst, n), { recursive: true });
      const a = treeStat(path.join(src, n));
      const b = treeStat(path.join(dst, n));
      if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`Kopie von "${n}" unvollständig (${b.files}/${a.files} Dateien) - nichts gelöscht.`);
    }
    commit();
  } catch (e) {
    for (const n of todo) fs.rmSync(path.join(dst, n), { recursive: true, force: true });
    throw e;
  }
  const failed = [];
  for (const n of todo) {
    try {
      fs.rmSync(path.join(src, n), { recursive: true, force: true });
    } catch {
      failed.push(n);
    }
  }
  return { moved: todo.length, failed };
}

module.exports = { syncFolder, walkLocal, decide, conflictName, moveDir, sha1 };

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
  console.log('localSync ok');
}
