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
        const buf = gone(() => fs.readFileSync(path.join(dir, r)));
        if (buf) out.set(r, sha1(buf));
      }
    }
  };
  walk('');
  return out;
}

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

// Emergency brake: more local deletions than this are not passed on to the server.
const MAX_REMOTE_DELETES = 10;
const MAX_REMOTE_DELETE_SHARE = 0.25;

// io: { manifest(), download(rel) -> Buffer, upload(rel, buf), remove(rel) }
async function syncFolder(dir, indexPath, io) {
  const man = await io.manifest();
  // Folder gone (deleted, other drive, new install with old data dir): start over like the first
  // sync - only download. With the old index every file would count as deleted locally.
  const index = fs.existsSync(dir) ? readJson(indexPath, {}) : {};
  const server = new Map(man.files.map((f) => [f.path, f.sha1]));
  const local = walkLocal(dir);
  const abs = (rel) => {
    const a = path.resolve(dir, rel);
    if (!a.startsWith(path.resolve(dir) + path.sep)) throw new Error('Ungültiger Pfad.');
    return a;
  };
  const write = (rel, buf) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), buf);
  };
  const plan = [...new Set([...server.keys(), ...local.keys(), ...Object.keys(index)])].map((rel) => {
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
  for (const { rel, s, l, act } of plan) {
    let got = s; // hash of what we now have locally = the next sync's base
    // Base = hash of the bytes actually written: the file may change between manifest and download.
    const pull = async () => {
      const buf = await io.download(rel);
      write(rel, buf);
      got = sha1(buf);
    };
    if (act === 'download') await pull();
    else if (act === 'deleteLocal') fs.rmSync(abs(rel), { force: true });
    else if (act === 'upload') await io.upload(rel, fs.readFileSync(abs(rel)));
    else if (act === 'deleteRemote') await io.remove(rel);
    else if (act === 'conflict') {
      const copy = conflictName(rel);
      const mine = fs.readFileSync(abs(rel));
      write(copy, mine);
      await io.upload(copy, mine);
      await pull();
      index[copy] = sha1(mine);
      conflicts.push(rel);
    }
    if (act === 'deleteLocal' || act === 'deleteRemote' || (act === 'same' && !s)) delete index[rel];
    else index[rel] = act === 'upload' ? l : got;
  }
  writeJson(indexPath, index);
  return { mainFile: man.mainFile, settings: man.settings || {}, projectId: man.projectId, conflicts, warning };
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

function moveDir(src, dst, names) {
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
  for (const n of todo) fs.rmSync(path.join(src, n), { recursive: true, force: true });
  return todo.length;
}

module.exports = { syncFolder, decide, conflictName, moveDir };

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
