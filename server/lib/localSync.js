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

function walkLocal(dir) {
  const out = new Map(); // rel -> sha1
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.set(r, sha1(fs.readFileSync(path.join(dir, r))));
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

// io: { manifest(), download(rel) -> Buffer, upload(rel, buf), remove(rel) }
async function syncFolder(dir, indexPath, io) {
  const man = await io.manifest();
  const index = readJson(indexPath, {});
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
  const conflicts = [];
  for (const rel of new Set([...server.keys(), ...local.keys(), ...Object.keys(index)])) {
    const s = server.get(rel) || null;
    const l = local.get(rel) || null;
    const act = decide(s, l, index[rel]);
    if (act === 'download') write(rel, await io.download(rel));
    else if (act === 'deleteLocal') fs.rmSync(abs(rel), { force: true });
    else if (act === 'upload') await io.upload(rel, fs.readFileSync(abs(rel)));
    else if (act === 'deleteRemote') await io.remove(rel);
    else if (act === 'conflict') {
      const copy = conflictName(rel);
      const mine = fs.readFileSync(abs(rel));
      write(copy, mine);
      await io.upload(copy, mine);
      write(rel, await io.download(rel));
      index[copy] = sha1(mine);
      conflicts.push(rel);
    }
    if (act === 'deleteLocal' || act === 'deleteRemote' || (act === 'same' && !s)) delete index[rel];
    else index[rel] = act === 'upload' ? l : s;
  }
  writeJson(indexPath, index);
  return { mainFile: man.mainFile, settings: man.settings || {}, projectId: man.projectId, conflicts };
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

module.exports = { syncFolder, decide, conflictName };

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
