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
const { safeResolve } = require('./fsTree');

const STATE_DIR = '.latex-ide-yjs';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PERSIST_DELAY_MS = 500;

const docs = new Map(); // key -> entry
let hooks = { onPersist: () => {}, markSelfWrite: () => {} };

const keyOf = (root, rel) => `${root}\0${rel}`;
const statePath = (root, rel) => path.join(root, STATE_DIR, rel + '.ystate');

function setHooks(h) {
  hooks = { ...hooks, ...h };
}

// Replace only the differing middle part, so concurrent edits elsewhere and
// remote cursors survive an external change (search/replace, file edited on disk).
function applyText(ytext, next, origin) {
  const cur = ytext.toString();
  if (cur === next) return false;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  ytext.doc.transact(() => {
    if (endCur > start) ytext.delete(start, endCur - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  }, origin);
  return true;
}

function loadDoc(root, rel) {
  const abs = safeResolve(root, rel);
  const disk = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (disk === null) throw Object.assign(new Error('Datei nicht gefunden.'), { notFound: true });
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
  // Disk changed while the doc was unloaded (e.g. edited outside the IDE) -> fold it in.
  applyText(ytext, disk, 'disk');
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
  entry.dirty = false;
  const text = entry.ytext.toString();
  try {
    const abs = safeResolve(entry.root, entry.rel);
    // Changes that came *from* disk don't need writing back.
    if (entry.lastOrigin !== 'disk' || !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== text) {
      hooks.markSelfWrite(entry.root, entry.rel, text);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
    }
    writeState(entry.root, entry.rel, entry.ydoc);
    hooks.onPersist(entry.root, entry.rel);
  } catch (e) {
    console.error(`[collab] Speichern fehlgeschlagen: ${entry.rel}`, e.message);
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
  if (reviewerMayApply(ydoc, update)) Y.applyUpdate(ydoc, update, ws);
  else console.warn('[collab] Änderung eines Kommentierenden verworfen.');
}

function handleConnection(ws, root, rel, epoch, readOnly = false) {
  let entry;
  try {
    entry = getDoc(root, rel);
  } catch (e) {
    return ws.close(4404, 'not found');
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
function applyExternalText(root, rel, text) {
  const entry = docs.get(keyOf(root, rel));
  if (!entry) return;
  applyText(entry.ytext, text, 'disk');
}

// File or folder renamed/moved/deleted: kick connected clients off the old
// name and move/remove the persisted state along with it.
function onPathMoved(root, oldRel, newRel) {
  const prefix = oldRel + '/';
  for (const entry of [...docs.values()]) {
    if (entry.root !== root || (entry.rel !== oldRel && !entry.rel.startsWith(prefix))) continue;
    if (entry.timer) persist(entry);
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
  const next = fn(entry.ytext.toString());
  applyText(entry.ytext, next, 'mcp');
  maybeUnload(entry); // stays loaded while dirty; persist() unloads it
  return next;
}

function flushAll() {
  for (const entry of docs.values()) if (entry.timer) persist(entry);
}

module.exports = {
  STATE_DIR,
  setHooks,
  getEpoch,
  handleConnection,
  applyExternalText,
  onPathMoved,
  flushRoot,
  flushAll,
  applyText,
  readText,
  editText,
};
