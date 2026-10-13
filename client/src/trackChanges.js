import { Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import * as Y from 'yjs';
import { ySyncAnnotation } from 'y-codemirror.next';
import { getSession, getMe } from './collab.js';

// Tracked changes live in the file's Y.Doc (map "review"), next to the text:
// persisted with the Yjs state, synced live to collaborators, and anchored
// with Yjs relative positions so they survive anyone's edits.
// Insertions stay in the text (marked); deletions really happen (the .tex on
// disk never contains suggested-away text) but stay visible struck through
// until accepted (forget) or rejected (text restored).

let reviewing = false;
export function setReviewingMode(on) {
  reviewing = on;
}
export function isReviewingMode() {
  return reviewing;
}

const refresh = StateEffect.define();
let onRemoteChange = null; // review panel re-render when only the map changed
export function onReviewChanged(fn) {
  onRemoteChange = fn;
}
const relOf = (ytext, i, assoc = 0) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, i, assoc));
const absOf = (ydoc, j) => {
  const a = j && Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), ydoc);
  return a ? a.index : null;
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

class DeletionWidget extends WidgetType {
  constructor(id, text, color) {
    super();
    this.id = id;
    this.text = text;
    this.color = color;
  }
  toDOM() {
    const span = document.createElement('del');
    span.className = 'cm-tracked-delete';
    span.textContent = this.text;
    if (this.color) span.style.color = this.color;
    span.dataset.tcId = this.id;
    span.dataset.tcType = 'delete';
    return span;
  }
  eq(other) {
    return other.id === this.id && other.text === this.text;
  }
}

// All changes of a file with absolute positions in the current text.
export function listChanges(path) {
  const s = getSession(path);
  if (!s || !s.ydoc.getMap('review').size) return [];
  const text = s.ytext.toString();
  const out = [];
  s.ydoc.getMap('review').forEach((c, id) => {
    const from = absOf(s.ydoc, c.f);
    const to = c.type === 'insert' ? absOf(s.ydoc, c.t) : from;
    if (from === null || to === null || to < from || (c.type === 'insert' && to === from)) return;
    out.push({ ...c, id, from, to, text: c.type === 'insert' ? text.slice(from, to) : c.text });
  });
  return out.sort((a, b) => a.from - b.from);
}

// Accept: forget the change, text stays as it is.
export function acceptChange(path, id) {
  const s = getSession(path);
  if (!s) return;
  // Own undo step, not merged into the typing just before it.
  s.undoManager.stopCapturing();
  s.ydoc.getMap('review').delete(id);
  s.undoManager.stopCapturing();
}

// Reject: remove the suggested insertion / restore the deleted text.
export function rejectChange(path, id) {
  const s = getSession(path);
  const item = s && listChanges(path).find((c) => c.id === id);
  if (!item) return;
  s.undoManager.stopCapturing();
  s.ydoc.transact(() => {
    if (item.type === 'insert') s.ytext.delete(item.from, item.to - item.from);
    else s.ytext.insert(item.from, item.text);
    s.ydoc.getMap('review').delete(id);
  });
  s.undoManager.stopCapturing();
}

export function trackChanges(path) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.session = getSession(path);
        this.map = this.session.ydoc.getMap('review');
        this.items = listChanges(path);
        this.decorations = this.build(view);
        this.onMap = () =>
          queueMicrotask(() => {
            view.dispatch({ effects: refresh.of(null) });
            if (onRemoteChange) onRemoteChange(path);
          });
        this.map.observe(this.onMap);
      }
      update(u) {
        const local = u.docChanged && !u.transactions.some((tr) => tr.annotation(ySyncAnnotation));
        if (reviewing && local) this.record(u);
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) {
          this.items = listChanges(path);
          this.decorations = this.build(u.view);
        }
      }
      // Positions of this.items are still in the old document here.
      record(u) {
        const me = getMe();
        const { ytext, ydoc } = this.session;
        const mine = this.items.filter((c) => c.user && c.user.id === me.id);
        ydoc.transact(() => {
          u.changes.iterChanges((fromA, toA, fromB, toB) => {
            if (toA > fromA) {
              const deleted = u.startState.doc.sliceString(fromA, toA);
              // Deleting inside your own suggestion just shortens it.
              if (!mine.some((c) => c.type === 'insert' && c.from <= fromA && toA <= c.to)) {
                const back = mine.find((c) => c.type === 'delete' && c.from === toA); // Backspace burst
                const fwd = mine.find((c) => c.type === 'delete' && c.from === fromA); // Delete burst
                if (back) this.map.set(back.id, { ...this.raw(back), text: deleted + back.text, f: relOf(ytext, fromB) });
                else if (fwd) this.map.set(fwd.id, { ...this.raw(fwd), text: fwd.text + deleted });
                else this.map.set(newId(), { type: 'delete', f: relOf(ytext, fromB), text: deleted, user: me, at: Date.now() });
              }
            }
            if (toB > fromB) {
              const inside = mine.some((c) => c.type === 'insert' && c.from < fromA && fromA < c.to);
              const after = mine.find((c) => c.type === 'insert' && c.to === fromA);
              const before = mine.find((c) => c.type === 'insert' && c.from === toA);
              if (inside) return;
              if (after) this.map.set(after.id, { ...this.raw(after), t: relOf(ytext, toB, -1) });
              else if (before) this.map.set(before.id, { ...this.raw(before), f: relOf(ytext, fromB) });
              else this.map.set(newId(), { type: 'insert', f: relOf(ytext, fromB), t: relOf(ytext, toB, -1), user: me, at: Date.now() });
            }
          });
        });
      }
      raw(c) {
        return this.map.get(c.id);
      }
      build(view) {
        const len = view.state.doc.length;
        const ranges = [];
        for (const c of this.items) {
          if (c.to > len) continue;
          const color = c.user && c.user.color;
          if (c.type === 'insert') {
            ranges.push(
              Decoration.mark({
                class: 'cm-tracked-insert',
                attributes: { 'data-tc-id': c.id, 'data-tc-type': 'insert', style: color ? `--tc-color:${color}` : '' },
              }).range(c.from, c.to)
            );
          } else {
            ranges.push(Decoration.widget({ widget: new DeletionWidget(c.id, c.text, color), side: -1 }).range(c.from));
          }
        }
        return Decoration.set(ranges, true);
      }
      destroy() {
        this.map.unobserve(this.onMap);
      }
    },
    { decorations: (v) => v.decorations }
  );
}
