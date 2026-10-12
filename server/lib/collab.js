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
const { safeResolve, readUtf8OrNull, NOT_UTF8 } = require('./fsTree');

const STATE_DIR = '.latex-ide-yjs';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PERSIST_DELAY_MS = 500;
const CHAR_DIFF_MAX = 20000; // changed blocks up to this size are diffed per character
const DIFF_TIMEOUT_MS = 500;

const docs = new Map(); // key -> entry
let hooks = { onPersist: () => {}, markSelfWrite: () => {} };

const keyOf = (root, rel) => `${root}\0${rel}`;
const statePath = (root, rel) => path.join(root, STATE_DIR, rel + '.ystate');

function setHooks(h) {
  hooks = { ...hooks, ...h };
}

// The doc always holds LF: CodeMirror counts \r\n as one character, while
// y-codemirror maps its offsets 1:1 onto the Y.Text - every CR before the
// cursor would shift edits by one. The file keeps its line endings (entry.eol).
const normEol = (s) => s.replace(/\r\n?/g, '\n');
const eolOf = (raw) => (raw.includes('\r\n') && !/(^|[^\r])\n/.test(raw) ? 'crlf' : 'lf');

// Edits turning a into b as [{ at, del, ins }] (positions in a, ascending):
// changed lines only, and inside them only the changed characters.
function editsBetween(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const whole = [{ at: start, del: midA.length, ins: midB }];
  if (!midA || !midB) return whole;
  const deadline = Date.now() + 2 * DIFF_TIMEOUT_MS;
  const parts = diffLines(midA, midB, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) return whole; // too different to diff quickly
  const out = [];
  let pos = start;
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
    const chars = del && ins && del.length + ins.length <= CHAR_DIFF_MAX && Date.now() < deadline && diffChars(del, ins, { timeout: DIFF_TIMEOUT_MS });
    if (chars) {
      let q = pos;
      for (const c of chars) {
        if (c.removed) out.push({ at: q, del: c.value.length, ins: '' });
        else if (c.added) out.push({ at: q, del: 0, ins: c.value });
        if (!c.added) q += c.value.length;
      }
    } else {
      out.push({ at: pos, del: del.length, ins });
    }
    pos += del.length;
  }
  return out;
}

// Change only what differs, so comment anchors, tracked changes, remote cursors
// and concurrent edits elsewhere survive an external change (search/replace,
// restore, upload, file edited on disk).
function applyText(ytext, next, origin) {
  const cur = ytext.toString();
  if (cur === next) return false;
  const edits = editsBetween(cur, next);
  ytext.doc.transact(() => {
    // back to front, so the positions in cur stay valid
    for (let i = edits.length - 1; i >= 0; i--) {
      const { at, del, ins } = edits[i];
      if (del) ytext.delete(at, del);
      if (ins) ytext.insert(at, ins);
    }
  }, origin);
  return true;
}

// Older versions took CRLF from disk into the doc. Deleting just the CRs keeps
// every other item (and the anchors on it); cached clients merge it cleanly.
function stripCr(ytext) {
  const s = ytext.toString();
  if (!s.includes('\r')) return false;
  ytext.doc.transact(() => {
    for (let i = s.length - 1; i >= 0; i--) if (s[i] === '\r') ytext.delete(i, 1);
  }, 'disk');
  return true;
}

function loadDoc(root, rel) {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('Datei nicht gefunden.'), { notFound: true });
  const raw = readUtf8OrNull(abs);
  if (raw === null) throw Object.assign(new Error(NOT_UTF8), { notUtf8: true });
  const disk = normEol(raw);
  const eol = eolOf(raw);
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
    return { ...createFresh(root, rel, disk), eol };
  }
  // Disk changed while the doc was unloaded (e.g. edited outside the IDE) -> fold it in
  // AND store the result: otherwise every load re-creates the same change with a new
  // client id, and a client that cached an earlier load gets the text twice.
  const migrated = stripCr(ytext);
  if (applyText(ytext, disk, 'disk') || migrated) {
    try {
      writeState(root, rel, ydoc);
    } catch (e) {
      console.error(`[collab] Yjs-Zustand konnte nicht gespeichert werden: ${rel}`, e.message);
    }
  }
  return { ydoc, ytext, meta, eol };
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
  const { ydoc, ytext, meta, eol } = loadDoc(root, rel);
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null); // the server itself has no cursor
  entry = { key, root, rel, ydoc, ytext, meta, eol, awareness, conns: new Map(), timer: null, dirty: false };
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
  const out = entry.eol === 'crlf' ? normEol(text).replace(/\n/g, '\r\n') : text;
  try {
    const abs = safeResolve(entry.root, entry.rel);
    // Changes that came *from* disk don't need writing back.
    if (entry.lastOrigin !== 'disk' || !fs.existsSync(abs) || normEol(fs.readFileSync(abs, 'utf8')) !== text) {
      hooks.markSelfWrite(entry.root, entry.rel, out);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, out, 'utf8');
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
function applyExternalText(root, rel, text) {
  const entry = docs.get(keyOf(root, rel));
  if (!entry) return;
  entry.eol = eolOf(text);
  applyText(entry.ytext, normEol(text), 'disk');
}

// The file on disk is no longer UTF-8 (restore/upload of a Latin-1 file): the live
// doc can't hold it. Disconnect its clients (they reopen and get the 415) and forget
// the state - without writing the doc back over the new file.
function dropDoc(root, rel) {
  const entry = docs.get(keyOf(root, rel));
  if (entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.dirty = false;
    for (const ws of [...entry.conns.keys()]) {
      try {
        ws.close(4415, 'not utf-8');
      } catch {}
      closeConn(entry, ws);
    }
    if (docs.get(entry.key) === entry) {
      docs.delete(entry.key);
      entry.awareness.destroy();
      entry.ydoc.destroy();
    }
  }
  fs.rmSync(statePath(root, rel), { force: true });
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
  const next = normEol(fn(entry.ytext.toString()));
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
  dropDoc,
  onPathMoved,
  flushRoot,
  flushAll,
  applyText,
  readText,
  editText,
};
