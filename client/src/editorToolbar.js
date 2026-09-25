import { undo, redo } from '@codemirror/commands';
import { insertAtCursor, wrapSelection, insertAtLineStart, SNIPPETS } from './editorCommands.js';

// R5: 32px-Formatierungsleiste über dem Text, Buttons 24x24 mit 4px Radius,
// links Formatierung, Mitte der Code/Visual-Umschalter, rechts Werkzeuge.
export function setupEditorToolbar({ getView, onFind, onFindInProject, onAddComment }) {
  const bar = document.getElementById('editor-toolbar');
  const left = bar.querySelector('.ol-toolbar-left');
  const mode = bar.querySelector('.ol-toolbar-mode');
  const right = bar.querySelector('.ol-toolbar-right');

  const withView = (fn) => () => {
    const v = getView();
    if (v) fn(v);
  };

  function button(icon, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = `<svg class="ol-icon"><use href="#i-${icon}"></use></svg>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function separator() {
    const sep = document.createElement('span');
    sep.className = 'ol-toolbar-sep';
    return sep;
  }

  left.append(
    button('bold', 'Fett (\\textbf)', withView((v) => wrapSelection(v, '\\textbf{', '}'))),
    button('italic', 'Kursiv (\\textit)', withView((v) => wrapSelection(v, '\\textit{', '}'))),
    separator(),
    button('heading', 'Section', withView((v) => insertAtLineStart(v, '\\section{}'))),
    button('list-bullet', 'Aufzählung', withView((v) => insertAtCursor(v, SNIPPETS.itemize))),
    button('list-number', 'Nummerierte Liste', withView((v) => insertAtCursor(v, SNIPPETS.enumerate))),
    separator(),
    button('link', 'Link einfügen', () => {
      const v = getView();
      if (!v) return;
      const url = prompt('URL:', 'https://');
      if (!url) return;
      const label = prompt('Anzeigetext:', url) || url;
      insertAtCursor(v, `\\href{${url}}{${label}}`);
    }),
    button('math', 'Formel einfügen', withView((v) => insertAtCursor(v, '$$\n\n$$', { selectInner: 3 }))),
    button('image', 'Abbildung einfügen', withView((v) => insertAtCursor(v, SNIPPETS.figure))),
    button('table', 'Tabelle einfügen', withView((v) => insertAtCursor(v, SNIPPETS.table)))
  );

  const codeBtn = document.createElement('button');
  codeBtn.type = 'button';
  codeBtn.className = 'mode-btn is-active';
  codeBtn.textContent = 'Code';
  const visualBtn = document.createElement('button');
  visualBtn.type = 'button';
  visualBtn.className = 'mode-btn';
  visualBtn.textContent = 'Visual';
  visualBtn.title = 'Rich-Text-Modus – nicht umgesetzt (Backlog, siehe STATUS.md)';
  visualBtn.addEventListener('click', () =>
    alert('"Visual"-Modus (Rich Text) ist nicht umgesetzt – der Editor arbeitet im Code-Modus.')
  );
  mode.append(codeBtn, visualBtn);

  right.append(
    button('undo', 'Rückgängig', withView(undo)),
    button('redo', 'Wiederholen', withView(redo)),
    separator(),
    button('search', 'In dieser Datei suchen/ersetzen (Strg+F)', () => onFind && onFind()),
    button('comment', 'Kommentar zur Auswahl', () => onAddComment && onAddComment())
  );

  return {
    setVisible(visible) {
      bar.classList.toggle('hidden', !visible);
    },
    isVisible() {
      return !bar.classList.contains('hidden');
    },
  };
}
