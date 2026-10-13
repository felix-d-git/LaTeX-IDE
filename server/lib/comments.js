const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isIgnored, isTextFile, safeResolve, decodeText } = require('./fsTree');

const COMMENTS_FILE = '.latex-ide-comments.json';
// Comments whose file is gone and could not be matched to another one: { oldRel: [comment] }.
// Never shown (no file has this key), retried on every reconcile.
const ORPHANED = '_orphaned';

function filePath(root) {
  return path.join(root, COMMENTS_FILE);
}

function load(root) {
  const p = filePath(root);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // keep the broken file instead of silently replacing it with an empty one on the next save
    try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch (_) {}
    return {};
  }
}

function save(root, data) {
  const p = filePath(root);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// Merge by id: comments already at the target are kept, never overwritten.
function mergeInto(map, key, list) {
  const cur = map[key] || [];
  const ids = new Set(cur.map((c) => c.id));
  map[key] = [...cur, ...list.filter((c) => !ids.has(c.id))];
}

function textFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && isTextFile(r)) out.push(r);
    }
  };
  walk('');
  return out;
}

function isFile(root, rel) {
  try {
    return fs.statSync(safeResolve(root, rel)).isFile();
  } catch {
    return false;
  }
}

// Comments left behind under a path that no longer exists (renamed/moved before comments
// followed their file) go back to their file: (a) the only other file with the same name,
// else (b) the only file containing every anchorText. Offsets are re-set from the anchorText.
// No match -> parked under ORPHANED (retried next time). Never deletes anything.
function reconcile(root, data) {
  const lost = Object.keys(data).filter((k) => k !== ORPHANED && !isFile(root, k));
  const parked = data[ORPHANED] || {};
  if (!lost.length && !Object.keys(parked).length) return false;
  // ponytail: walks + reads the project on every load while something stays orphaned; cache if projects get huge.
  const files = textFiles(root);
  const texts = new Map();
  const textOf = (f) => {
    if (!texts.has(f)) {
      let t = null;
      try {
        t = decodeText(fs.readFileSync(path.join(root, f)));
      } catch {}
      texts.set(f, t === null ? null : t.replace(/\r\n?/g, '\n'));
    }
    return texts.get(f);
  };
  const targetFor = (oldRel, list) => {
    const base = path.posix.basename(oldRel);
    const sameName = files.filter((f) => f !== oldRel && path.posix.basename(f) === base);
    if (sameName.length === 1) return sameName[0];
    const anchors = list.map((c) => c.anchorText).filter(Boolean);
    if (!anchors.length) return null;
    const hits = files.filter((f) => {
      const t = textOf(f);
      return t !== null && anchors.every((a) => t.includes(a));
    });
    return hits.length === 1 ? hits[0] : null;
  };
  const place = (oldRel, list) => {
    const target = targetFor(oldRel, list);
    if (!target) return false;
    const t = textOf(target);
    const fixed = list.map((c) => {
      const i = c.anchorText && t !== null ? t.indexOf(c.anchorText) : -1;
      return i < 0 ? c : { ...c, from: i, to: i + c.anchorText.length };
    });
    mergeInto(data, target, fixed);
    return true;
  };
  const nextParked = {};
  for (const [oldRel, list] of Object.entries(parked)) if (!place(oldRel, list)) mergeInto(nextParked, oldRel, list);
  for (const k of lost) {
    const list = data[k];
    delete data[k];
    if (!place(k, list)) mergeInto(nextParked, k, list);
  }
  if (Object.keys(nextParked).length) data[ORPHANED] = nextParked;
  else delete data[ORPHANED];
  return true;
}

// What the client sees: comments per existing file (orphans re-attached first, parked ones hidden).
function listAll(root) {
  const data = load(root);
  if (reconcile(root, data)) save(root, data);
  const { [ORPHANED]: _, ...visible } = data;
  return visible;
}

// File/folder renamed or moved (newRel) or deleted (newRel = null): comments follow or go.
// Entries are collected first, then re-written, so old and new keys can't clash.
function movePath(root, oldRel, newRel) {
  if (!oldRel || oldRel === newRel) return false;
  const data = load(root);
  const prefix = oldRel + '/';
  const hits = Object.keys(data).filter((k) => k !== ORPHANED && (k === oldRel || k.startsWith(prefix)));
  if (!hits.length) return false;
  const moved = hits.map((k) => [k, data[k]]);
  for (const k of hits) delete data[k];
  if (newRel) for (const [k, list] of moved) mergeInto(data, newRel + k.slice(oldRel.length), list);
  save(root, data);
  return true;
}

// author = { id, name }; aeltere Kommentare haben keinen Autor und kein replies-Feld.
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
    author: author || null,
    createdAt: new Date().toISOString(),
    replies: [],
    ...(suggestion && { suggestion }),
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

module.exports = { listAll, movePath, ORPHANED, add, edit, reply, removeReply, remove, COMMENTS_FILE };
