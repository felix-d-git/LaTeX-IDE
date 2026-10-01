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
    const { comments } = await api.getComments();
    byFile = comments || {};
  }

  // Anchors live in the file's Y.Doc (map "anchors": id -> Yjs relative
  // positions), so they move with every edit - collaborators', external
  // ones, offline ones. The stored offsets are only the fallback.
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
        setAnchor(relPath, c); // comment from before anchors existed
        return c;
      }
      const from = abs(a.f);
      const to = abs(a.t);
      return from === null || to === null ? c : { ...c, from, to: Math.max(from, to) };
    });
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

  return { loadAll, getForFile, addComment, removeComment };
}
