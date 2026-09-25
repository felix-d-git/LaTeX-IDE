import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { StateField, StateEffect, Annotation } from '@codemirror/state';
import { ySyncAnnotation } from 'y-codemirror.next';

// Scoped-down "Reviewing" mode: real Overleaf keeps deleted text visible
// (struck through) in place until a change is resolved, which needs a
// transaction filter rewriting every delete - too risky to get 100% right
// here. Instead: deletions really happen (safe, standard editor behavior),
// and are recorded as a small inline marker + Review-panel entry that can
// restore the exact removed text on "Reject". Insertions ARE tracked in
// place (colored/underlined) like the real thing. Both are in-memory only
// (lost on reload) - not persisted to disk like comments are.

const skipTracking = Annotation.define();
const removeChangeEffect = StateEffect.define(); // value: change id to stop tracking

let reviewing = false;
export function setReviewingMode(on) {
  reviewing = on;
}
export function isReviewingMode() {
  return reviewing;
}

let nextId = 1;

class DeletionWidget extends WidgetType {
  constructor(id, text) {
    super();
    this.id = id;
    this.text = text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-tracked-delete-marker';
    span.textContent = '⌫';
    const preview = this.text.length > 40 ? this.text.slice(0, 40) + '…' : this.text;
    span.title = `Gelöscht: "${preview}" (im Review-Panel ansehen)`;
    span.dataset.tcId = String(this.id);
    span.dataset.tcType = 'delete';
    return span;
  }
  eq(other) {
    return other.id === this.id;
  }
}

function insertMark(id) {
  return Decoration.mark({ class: 'cm-tracked-insert', attributes: { 'data-tc-id': String(id), 'data-tc-type': 'insert' } });
}

function idOf(decoration) {
  const spec = decoration.spec;
  if (spec.widget instanceof DeletionWidget) return spec.widget.id;
  if (spec.attributes) return Number(spec.attributes['data-tc-id']);
  return null;
}

// Single module-level field definition, shared across every file's editor
// state (like `flashField` in editor.js) - each EditorState keeps its own
// independent value for it, so per-file isolation still holds.
export const trackChangesField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);

    // Edits arriving from collaborators (ySync) are theirs, not tracked as mine.
    if (reviewing && tr.docChanged && !tr.annotation(skipTracking) && !tr.annotation(ySyncAnnotation)) {
      const adds = [];
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (toB > fromB) {
          adds.push(insertMark(nextId++).range(fromB, toB));
        }
        if (toA > fromA) {
          const text = tr.startState.doc.sliceString(fromA, toA);
          adds.push(Decoration.widget({ widget: new DeletionWidget(nextId++, text), side: 1 }).range(fromB));
        }
      });
      if (adds.length) deco = deco.update({ add: adds, sort: true });
    }

    for (const e of tr.effects) {
      if (e.is(removeChangeEffect)) {
        const kept = [];
        const cur = deco.iter();
        while (cur.value) {
          if (idOf(cur.value) !== e.value) kept.push(cur.value.range(cur.from, cur.to));
          cur.next();
        }
        deco = Decoration.set(kept, true);
      }
    }

    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function listChanges(view) {
  const deco = view.state.field(trackChangesField);
  const items = [];
  const cur = deco.iter();
  while (cur.value) {
    const spec = cur.value.spec;
    if (spec.widget instanceof DeletionWidget) {
      items.push({ id: spec.widget.id, type: 'delete', from: cur.from, to: cur.from, text: spec.widget.text });
    } else {
      items.push({ id: Number(spec.attributes['data-tc-id']), type: 'insert', from: cur.from, to: cur.to, text: view.state.sliceDoc(cur.from, cur.to) });
    }
    cur.next();
  }
  items.sort((a, b) => a.from - b.from);
  return items;
}

function findRange(view, id) {
  const deco = view.state.field(trackChangesField);
  const cur = deco.iter();
  while (cur.value) {
    if (idOf(cur.value) === id) return { from: cur.from, to: cur.to, decoration: cur.value };
    cur.next();
  }
  return null;
}

// Accept: stop tracking the change, text stays exactly as it currently is
// (insertion becomes normal committed text; deletion was already applied for real).
export function acceptChange(view, id) {
  view.dispatch({ effects: removeChangeEffect.of(id), annotations: skipTracking.of(true) });
}

// Reject: undo the change's effect (remove the tracked insertion's text, or
// restore a tracked deletion's text) and stop tracking it.
export function rejectChange(view, id) {
  const found = findRange(view, id);
  if (!found) return;
  const isDelete = found.decoration.spec.widget instanceof DeletionWidget;
  if (isDelete) {
    view.dispatch({
      changes: { from: found.from, to: found.from, insert: found.decoration.spec.widget.text },
      effects: removeChangeEffect.of(id),
      annotations: skipTracking.of(true),
    });
  } else {
    view.dispatch({
      changes: { from: found.from, to: found.to, insert: '' },
      effects: removeChangeEffect.of(id),
      annotations: skipTracking.of(true),
    });
  }
}
