// Gemeinsame Text-Einfüge-Helfer für Menüleiste (R2) und die neue
// Formatierungs-Toolbar über dem Editor (R5) — beide lösen dieselben
// Aktionen aus, deshalb liegen sie hier statt doppelt in beiden Modulen.
import { EditorState } from '@codemirror/state';
import { ySyncAnnotation } from 'y-codemirror.next';

// Rolle „Nur kommentieren“: EditorState.readOnly sperrt nur Tippen, nicht
// view.dispatch (Toolbar, Menüs, Kontextmenü, Vorschlag annehmen) - der
// Filter lässt nur Änderungen von anderen (ySync) ins Dokument.
export const reviewerReadOnly = [
  EditorState.readOnly.of(true),
  EditorState.changeFilter.of((tr) => !!tr.annotation(ySyncAnnotation)),
];

const CURSOR = '${|}';

export function insertAtCursor(view, text, { selectInner } = {}) {
  if (view.state.readOnly) return;
  const marker = text.indexOf(CURSOR); // Snippets: Marker = Cursorposition
  if (marker >= 0) {
    selectInner = marker;
    text = text.replace(CURSOR, '');
  }
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + (selectInner ?? text.length) },
  });
  view.focus();
}

export function wrapSelection(view, before, after) {
  if (view.state.readOnly) return;
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const insert = before + selected + after;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: selected
      ? { anchor: sel.from, head: sel.from + insert.length }
      : { anchor: sel.from + before.length },
  });
  view.focus();
}

// prefix endet auf "{}" (z. B. section{}): nicht leere Zeile wird umschlossen, leere bekommt den Cursor in die Klammern.
export function insertAtLineStart(view, prefix) {
  if (view.state.readOnly) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!line.text.trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: prefix },
      selection: { anchor: line.from + prefix.length - 1 },
    });
  } else {
    const lead = line.text.match(/^\s*/)[0].length;
    view.dispatch({
      changes: [
        { from: line.from + lead, insert: prefix.slice(0, -1) },
        { from: line.to, insert: '}' },
      ],
      selection: { anchor: line.to + prefix.length },
    });
  }
  view.focus();
}

export const SNIPPETS = {
  figure:
    '\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${|}}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n',
  table:
    '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{ll}\n    A & B \\\\\n  \\end{tabular}\n  \\caption{${|}}\n  \\label{tab:}\n\\end{table}\n',
  itemize: '\\begin{itemize}\n  \\item ${|}\n\\end{itemize}\n',
  enumerate: '\\begin{enumerate}\n  \\item ${|}\n\\end{enumerate}\n',
  abstract: '\\begin{abstract}\n${|}\n\\end{abstract}\n',
};
