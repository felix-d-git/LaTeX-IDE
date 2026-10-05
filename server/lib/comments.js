const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMMENTS_FILE = '.latex-ide-comments.json';

function filePath(root) {
  return path.join(root, COMMENTS_FILE);
}

function load(root) {
  const p = filePath(root);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

function save(root, data) {
  fs.writeFileSync(filePath(root), JSON.stringify(data, null, 2), 'utf8');
}

function listAll(root) {
  return load(root);
}

// suggestion {oldText, newText}: a proposed change (from an MCP review token) the user accepts/rejects in the comments panel.
function add(root, relPath, { from, to, anchorText, text, suggestion, author }) {
  const data = load(root);
  if (!data[relPath]) data[relPath] = [];
  const comment = {
    id: crypto.randomUUID(),
    from,
    to,
    anchorText: anchorText || '',
    text,
    createdAt: new Date().toISOString(),
    ...(suggestion && { suggestion }),
    ...(author && { author }),
  };
  data[relPath].push(comment);
  save(root, data);
  return comment;
}

function remove(root, relPath, id) {
  const data = load(root);
  if (!data[relPath]) return false;
  const before = data[relPath].length;
  const filtered = data[relPath].filter((c) => c.id !== id);
  const removed = filtered.length !== before;
  if (filtered.length === 0) delete data[relPath];
  else data[relPath] = filtered;
  save(root, data);
  return removed;
}

module.exports = { listAll, add, remove, COMMENTS_FILE };
