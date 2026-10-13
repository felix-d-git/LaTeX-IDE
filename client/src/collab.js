// Live collaboration client: one Y.Doc per open text file, synced to the
// server over /yjs and cached in IndexedDB, so files stay editable offline.
// Yjs merges concurrent edits automatically; only when edits made while
// offline hit the same lines as edits someone else made meanwhile do we flag
// a conflict (line highlight + entry in the review panel).
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { ySyncFacet } from 'y-codemirror.next';
import { api } from './api.js';
import { offlineBanner } from './offlineBanner.js';

const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#e377c2', '#8c564b'];

let projectId = null;
let me = { name: 'Ich', color: COLORS[0] };
const sessions = new Map(); // path -> session
const opening = new Map(); // path -> Promise<session>
let maxPayload = 64 * 1024 * 1024; // server's WebSocket limit, updated from /api/collab/epoch
let hooks = { onStatus: () => {}, onConflicts: () => {}, onReset: () => {}, onGone: () => {} };

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      if (v === null || (Array.isArray(v) && !v.length)) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

export function configureCollab(h) {
  hooks = { ...hooks, ...h };
}

export function setCollabUser(user) {
  let hash = 0;
  for (const c of user.id || user.username || '') hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  me = { id: user.id, name: user.username || user.email, color: COLORS[hash % COLORS.length] };
  for (const s of sessions.values()) s.provider.awareness.setLocalStateField('user', { ...me, colorLight: me.color + '33' });
}

export function getMe() {
  return me;
}

export function setCollabProject(id) {
  if (id === projectId) return;
  closeAllSessions();
  projectId = id;
}

export function getSession(path) {
  return sessions.get(path) || null;
}

export function isOnline() {
  if (!sessions.size) return navigator.onLine;
  return [...sessions.values()].every((s) => s.provider.wsconnected);
}

function wsBase() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`;
}

// Walk a Y.Text delta and return the touched ranges (in post-change positions).
function deltaRanges(delta) {
  const out = [];
  let i = 0;
  for (const d of delta) {
    if (d.retain) i += d.retain;
    else if (d.insert) {
      const len = typeof d.insert === 'string' ? d.insert.length : 1;
      out.push([i, i + len]);
      i += len;
    } else if (d.delete) out.push([i, i]);
  }
  return out;
}

export function openSession(path) {
  if (sessions.has(path)) return Promise.resolve(sessions.get(path));
  if (!opening.has(path)) {
    const p = createSession(path).finally(() => opening.delete(path));
    opening.set(path, p);
  }
  return opening.get(path);
}

async function createSession(path) {
  const pid = projectId;
  const epochKey = `lide-epoch:${pid}:${path}`;
  let epoch;
  const offline = offlineBanner.isOffline(); // known offline: no request, use the stored epoch at once
  try {
    if (offline && store.get(epochKey, null)) throw Object.assign(new Error('offline'), { data: { offline: true }, status: 503 });
    const r = await api.collabEpoch(path);
    // Server answers for the *active* project - a project switch in between would mix caches.
    if (r.projectId !== pid) throw Object.assign(new Error('Projekt wurde gewechselt.'), { status: 409 });
    epoch = r.epoch;
    if (r.maxPayload) maxPayload = r.maxPayload;
    store.set(epochKey, epoch);
  } catch (e) {
    // real server answer (404, 403) - not an offline situation; the desktop app answers 503 {offline}
    if (e.status && !(e.data && e.data.offline)) throw e;
    epoch = store.get(epochKey, null);
    if (!epoch) throw new Error('Offline – diese Datei wurde auf diesem Gerät noch nie geöffnet und ist daher nicht zwischengespeichert.');
  }
  const dbName = `latex-ide:${pid}:${path}:${epoch}`;
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');
  const idb = new IndexeddbPersistence(dbName, ydoc);
  await idb.whenSynced;
  const hasLocal = ydoc.store.clients.size > 0;

  const provider = new WebsocketProvider(wsBase(), `${encodeURIComponent(pid)}/${encodeURIComponent(path)}`, ydoc, {
    params: { epoch },
    // 1009 = message too large: retrying would resend the same update forever.
    shouldReconnect: (ev) => ev.code !== 1009 && !(ev.code >= 4400 && ev.code < 4500),
  });
  provider.awareness.setLocalStateField('user', { ...me, colorLight: me.color + '33' });
  const undoManager = new Y.UndoManager(ytext);

  const pendingKey = `lide-offline:${dbName}`;
  const conflictKey = `lide-conflicts:${dbName}`;
  const s = {
    path,
    dbName,
    ydoc,
    ytext,
    provider,
    awareness: provider.awareness,
    undoManager,
    idb,
    pending: store.get(pendingKey, []), // local edits made while offline (relative positions)
    conflicts: store.get(conflictKey, []),
    resync: null, // remote ranges collected while catching up after being offline
  };
  const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, i));
  const abs = (j) => {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), ydoc);
    return a ? a.index : null;
  };
  s.toAbs = abs;

  ytext.observe((event, tr) => {
    if (tr.local && !provider.synced) {
      for (const [a, b] of deltaRanges(event.delta)) s.pending.push([rel(a), rel(b)]);
      store.set(pendingKey, s.pending);
    } else if (tr.origin === provider && s.resync) {
      for (const [a, b] of deltaRanges(event.delta)) s.resync.push([rel(a), rel(b)]);
    }
  });

  provider.on('status', ({ status }) => {
    if (status === 'connected' && s.pending.length) s.resync = [];
    hooks.onStatus(isOnline());
  });

  provider.on('sync', (synced) => {
    if (!synced || !s.resync) return;
    detectConflicts(s);
    s.resync = null;
    s.pending = [];
    store.set(pendingKey, null);
    store.set(conflictKey, s.conflicts);
  });

  provider.on('connection-close', (ev) => {
    const code = ev && ev.code;
    if (code === 4409) {
      // Server re-created this doc (state lost) - our cache belongs to the old
      // identity and would duplicate the text if merged.
      // ponytail: unsynced offline edits in that old cache are dropped here.
      closeSession(path);
      indexedDB.deleteDatabase(dbName);
      store.set(pendingKey, null);
      store.set(conflictKey, null);
      hooks.onReset(path);
    } else if (code === 4404) {
      closeSession(path);
      hooks.onGone(path);
    } else if (code === 1009) {
      alert(
        `Diese Änderung ist zu groß für die Live-Synchronisierung (max. ${Math.round(maxPayload / 1048576)} MB) und wurde NICHT auf dem Server gespeichert. ` +
          'Bitte rückgängig machen (Strg+Z) oder die Datei über Hochladen ersetzen.',
      );
      // Stays disconnected (banner shows "offline") until the document fits again, e.g. after Strg+Z.
      const retry = () => {
        if (Y.encodeStateAsUpdate(ydoc).length >= maxPayload) return;
        ydoc.off('update', retry);
        provider.connect();
      };
      ydoc.on('update', retry);
    }
  });

  // Wait for the server's state. With a local copy, don't block long on an
  // unreachable server - edit offline, it syncs once the connection is back.
  await new Promise((resolve, reject) => {
    if (provider.synced) return resolve();
    const done = () => {
      clearTimeout(t1);
      clearTimeout(t2);
      resolve();
    };
    provider.once('sync', done);
    const t1 = hasLocal ? setTimeout(done, offline ? 0 : 2500) : null;
    const t2 = hasLocal
      ? null
      : setTimeout(() => {
          provider.destroy();
          idb.destroy();
          ydoc.destroy();
          reject(new Error('Server nicht erreichbar und keine lokale Kopie vorhanden.'));
        }, offline ? 3000 : 15000);
  });
  if (projectId !== pid) {
    provider.destroy();
    idb.destroy();
    ydoc.destroy();
    throw new Error('Projekt wurde gewechselt.');
  }
  sessions.set(path, s);
  hooks.onStatus(isOnline());
  if (s.conflicts.length) hooks.onConflicts(path);
  return s;
}

function lineSpan(text, from, to) {
  const start = text.lastIndexOf('\n', from - 1) + 1;
  let end = text.indexOf('\n', to);
  if (end < 0) end = text.length;
  return [start, end];
}

function detectConflicts(s) {
  const text = s.ytext.toString();
  const toLines = (list) =>
    list
      .map(([a, b]) => [s.toAbs(a), s.toAbs(b)])
      .filter(([a, b]) => a !== null && b !== null)
      .map(([a, b]) => lineSpan(text, Math.min(a, b), Math.max(a, b)));
  const mine = toLines(s.pending);
  const theirs = toLines(s.resync);
  const found = [];
  for (const [ma, mb] of mine) {
    for (const [ta, tb] of theirs) {
      if (ma > tb || ta > mb) continue;
      const a = Math.min(ma, ta);
      const b = Math.max(mb, tb);
      const hit = found.find((f) => !(a > f[1] || f[0] > b));
      if (hit) {
        hit[0] = Math.min(hit[0], a);
        hit[1] = Math.max(hit[1], b);
      } else found.push([a, b]);
    }
  }
  if (!found.length) return;
  const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(s.ytext, i));
  for (const [a, b] of found) {
    s.conflicts.push({ id: Math.random().toString(36).slice(2), from: rel(a), to: rel(b), at: Date.now() });
  }
  hooks.onConflicts(s.path);
}

// Absolute ranges of this file's unresolved conflicts (for decorations + review panel).
export function listConflicts(path) {
  const s = sessions.get(path);
  if (!s) return [];
  return s.conflicts
    .map((c) => ({ id: c.id, from: s.toAbs(c.from), to: s.toAbs(c.to), at: c.at }))
    .filter((c) => c.from !== null && c.to !== null);
}

export function resolveConflict(path, id) {
  const s = sessions.get(path);
  if (!s) return;
  s.conflicts = s.conflicts.filter((c) => c.id !== id);
  store.set(`lide-conflicts:${s.dbName}`, s.conflicts);
  hooks.onConflicts(path);
}

// Desktop app: pull every text file's doc into IndexedDB while online, so
// files never opened on this device can still be edited offline.
// 4 files in parallel, one WebSocket each.
export async function prewarm(paths) {
  const queue = [...paths];
  await Promise.all(Array.from({ length: 4 }, () => prewarmWorker(queue)));
}

async function prewarmWorker(queue) {
  const pid = projectId;
  for (let path; (path = queue.shift()); ) {
    if (projectId !== pid || !navigator.onLine || offlineBanner.isOffline()) return;
    if (sessions.has(path) || opening.has(path)) continue;
    try {
      const r = await api.collabEpoch(path);
      if (r.projectId !== pid) return;
      store.set(`lide-epoch:${pid}:${path}`, r.epoch);
      const ydoc = new Y.Doc();
      const idb = new IndexeddbPersistence(`latex-ide:${pid}:${path}:${r.epoch}`, ydoc);
      await idb.whenSynced;
      const provider = new WebsocketProvider(wsBase(), `${encodeURIComponent(pid)}/${encodeURIComponent(path)}`, ydoc, { params: { epoch: r.epoch } });
      await new Promise((resolve) => {
        provider.once('sync', resolve);
        setTimeout(resolve, 10000);
      });
      provider.destroy();
      idb.destroy();
      ydoc.destroy();
    } catch {
      return; // offline or project switched - try again next time
    }
  }
}

export function closeSession(path) {
  const s = sessions.get(path);
  if (!s) return;
  sessions.delete(path);
  s.provider.destroy();
  s.idb.destroy();
  s.undoManager.destroy();
  s.ydoc.destroy();
  hooks.onStatus(isOnline());
}

export function closeAllSessions() {
  for (const path of [...sessions.keys()]) closeSession(path);
}

// Texts of all open files - the desktop app compiles these even if the
// server can't be reached right now.
export function openTexts() {
  const out = {};
  for (const [path, s] of sessions) out[path] = s.ytext.toString();
  return out;
}

// Undo/redo for menu + toolbar buttons: Yjs keeps the history (own edits only).
function sessionOfView(view) {
  const conf = view.state.facet(ySyncFacet);
  return conf ? [...sessions.values()].find((s) => s.ytext === conf.ytext) : null;
}
export const yUndo = (view) => {
  const s = sessionOfView(view);
  return !!s && s.undoManager.undo() != null;
};
export const yRedo = (view) => {
  const s = sessionOfView(view);
  return !!s && s.undoManager.redo() != null;
};

// --- CodeMirror: conflict line highlight ---

export const setConflictsEffect = StateEffect.define();
const conflictLine = Decoration.line({ attributes: { class: 'cm-collab-conflict', title: 'Offline-Konflikt – im Review-Panel prüfen' } });

export const conflictField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setConflictsEffect)) continue;
      const doc = tr.state.doc;
      const marks = [];
      for (const c of e.value) {
        const from = doc.lineAt(Math.min(c.from, doc.length)).number;
        const to = doc.lineAt(Math.min(c.to, doc.length)).number;
        for (let ln = from; ln <= to; ln++) marks.push(conflictLine.range(doc.line(ln).from));
      }
      deco = Decoration.set(marks, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
