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

// Symlinks only when they point at a regular file - dangling ones (Emacs lock
// files like .#main.tex) can't be copied.
function isRegularFile(root, relPath, entry) {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(root, relPath)).isFile();
  } catch {
    return false;
  }
}

function walkTextFiles(root, relDir = '', out = []) {
  const absDir = path.join(root, relDir);
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const relPath = path.join(relDir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      walkTextFiles(root, relPath, out);
    } else if (isTextFile(relPath) && isRegularFile(root, relPath, entry)) {
      out.push(relPath);
    }
  }
  return out;
}

function sameFiles(root, prev, files) {
  if (prev.files.length !== files.length || prev.files.some((f, i) => f !== files[i])) return false;
  try {
    return files.every((f) => readSnapshotFile(root, prev.id, f) === readCurrentFile(root, f));
  } catch {
    return false; // unreadable counts as changed
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
  try {
    for (const relPath of files) {
      const dest = path.join(snapDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.copyFileSync(path.join(root, relPath), dest);
        copied.push(relPath);
      } catch (e) {
        // Vanished or unreadable meanwhile: leave it out of this version.
        if (e.code !== 'ENOENT' && e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
      }
    }
  } catch (e) {
    // e.g. disk full: no half-written snapshot without an index entry
    fs.rmSync(snapDir, { recursive: true, force: true });
    throw e;
  }

  const entry = { id, createdAt: new Date().toISOString(), label, trigger, files: copied };
  const entries = loadIndex(root);
  entries.push(entry);
  saveIndex(root, entries);
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
