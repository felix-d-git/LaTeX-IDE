const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diffLines } = require('diff');
const { isIgnored, isTextFile, isUtf8 } = require('./fsTree');
const { selfWrittenHashes } = require('../state');
const { OUT_DIR } = require('./compile');

function hashOf(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function startWatcher(root, broadcast) {
  const watcher = chokidar.watch(root, {
    ignored: (p) => {
      const rel = path.relative(root, p);
      if (!rel) return false;
      const parts = rel.split(path.sep);
      if (parts[0] === OUT_DIR) return false; // watch pdf output, filter below
      return parts.some((part) => isIgnored(part));
    },
    ignoreInitial: true,
    ignorePermissionErrors: true, // unreadable subfolders: skip instead of 'error'
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  // Without a listener an 'error' (inotify limit ENOSPC, EMFILE ...) ends the process.
  // External edits are then no longer picked up live; log each code once per project.
  const reportedCodes = new Set();
  watcher.on('error', (err) => {
    const code = (err && err.code) || 'UNKNOWN';
    if (reportedCodes.has(code)) return;
    reportedCodes.add(code);
    console.error(`[watcher] ${root}: ${(err && err.message) || err}`);
  });

  const lastContent = new Map();

  watcher.on('change', (absPath) => {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');

    if (relPath.startsWith(OUT_DIR + '/')) {
      if (relPath.toLowerCase().endsWith('.pdf')) {
        broadcast({ type: 'pdfChanged', path: relPath });
      }
      return;
    }

    if (!isTextFile(relPath)) return;

    let content;
    try {
      const buf = fs.readFileSync(absPath);
      // Saved as Latin-1 outside the IDE: no fileChanged with U+FFFD replacement characters.
      if (!isUtf8(buf)) {
        lastContent.delete(relPath);
        return broadcast({ type: 'fileNotUtf8', path: relPath });
      }
      content = buf.toString('utf8');
    } catch (e) {
      return;
    }

    const newHash = hashOf(content);
    const expectedSelfHash = selfWrittenHashes.get(relPath);
    if (expectedSelfHash === newHash) {
      // This is the echo of our own save via PUT /api/file - not an external edit.
      selfWrittenHashes.delete(relPath);
      lastContent.set(relPath, content);
      return;
    }

    const previous = lastContent.has(relPath) ? lastContent.get(relPath) : content;
    const diff = diffLines(previous, content);

    let lineCursor = 0;
    const changedRanges = [];
    for (const part of diff) {
      const lineCount = part.value.split('\n').length - 1;
      if (part.added) {
        changedRanges.push({ fromLine: lineCursor, toLine: lineCursor + lineCount });
        lineCursor += lineCount;
      } else if (!part.removed) {
        lineCursor += lineCount;
      }
    }

    lastContent.set(relPath, content);

    broadcast({
      type: 'fileChanged',
      path: relPath,
      content,
      changedRanges,
      source: 'external',
    });
  });

  watcher.on('unlink', (absPath) => {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');
    broadcast({ type: 'fileDeleted', path: relPath });
  });

  watcher.on('add', (absPath) => {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');
    if (relPath.startsWith(OUT_DIR + '/')) return;
    broadcast({ type: 'treeChanged' });
  });

  return watcher;
}

module.exports = { startWatcher };
