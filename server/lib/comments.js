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

// author = { id, name }; aeltere Kommentare haben keinen Autor und kein replies-Feld.
function add(root, relPath, { from, to, anchorText, text, author }) {
  const data = load(root);
  if (!data[relPath]) data[relPath] = [];
  const comment = {
    id: crypto.randomUUID(),
    from,
    to,
    anchorText: anchorText || '',
    text,
    author: author || null,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  data[relPath].push(comment);
  save(root, data);
  return comment;
}

function find(data, relPath, id) {
  return (data[relPath] || []).find((c) => c.id === id) || null;
}

// canEdit(item) -> bool entscheidet der Aufrufer (Autor/Owner); null = nicht gefunden, false = verboten.
function edit(root, relPath, id, replyId, text, canEdit) {
  const data = load(root);
  const c = find(data, relPath, id);
  const item = c && (replyId ? (c.replies || []).find((r) => r.id === replyId) : c);
  if (!item) return null;
  if (!canEdit(item)) return false;
  item.text = text;
  item.editedAt = new Date().toISOString();
  save(root, data);
  return c;
}

function reply(root, relPath, id, { text, author }) {
  const data = load(root);
  const c = find(data, relPath, id);
  if (!c) return null;
  if (!c.replies) c.replies = [];
  c.replies.push({ id: crypto.randomUUID(), text, author, createdAt: new Date().toISOString() });
  save(root, data);
  return c;
}

function removeReply(root, relPath, id, replyId, canDelete) {
  const data = load(root);
  const c = find(data, relPath, id);
  const r = c && (c.replies || []).find((x) => x.id === replyId);
  if (!r) return null;
  if (!canDelete(r)) return false;
  c.replies = c.replies.filter((x) => x.id !== replyId);
  save(root, data);
  return c;
}

// true = geloescht, false = nicht gefunden, null = verboten
function remove(root, relPath, id, canDelete = () => true) {
  const data = load(root);
  const c = find(data, relPath, id);
  if (!c) return false;
  if (!canDelete(c)) return null;
  const filtered = data[relPath].filter((x) => x.id !== id);
  if (filtered.length === 0) delete data[relPath];
  else data[relPath] = filtered;
  save(root, data);
  return true;
}

module.exports = { listAll, add, edit, reply, removeReply, remove, COMMENTS_FILE };
