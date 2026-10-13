// Live collaboration: one Y.Doc per (project root, text file), served over the
// standard y-websocket protocol (sync + awareness), so y-websocket's
// WebsocketProvider on the client talks to it unchanged.
// Modelled on y-websocket's bin/utils.js (up to 2.x): Copyright (c) 2019
// Kevin Jahns <kevin.jahns@protonmail.com>, MIT License (text: y-websocket
// in THIRD_PARTY_NOTICES.md).
//
// The .tex file on disk stays the source for latexmk/search/history: every
// change is written back (debounced). The Yjs state is persisted next to it
// in .latex-ide-yjs/ - re-seeding a doc from plain text would give it a new
// identity and clients with cached (offline) copies would merge it twice.
// The "epoch" marks that identity; clients key their IndexedDB cache by it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { diffLines, diffChars } = require('diff');
const { safeResolve, decodeText, NOT_UTF8_MSG } = require('./fsTree');

const STATE_DIR = '.latex-ide-yjs';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Largest WebSocket message (/ws and /yjs); a bigger one closes only that connection with 1009.
const WS_MAX_PAYLOAD = 64 * 1024 * 1024;
const PERSIST_DELAY_MS = 500;

const docs = new Map(); // key -> entry
let hooks = { onPersist: () => {}, markSelfWrite: () => {} };

const keyOf = (root, rel) => `${root}\0${rel}`;
const statePath = (root, rel) => path.join(root, STATE_DIR, rel + '.ystate');

function setHooks(h) {
  hooks = { ...hooks, ...h };
}

// CodeMirror counts CRLF as one character, Y.Text as two - every offset after a CR
// would be off by one. So text crossing disk -> Yjs is always LF (saved back as LF).
const normEol = (s) => s.replace(/\r\n?/g, '\n');

// Minimal edits (changed lines, then changed characters within them), so comment and
// track-change anchors, remote cursors and concurrent edits on untouched text survive
// an external change (search/replace, restore, upload, file edited on disk).
function applyText(ytext, next, origin) {
  const cur = ytext.toString();
  if (cur === next) return false;
  const hunks = []; // [index in cur, chars to delete, text to insert], ascending
  let pos = 0;
  const parts = diffLines(cur, next);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].added && !parts[i].removed) {
      pos += parts[i].value.length;
      continue;
    }
    let del = '';
    let ins = '';
    for (; i < parts.length && (parts[i].added || parts[i].removed); i++) {
      if (parts[i].removed) del += parts[i].value;
      else ins += parts[i].value;
    }
    i--;
    // ponytail: char diff capped (Myers is O(n*d)); a rewritten block is replaced as a whole.
    let chars = del && ins ? diffChars(del, ins, { maxEditLength: 1000 }) : null;
    // A piece must not cut a surrogate pair (emoji, math letters): that would leave U+FFFD behind.
    if (chars && chars.some((c) => /^[\udc00-\udfff]|[\ud800-\udbff]$/.test(c.value))) chars = null;
    if (chars) {
      let q = pos;
      for (const c of chars) {
        if (c.added) hunks.push([q, 0, c.value]);
        else if (c.removed) hunks.push([q, c.value.length, '']);
        if (!c.added) q += c.value.length;
      }
    } else hunks.push([pos, del.length, ins]);
    pos += del.length;
  }
  ytext.doc.transact(() => {
    for (let h = hunks.length - 1; h >= 0; h--) {
      const [at, len, text] = hunks[h];
      if (len) ytext.delete(at, len);
      if (text) ytext.insert(at, text);
    }
  }, origin);
  return true;
}

function loadDoc(root, rel) {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('Datei nicht gefunden.'), { notFound: true });
  const raw = decodeText(fs.readFileSync(abs));
  // Seeding a Latin-1 file would turn every umlaut into U+FFFD on the first save.
  if (raw === null) throw Object.assign(new Error(NOT_UTF8_MSG), { notUtf8: true });
  const disk = normEol(raw);
  const ydoc = new Y.Doc({ gc: true });
  const sp = statePath(root, rel);
  let fromState = false;
  if (fs.existsSync(sp)) {
    try {
      Y.applyUpdate(ydoc, fs.readFileSync(sp));
      fromState = true;
    } catch (e) {
      console.warn(`[collab] Yjs-Zustand defekt, neu aus Datei: ${rel}`, e.message);
    }
  }
  const ytext = ydoc.getText('content');
  const meta = ydoc.getMap('meta');
  if (!fromState || !meta.get('epoch')) {
    // Fresh identity: seed from disk.
    ydoc.destroy();
    return createFresh(root, rel, disk);
  }
  // State saved before CRLF was normalized: drop each CR on its own (not applyText,
  // which may rewrite whole lines) so comment/track-change anchors stay put.
  const old = ytext.toString();
  let changed = false;
  if (old.includes('\r')) {
    ydoc.transact(() => {
      for (let i = old.length - 1; i >= 0; i--) if (old[i] === '\r') ytext.delete(i, 1);
    }, 'disk');
    changed = true;
  }
  // Disk changed while the doc was unloaded (e.g. edited outside the IDE) -> fold it in.
  if (applyText(ytext, disk, 'disk')) changed = true;
  // ... and save that at once: otherwise every load re-creates the same change with a
  // new identity, and a client holding an earlier one gets the text twice. Only the
  // state - the disk already matches, and no history snapshot/autocompile for opening.
  if (changed) {
    try {
      writeState(root, rel, ydoc);
    } catch (e) {
      console.error(`[collab] Yjs-Zustand konnte nicht gespeichert werden: ${rel}`, e.message);
    }
  }
  return { ydoc, ytext, meta };
}

function createFresh(root, rel, text) {
  const ydoc = new Y.Doc({ gc: true });
  const ytext = ydoc.getText('content');
  const meta = ydoc.getMap('meta');
  ydoc.transact(() => {
    meta.set('epoch', crypto.randomBytes(8).toString('hex'));
    ytext.insert(0, text);
  }, 'disk');
  writeState(root, rel, ydoc);
  return { ydoc, ytext, meta };
}

function writeState(root, rel, ydoc) {
  const sp = statePath(root, rel);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp + '.tmp', Buffer.from(Y.encodeStateAsUpdate(ydoc)));
  fs.renameSync(sp + '.tmp', sp);
}

function getDoc(root, rel) {
  const key = keyOf(root, rel);
  let entry = docs.get(key);
  if (entry) return entry;
  const { ydoc, ytext, meta } = loadDoc(root, rel);
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null); // the server itself has no cursor
  entry = { key, root, rel, ydoc, ytext, meta, awareness, conns: new Map(), timer: null, dirty: false };
  docs.set(key, entry);

  ydoc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const ws of entry.conns.keys()) send(entry, ws, msg);
    schedulePersist(entry, origin);
  });

  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const ids = origin && entry.conns.get(origin);
    if (ids) {
      added.forEach((id) => ids.add(id));
      removed.forEach((id) => ids.delete(id));
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const ws of entry.conns.keys()) send(entry, ws, msg);
  });
  return entry;
}

function schedulePersist(entry, origin) {
  entry.dirty = true;
  entry.lastOrigin = origin;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => persist(entry), PERSIST_DELAY_MS);
}

function persist(entry) {
  clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.dirty) return;
  // Project folder gone (renamed/trashed/deleted under a live doc): never recreate it.
  if (!fs.existsSync(entry.root)) return dropDoc(entry, 4410, 'project moved');
  entry.dirty = false;
  const text = entry.ytext.toString();
  try {
    const abs = safeResolve(entry.root, entry.rel);
    // Changes that came *from* disk don't need writing back (a CRLF file stays as it is).
    const onDisk = () => {
      const t = decodeText(fs.readFileSync(abs));
      return t === null ? null : normEol(t);
    };
    if (entry.lastOrigin !== 'disk' || !fs.existsSync(abs) || onDisk() !== text) {
      hooks.markSelfWrite(entry.root, entry.rel, text);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = statePath(entry.root, entry.rel) + '.tex.tmp'; // same FS, outside the tree
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, abs);
    }
    writeState(entry.root, entry.rel, entry.ydoc);
    entry.failures = 0;
    hooks.onPersist(entry.root, entry.rel);
  } catch (e) {
    // Keep the doc loaded and dirty and try again (disk full, locked file): unloading would lose the edit.
    entry.failures = (entry.failures || 0) + 1;
    entry.dirty = true;
    entry.timer = setTimeout(() => persist(entry), Math.min(30000, PERSIST_DELAY_MS * 2 ** entry.failures));
    console.error(`[collab] Speichern fehlgeschlagen (Versuch ${entry.failures}): ${entry.rel}`, e.message);
  }
  maybeUnload(entry);
}

function maybeUnload(entry) {
  if (entry.conns.size || entry.dirty || docs.get(entry.key) !== entry) return;
  docs.delete(entry.key);
  entry.awareness.destroy();
  entry.ydoc.destroy();
}

// Before compiling / zipping: get every pending edit of this project onto disk.
function flushRoot(root) {
  for (const entry of docs.values()) if (entry.root === root && entry.timer) persist(entry);
}

function send(entry, ws, msg) {
  if (ws.readyState !== 1) return closeConn(entry, ws);
  ws.send(msg, (err) => err && closeConn(entry, ws));
}

function closeConn(entry, ws) {
  const ids = entry.conns.get(ws);
  if (!ids) return;
  entry.conns.delete(ws);
  awarenessProtocol.removeAwarenessStates(entry.awareness, [...ids], null);
  try {
    ws.close();
  } catch {}
  if (!entry.conns.size && !entry.timer) maybeUnload(entry);
}

function getEpoch(root, rel) {
  const entry = getDoc(root, rel);
  const epoch = entry.meta.get('epoch');
  maybeUnload(entry);
  return epoch;
}

// Reviewers may only add comment anchors: an update is applied to a scratch
// copy first and dropped if it touches the text or the tracked changes.
function reviewerMayApply(ydoc, update) {
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, Y.encodeStateAsUpdate(ydoc));
  const snap = () => tmp.getText('content').toString() + '\0' + JSON.stringify(tmp.getMap('review').toJSON());
  const before = snap();
  Y.applyUpdate(tmp, update);
  const ok = snap() === before;
  tmp.destroy();
  return ok;
}

function readSyncReadOnly(dec, enc, ydoc, ws) {
  const kind = decoding.readVarUint(dec);
  if (kind === syncProtocol.messageYjsSyncStep1) {
    syncProtocol.writeSyncStep2(enc, ydoc, decoding.readVarUint8Array(dec));
    return;
  }
  const update = decoding.readVarUint8Array(dec);
  if (reviewerMayApply(ydoc, update)) return Y.applyUpdate(ydoc, update, ws);
  // Not silently: the client would keep the phantom text, and its later updates
  // (comment anchors) would hang here as pending structs. 4403 = drop the cache.
  console.warn('[collab] Änderung eines Kommentierenden abgewiesen.');
  ws.close(4403, 'read only');
}

function handleConnection(ws, root, rel, epoch, readOnly = false) {
  // First, before any early close: without a listener a socket error (e.g. message > maxPayload)
  // is an uncaught exception that ends the whole server. Cleanup happens in 'close'.
  ws.on('error', (e) => console.warn('[collab] WebSocket-Fehler', rel, e.code || e.message));
  let entry;
  try {
    entry = getDoc(root, rel);
  } catch (e) {
    return e.notUtf8 ? ws.close(4415, 'not utf-8') : ws.close(4404, 'not found');
  }
  // Client cache belongs to an older identity of this doc -> it must drop it
  // instead of merging (which would duplicate the whole text).
  if (epoch && epoch !== entry.meta.get('epoch')) {
    maybeUnload(entry);
    return ws.close(4409, 'epoch changed');
  }
  ws.binaryType = 'arraybuffer';
  entry.conns.set(ws, new Set());
  ws.on('message', (data) => {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        if (readOnly) readSyncReadOnly(dec, enc, entry.ydoc, ws);
        else syncProtocol.readSyncMessage(dec, enc, entry.ydoc, ws);
        if (encoding.length(enc) > 1) send(entry, ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(dec), ws);
      }
    } catch (e) {
      console.warn('[collab] Ungültige Nachricht verworfen:', e.message);
    }
  });
  ws.on('close', () => closeConn(entry, ws));

  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, entry.ydoc);
  send(entry, ws, encoding.toUint8Array(enc));
  const states = [...entry.awareness.getStates().keys()];
  if (states.length) {
    const aenc = encoding.createEncoder();
    encoding.writeVarUint(aenc, MSG_AWARENESS);
    encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, states));
    send(entry, ws, encoding.toUint8Array(aenc));
  }
}

// Text changed on disk by someone other than collab (search/replace, external
// editor, upload over an existing file): fold into the live doc if one exists,
// otherwise the next load reconciles from disk anyway.
// text === null: the new content is not UTF-8 (decodeText) -> the live doc can't hold it.
function applyExternalText(root, rel, text) {
  const entry = docs.get(keyOf(root, rel));
  if (!entry) return;
  if (text === null) return dropDoc(entry, 4415, 'not utf-8');
  applyText(entry.ytext, normEol(text), 'disk');
}

// Unload a live doc WITHOUT saving: the file on disk was replaced by something the doc
// can't represent, and a pending save would overwrite it. Clients get `code`; the
// .ystate stays, so a later UTF-8 version folds in with minimal edits (anchors kept).
function dropDoc(entry, code, reason) {
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.dirty = false;
  docs.delete(entry.key);
  for (const ws of [...entry.conns.keys()]) {
    try {
      ws.close(code, reason);
    } catch {}
    closeConn(entry, ws);
  }
  entry.awareness.destroy();
  entry.ydoc.destroy();
}

// File or folder renamed/moved/deleted: kick connected clients off the old
// name and move/remove the persisted state along with it.
// Project folder about to move/vanish (rename, archive, trash, account deletion): save pending
// edits, then send everyone on it or below `dir` away with 4410 (client goes to the dashboard).
function closeRoot(dir) {
  dir = path.resolve(dir);
  for (const entry of [...docs.values()]) {
    const r = path.resolve(entry.root);
    if (r !== dir && !r.startsWith(dir + path.sep)) continue;
    if (entry.timer) persist(entry);
    if (docs.get(entry.key) === entry) dropDoc(entry, 4410, 'project moved');
  }
}

function onPathMoved(root, oldRel, newRel) {
  const prefix = oldRel + '/';
  for (const entry of [...docs.values()]) {
    if (entry.root !== root || (entry.rel !== oldRel && !entry.rel.startsWith(prefix))) continue;
    // Deleted (newRel null): a flush would write the file back; rename/move: flush before the file operation.
    if (newRel) { if (entry.timer) persist(entry); } else { clearTimeout(entry.timer); entry.timer = null; entry.dirty = false; }
    for (const ws of [...entry.conns.keys()]) {
      try {
        ws.close(4404, 'moved');
      } catch {}
      closeConn(entry, ws);
    }
    docs.delete(entry.key);
    entry.awareness.destroy();
    entry.ydoc.destroy();
  }
  const from = path.join(root, STATE_DIR, oldRel);
  for (const suffix of ['', '.ystate']) {
    if (!fs.existsSync(from + suffix)) continue;
    if (newRel) {
      const to = path.join(root, STATE_DIR, newRel) + suffix;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from + suffix, to);
    } else {
      fs.rmSync(from + suffix, { recursive: true, force: true });
    }
  }
}

// Programmatic access (MCP): the live doc is the truth, edits reach open editors like any collaborator's.
function readText(root, rel) {
  const entry = getDoc(root, rel);
  const text = entry.ytext.toString();
  maybeUnload(entry);
  return text;
}

// fn(oldText) -> newText; returns newText. A throwing fn leaves the doc untouched.
function editText(root, rel, fn) {
  const entry = getDoc(root, rel);
  try {
    const next = normEol(fn(entry.ytext.toString()));
    applyText(entry.ytext, next, 'mcp');
    // Write now so a disk error reaches the caller instead of a silent "ok".
    if (entry.timer) persist(entry);
    if (entry.dirty) throw new Error('Speichern fehlgeschlagen (wird wiederholt).');
    return next;
  } finally {
    maybeUnload(entry); // stays loaded while dirty
  }
}

function flushAll() {
  for (const entry of docs.values()) if (entry.timer) persist(entry);
}

module.exports = {
  STATE_DIR,
  WS_MAX_PAYLOAD,
  setHooks,
  getEpoch,
  handleConnection,
  applyExternalText,
  onPathMoved,
  closeRoot,
  flushRoot,
  flushAll,
  applyText,
  readText,
  editText,
};
