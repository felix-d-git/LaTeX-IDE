import { EditorView, Decoration } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import * as Y from 'yjs';
import { api } from './api.js';
import { getSession } from './collab.js';

const setCommentsEffect = StateEffect.define();

function markFor(comment) {
  const from = Math.min(comment.from, comment.to);
  const to = Math.max(comment.from, comment.to);
  if (from === to) return null;
  return Decoration.mark({
    class: 'cm-comment-highlight',
    attributes: { 'data-comment-id': comment.id },
  }).range(from, to);
}

function decorationsFrom(list) {
  const ranges = (list || []).map(markFor).filter(Boolean);
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

// Per-tab StateField: seeded once from the file's persisted comments when the
// tab is built, afterwards kept in sync via setCommentsEffect dispatches.
export function commentField(initialComments) {
  return StateField.define({
    create() {
      return decorationsFrom(initialComments);
    },
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setCommentsEffect)) deco = decorationsFrom(e.value);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export { setCommentsEffect };

export function createCommentsManager() {
  let byFile = {};

  async function loadAll() {
    try {
      byFile = (await api.getComments()).comments || {};
    } catch (e) {
      if (!(e.data && e.data.offline)) throw e; // offline and never cached: no comments, no error
      byFile = {};
    }
  }

  // Anchors live in the file's Y.Doc (map "anchors": id -> Yjs relative
  // positions), so they move with every edit - collaborators', external
  // ones, offline ones. The stored offsets are only the fallback.
  // Offsets (Altbestand, MCP) nur verankern, wenn der Text dort noch zum anchorText passt;
  // sonst die erste Fundstelle nehmen. Gibt den (ggf. korrigierten) Kommentar oder null zurueck.
  function verified(s, c) {
    const a = c.anchorText;
    if (!a) return c;
    const t = s.ytext.toString();
    if (t.slice(c.from, c.to) === a) return c;
    const i = t.indexOf(a);
    return i < 0 ? null : { ...c, from: i, to: i + a.length };
  }

  function setAnchor(relPath, c) {
    const s = getSession(relPath);
    if (!s || c.from === c.to || c.to > s.ytext.length) return;
    const rel = (i, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(s.ytext, i, assoc));
    s.ydoc.getMap('anchors').set(c.id, { f: rel(Math.min(c.from, c.to), 0), t: rel(Math.max(c.from, c.to), -1) });
  }

  function getForFile(relPath) {
    const list = byFile[relPath] || [];
    const s = getSession(relPath);
    if (!s) return list;
    const anchors = s.ydoc.getMap('anchors');
    const abs = (j) => {
      const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), s.ydoc);
      return a ? a.index : null;
    };
    return list.map((c) => {
      const a = anchors.get(c.id);
      if (!a) {
        const v = verified(s, c); // comment from before anchors existed
        if (!v) return c;
        setAnchor(relPath, v);
        return v;
      }
      const from = abs(a.f);
      const to = abs(a.t);
      return from === null || to === null ? c : { ...c, from, to: Math.max(from, to) };
    });
  }

  // Auswahl sofort als Yjs-Relativpositionen festhalten (Mitarbeitende tippen weiter) ...
  function captureRange(relPath, from, to) {
    const s = getSession(relPath);
    if (!s || to > s.ytext.length) return null;
    const rel = (i, assoc) => Y.createRelativePositionFromTypeIndex(s.ytext, i, assoc);
    return { f: rel(from, 0), t: rel(to, -1) };
  }

  // ... und beim Absenden zurueckrechnen; null = Text wurde inzwischen geloescht.
  function resolveRange(relPath, cap, fallback) {
    const s = getSession(relPath);
    if (!s || !cap) return fallback;
    const abs = (r) => Y.createAbsolutePositionFromRelativePosition(r, s.ydoc);
    const f = abs(cap.f);
    const t = abs(cap.t);
    if (!f || !t || t.index <= f.index) return null;
    return { from: f.index, to: t.index };
  }

  async function addComment(relPath, from, to, anchorText, text) {
    const { comment } = await api.addComment(relPath, from, to, anchorText, text);
    byFile[relPath] = [...(byFile[relPath] || []), comment];
    setAnchor(relPath, comment);
    return comment;
  }

  async function removeComment(relPath, id) {
    await api.deleteComment(relPath, id);
    byFile[relPath] = (byFile[relPath] || []).filter((c) => c.id !== id);
    const s = getSession(relPath);
    if (s) s.ydoc.getMap('anchors').delete(id);
  }

  // Server liefert den ganzen aktualisierten Kommentar (inkl. Antworten) zurueck.
  async function change(relPath, call) {
    const { comment } = await call;
    byFile[relPath] = (byFile[relPath] || []).map((c) => (c.id === comment.id ? comment : c));
  }

  const editComment = (relPath, id, text) => change(relPath, api.editComment(relPath, id, text));
  const addReply = (relPath, id, text) => change(relPath, api.addReply(relPath, id, text));
  const editReply = (relPath, id, rid, text) => change(relPath, api.editReply(relPath, id, rid, text));
  const removeReply = (relPath, id, rid) => change(relPath, api.deleteReply(relPath, id, rid));

  return { loadAll, getForFile, captureRange, resolveRange, addComment, removeComment, editComment, addReply, editReply, removeReply };
}
