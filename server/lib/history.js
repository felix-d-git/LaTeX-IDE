const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diffLines } = require('diff');
const { isIgnored, isTextFile } = require('./fsTree');

const HISTORY_DIR = '.latex-ide-history';
const INDEX_FILE = 'index.json';
const SNAPSHOTS_DIR = 'snapshots'; // legacy: full copy per snapshot (entries without `hashes`)
const BLOBS_DIR = 'blobs'; // content-addressed: blobs/<sha1>, each content stored once

// Autosave- and autocompile-triggered snapshots are taken at most this often
// per project, so a burst of keystroke-driven saves (each one an autocompile
// when that's on) doesn't create one version per save. A manual "Kompilieren"
// always bypasses this - it's an infrequent, deliberate checkpoint.
const AUTOSAVE_COOLDOWN_MS = 3 * 60 * 1000;
const THROTTLED = new Set(['autosave', 'autocompile']);

// Retention (prune): last 24 h everything, up to 7 days one per hour, then one
// per day; hard cap MAX_ENTRIES. Labelled and 'restore' entries are always kept
// and don't count against it.
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_ENTRIES = 500;
const PRUNE_EVERY_MS = HOUR;
const lastPruneAt = new Map(); // root -> timestamp

function historyRoot(root) {
  return path.join(root, HISTORY_DIR);
}

function indexPath(root) {
  return path.join(historyRoot(root), INDEX_FILE);
}

function loadIndex(root) {
  const p = indexPath(root);
  if (!fs.existsSync(p)) return [];
  try {
    const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(idx)) throw new Error('kein Array');
    return idx;
  } catch (e) {
    // Keep the broken file (like comments.js) and rebuild from what is still on disk, never silently "empty".
    try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch (_) {}
    const entries = rebuildIndex(root);
    try { saveIndex(root, entries); } catch (_) {}
    console.warn(`[history] Verlaufsindex defekt, aus snapshots/ neu aufgebaut (${entries.length} Versionen): ${root}`);
    return entries;
  }
}

// Only legacy snapshots/<id>/ folders survive without the index (blobs carry no file names).
function rebuildIndex(root) {
  const dir = path.join(historyRoot(root), SNAPSHOTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const abs = path.join(dir, d.name);
    out.push({ id: d.name, createdAt: fs.statSync(abs).mtime.toISOString(), label: null, trigger: 'recovered', files: walkTextFiles(abs) });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// tmp + rename: a full disk must not leave a truncated index (= empty history).
function writeAtomic(abs, data) {
  const tmp = `${abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function saveIndex(root, entries) {
  fs.mkdirSync(historyRoot(root), { recursive: true });
  writeAtomic(indexPath(root), JSON.stringify(entries));
}

function isRegularFile(abs) {
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  return !!st && st.isFile();
}

function walkTextFiles(root, relDir = '', out = []) {
  const absDir = path.join(root, relDir);
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const relPath = path.join(relDir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      walkTextFiles(root, relPath, out);
    } else if (isTextFile(relPath) && (entry.isFile() || (entry.isSymbolicLink() && isRegularFile(path.join(root, relPath))))) {
      // Dangling symlinks (e.g. Emacs lock files .#main.tex) can't be copied.
      out.push(relPath);
    }
  }
  return out;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Bytes, not decoded text: two Latin-1 files differing in an umlaut decode to the same U+FFFD.
function sameFiles(root, prev, current) {
  const files = Object.keys(current);
  if (prev.files.length !== files.length || prev.files.some((f, i) => f !== files[i])) return false;
  if (prev.hashes) return files.every((f) => prev.hashes[f] === current[f].hash);
  try {
    return files.every((f) => {
      const old = readSnapshotBuffer(root, prev.id, f, prev);
      return !!old && old.equals(current[f].buf);
    });
  } catch (e) {
    return false; // unreadable -> treat as changed
  }
}

function snapshot(root, { label = null, trigger = 'autosave' } = {}) {
  const entries = loadIndex(root);
  const prev = entries[entries.length - 1];
  if (THROTTLED.has(trigger) && prev && Date.now() - new Date(prev.createdAt).getTime() < AUTOSAVE_COOLDOWN_MS) {
    return null; // throttled - too soon since the last snapshot
  }

  const current = {}; // relPath -> { buf, hash }, in walk order
  for (const relPath of walkTextFiles(root)) {
    try {
      const buf = fs.readFileSync(path.join(root, relPath));
      current[relPath] = { buf, hash: sha1(buf) };
    } catch (e) {
      // File vanished or isn't readable -> leave it out.
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) throw e;
    }
  }
  // Nur bei echter Inhaltsaenderung gegenueber dem letzten Snapshot eine neue Version.
  if (prev && sameFiles(root, prev, current)) return null;

  // Unchanged files already have their blob - only new contents are written.
  // A failure (ENOSPC …) leaves at most unreferenced blobs, which prune sweeps.
  const blobDir = path.join(historyRoot(root), BLOBS_DIR);
  fs.mkdirSync(blobDir, { recursive: true });
  const hashes = {};
  for (const [relPath, { buf, hash }] of Object.entries(current)) {
    const blob = path.join(blobDir, hash);
    if (!fs.existsSync(blob)) writeAtomic(blob, buf);
    hashes[relPath] = hash;
  }

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  // files stays for older readers; hashes points into blobs/.
  const entry = { id, createdAt: new Date().toISOString(), label, trigger, files: Object.keys(hashes), hashes };
  entries.push(entry);
  saveIndex(root, entries);
  if (Date.now() - (lastPruneAt.get(root) || 0) >= PRUNE_EVERY_MS) {
    lastPruneAt.set(root, Date.now());
    try {
      prune(root);
    } catch (e) {
      console.error('[history] Ausduennen fehlgeschlagen:', root, e.message);
    }
  }
  return entry;
}

// Entries that survive the retention rule (see constants above).
function retained(entries, now = Date.now()) {
  const keep = new Set();
  const buckets = new Set();
  // Newest first, so each hour/day keeps its latest snapshot and the cap drops the oldest.
  for (const e of entries.slice().reverse()) {
    if (e.label || e.trigger === 'restore') {
      keep.add(e);
      continue;
    }
    const t = new Date(e.createdAt).getTime();
    const age = now - t;
    const bucket = age < DAY ? `e${e.id}` : age < 7 * DAY ? `h${Math.floor(t / HOUR)}` : `d${Math.floor(t / DAY)}`;
    if (buckets.has(bucket) || buckets.size >= MAX_ENTRIES) continue;
    buckets.add(bucket);
    keep.add(e);
  }
  return entries.filter((e) => keep.has(e));
}

// Thin out the index, then mark-and-sweep blobs and legacy snapshot folders
// that no remaining entry references.
function prune(root, now = Date.now()) {
  const entries = loadIndex(root);
  const kept = retained(entries, now);
  if (kept.length !== entries.length) saveIndex(root, kept);

  const blobs = new Set();
  const legacy = new Set();
  for (const e of kept) {
    if (e.hashes) Object.values(e.hashes).forEach((h) => blobs.add(h));
    else legacy.add(e.id);
  }
  for (const [dir, live] of [[BLOBS_DIR, blobs], [SNAPSHOTS_DIR, legacy]]) {
    const abs = path.join(historyRoot(root), dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!live.has(name)) fs.rmSync(path.join(abs, name), { recursive: true, force: true });
    }
  }
}

function list(root) {
  return loadIndex(root).slice().reverse(); // newest first
}

function getEntry(root, id) {
  return loadIndex(root).find((e) => e.id === id) || null;
}

function addLabel(root, id, name) {
  const entries = loadIndex(root);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('Version nicht gefunden.');
  entry.label = name;
  saveIndex(root, entries);
  return entry;
}

// entry: pass it when the caller already has it (saves re-reading the index).
function readSnapshotBuffer(root, id, relPath, entry = getEntry(root, id)) {
  if (!entry) return null;
  let abs;
  if (entry.hashes) {
    if (!Object.hasOwn(entry.hashes, relPath)) return null; // file did not exist yet at this snapshot
    abs = path.join(historyRoot(root), BLOBS_DIR, entry.hashes[relPath]);
  } else {
    abs = path.join(historyRoot(root), SNAPSHOTS_DIR, id, relPath);
  }
  return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
}

function readSnapshotFile(root, id, relPath, entry) {
  const buf = readSnapshotBuffer(root, id, relPath, entry);
  return buf === null ? null : buf.toString('utf8');
}

function readCurrentFile(root, relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

// toId may be a snapshot id or the literal string 'current'.
function diffBetween(root, fromId, toId, relPath) {
  const entries = loadIndex(root);
  const from = entries.find((e) => e.id === fromId);
  if (!from) throw new Error('Ausgangs-Version nicht gefunden.');
  const oldContent = readSnapshotFile(root, fromId, relPath, from) ?? '';
  let newContent;
  if (toId === 'current') {
    newContent = readCurrentFile(root, relPath) ?? '';
  } else {
    const to = entries.find((e) => e.id === toId);
    if (!to) throw new Error('Ziel-Version nicht gefunden.');
    newContent = readSnapshotFile(root, toId, relPath, to) ?? '';
  }
  return diffLines(oldContent, newContent);
}

module.exports = { snapshot, prune, retained, readSnapshotFile, readSnapshotBuffer, list, getEntry, addLabel, diffBetween, HISTORY_DIR, MAX_ENTRIES };
