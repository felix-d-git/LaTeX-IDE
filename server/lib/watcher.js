// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diffLines } = require('diff');
const { isIgnored, isTextFile, decodeText } = require('./fsTree');
const { takeSelfWrite } = require('../state');

function hashOf(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

function startWatcher(root, broadcast) {
  const watcher = chokidar.watch(root, {
    ignored: (p) => {
      const rel = path.relative(root, p);
      if (!rel) return false;
      const parts = rel.split(path.sep);
      return parts.some((part) => isIgnored(part));
    },
    ignoreInitial: true,
    ignorePermissionErrors: true, // unreadable folders can't be edited anyway
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  // Without a listener an 'error' (inotify limit ENOSPC, EMFILE …) ends the whole server.
  // External changes are then just not detected live; log each code once per project.
  const reportedCodes = new Set();
  watcher.on('error', (err) => {
    const code = (err && err.code) || 'UNKNOWN';
    if (reportedCodes.has(code)) return;
    reportedCodes.add(code);
    console.error(`[watcher] ${root}: ${err && err.message}`);
  });

  const lastContent = new Map();

  watcher.on('change', (absPath) => {
    const relPath = path.relative(root, absPath).split(path.sep).join('/');

    if (!isTextFile(relPath)) return;

    let buf;
    try {
      buf = fs.readFileSync(absPath);
    } catch (e) {
      return;
    }
    // null = not UTF-8 -> collab drops the live doc instead of folding in U+FFFD.
    const content = decodeText(buf);

    const newHash = hashOf(buf);
    if (takeSelfWrite(absPath, newHash)) {
      // This is the echo of our own save (collab persist) - not an external edit.
      lastContent.set(relPath, content);
      return;
    }

    const previous = lastContent.has(relPath) ? lastContent.get(relPath) : content;
    const diff = content === null || previous === null ? [] : diffLines(previous, content);

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
    broadcast({ type: 'treeChanged' });
  });

  return watcher;
}

module.exports = { startWatcher };
