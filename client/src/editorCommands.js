// Gemeinsame Text-Einfüge-Helfer für Menüleiste (R2) und die neue
// Formatierungs-Toolbar über dem Editor (R5) — beide lösen dieselben
// Aktionen aus, deshalb liegen sie hier statt doppelt in beiden Modulen.

export function insertAtCursor(view, text, { selectInner } = {}) {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + (selectInner ?? text.length) },
  });
  view.focus();
}

export function wrapSelection(view, before, after) {
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

export function insertAtLineStart(view, prefix) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({
    changes: { from: line.from, insert: prefix },
    selection: { anchor: line.from + prefix.length },
  });
  view.focus();
}

export const SNIPPETS = {
  figure:
    '\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n',
  table:
    '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{ll}\n    A & B \\\\\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}\n',
  itemize: '\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  enumerate: '\\begin{enumerate}\n  \\item \n\\end{enumerate}\n',
  abstract: '\\begin{abstract}\n\n\\end{abstract}\n',
};
