const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diffLines } = require('diff');
const { isIgnored, isTextFile } = require('./fsTree');

const HISTORY_DIR = '.latex-ide-history';
const INDEX_FILE = 'index.json';
const SNAPSHOTS_DIR = 'snapshots';

// Only takes a new autosave-triggered snapshot at most this often per
// project, so a burst of keystroke-driven autosaves doesn't create one
// version per save - a compile-triggered snapshot always bypasses this,
// since clicking "Kompilieren" is an infrequent, deliberate checkpoint.
const AUTOSAVE_COOLDOWN_MS = 3 * 60 * 1000;

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
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveIndex(root, entries) {
  fs.mkdirSync(historyRoot(root), { recursive: true });
  fs.writeFileSync(indexPath(root), JSON.stringify(entries, null, 2), 'utf8');
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

function sameFiles(root, prev, files) {
  if (prev.files.length !== files.length || prev.files.some((f, i) => f !== files[i])) return false;
  try {
    return files.every((f) => readSnapshotFile(root, prev.id, f) === readCurrentFile(root, f));
  } catch (e) {
    return false; // unreadable -> treat as changed
  }
}

function snapshot(root, { label = null, trigger = 'autosave' } = {}) {
  if (trigger === 'autosave') {
    const entries = loadIndex(root);
    const last = entries[entries.length - 1];
    if (last && Date.now() - new Date(last.createdAt).getTime() < AUTOSAVE_COOLDOWN_MS) {
      return null; // throttled - too soon since the last snapshot
    }
  }

  const files = walkTextFiles(root);
  // Nur bei echter Inhaltsaenderung gegenueber dem letzten Snapshot eine neue Version.
  const prev = loadIndex(root).slice(-1)[0];
  if (prev && sameFiles(root, prev, files)) return null;

  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const snapDir = path.join(historyRoot(root), SNAPSHOTS_DIR, id);
  const copied = [];
  for (const relPath of files) {
    const dest = path.join(snapDir, relPath);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(root, relPath), dest);
      copied.push(relPath);
    } catch (e) {
      // File vanished or isn't readable -> leave it out; anything else (ENOSPC …)
      // aborts without leaving a snapshot folder that no index entry points to.
      if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) continue;
      fs.rmSync(snapDir, { recursive: true, force: true });
      throw e;
    }
  }

  const entry = { id, createdAt: new Date().toISOString(), label, trigger, files: copied };
  const entries = loadIndex(root);
  entries.push(entry);
  try {
    saveIndex(root, entries);
  } catch (e) {
    fs.rmSync(snapDir, { recursive: true, force: true });
    throw e;
  }
  return entry;
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

function readSnapshotFile(root, id, relPath) {
  const abs = path.join(historyRoot(root), SNAPSHOTS_DIR, id, relPath);
  if (!fs.existsSync(abs)) return null; // file did not exist yet at this snapshot
  return fs.readFileSync(abs, 'utf8');
}

function readCurrentFile(root, relPath) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

// toId may be a snapshot id or the literal string 'current'.
function diffBetween(root, fromId, toId, relPath) {
  if (!getEntry(root, fromId)) throw new Error('Ausgangs-Version nicht gefunden.');
  const oldContent = readSnapshotFile(root, fromId, relPath) ?? '';
  let newContent;
  if (toId === 'current') {
    newContent = readCurrentFile(root, relPath) ?? '';
  } else {
    if (!getEntry(root, toId)) throw new Error('Ziel-Version nicht gefunden.');
    newContent = readSnapshotFile(root, toId, relPath) ?? '';
  }
  return diffLines(oldContent, newContent);
}

module.exports = { snapshot, readSnapshotFile, list, getEntry, addLabel, diffBetween, HISTORY_DIR };
