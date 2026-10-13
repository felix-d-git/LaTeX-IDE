import { yUndo as undo, yRedo as redo } from './collab.js';
import { openDropdown, closeDropdown, isDropdownOpenFor } from './dropdown.js';
import { insertAtCursor, wrapSelection, insertAtLineStart, SNIPPETS } from './editorCommands.js';

// R5: 32px-Formatierungsleiste über dem Text, Buttons 24x24 mit 4px Radius,
// links Formatierung, Mitte der Code/Visual-Umschalter, rechts Werkzeuge.
export function setupEditorToolbar({ getView, onFind, onFindInProject, onAddComment, onSetVisual, isVisual }) {
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
      if (!v || v.state.readOnly) return;
      const url = prompt('URL:', 'https://');
      if (!url) return;
      const label = prompt('Anzeigetext:', url) || url;
      insertAtCursor(v, `\\href{${url}}{${label}}`);
    }),
    button('math', 'Formel einfügen', withView((v) => insertAtCursor(v, '$$\n\n$$', { selectInner: 3 }))),
    button('image', 'Abbildung einfügen', withView((v) => insertAtCursor(v, SNIPPETS.figure))),
    button('table', 'Tabelle einfügen', withView((v) => insertAtCursor(v, SNIPPETS.table)))
  );

  // Zu schmal → Formatierungs-Buttons von rechts in ein "…"-Popover (wie Overleaf).
  const items = [...left.children];
  let overflowed = [];
  const more = button('dots', 'Weitere Werkzeuge', (e) => {
    e.stopPropagation();
    if (isDropdownOpenFor(more)) return closeDropdown();
    openDropdown(more, overflowed.map((b) => ({ label: b.title, onClick: () => b.click() })));
  });
  left.append(more);
  const fit = () => {
    items.forEach((el) => el.classList.remove('hidden'));
    more.classList.add('hidden');
    overflowed = [];
    for (let i = items.length - 1; i >= 0 && bar.scrollWidth > bar.clientWidth; i--) {
      more.classList.remove('hidden');
      items[i].classList.add('hidden');
      if (items[i].tagName === 'BUTTON') overflowed.unshift(items[i]);
    }
  };
  new ResizeObserver(fit).observe(bar);

  const codeBtn = document.createElement('button');
  codeBtn.type = 'button';
  codeBtn.className = 'mode-btn';
  codeBtn.textContent = 'Code';
  const visualBtn = document.createElement('button');
  visualBtn.type = 'button';
  visualBtn.className = 'mode-btn';
  visualBtn.textContent = 'Visual';
  visualBtn.title = 'Formeln, Abbildungen und Formatierung gerendert anzeigen';
  const setMode = (visual) => {
    onSetVisual(visual);
    codeBtn.classList.toggle('is-active', !visual);
    visualBtn.classList.toggle('is-active', visual);
  };
  codeBtn.addEventListener('click', () => setMode(false));
  visualBtn.addEventListener('click', () => setMode(true));
  codeBtn.classList.toggle('is-active', !isVisual());
  visualBtn.classList.toggle('is-active', isVisual());
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
