import { EditorView, Decoration } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { api } from './api.js';

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

  function getForFile(relPath) {
    return byFile[relPath] || [];
  }

  async function addComment(relPath, from, to, anchorText, text) {
    const { comment } = await api.addComment(relPath, from, to, anchorText, text);
    byFile[relPath] = [...(byFile[relPath] || []), comment];
    return comment;
  }

  async function removeComment(relPath, id) {
    await api.deleteComment(relPath, id);
    byFile[relPath] = (byFile[relPath] || []).filter((c) => c.id !== id);
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

  return { loadAll, getForFile, addComment, removeComment, editComment, addReply, editReply, removeReply };
}
