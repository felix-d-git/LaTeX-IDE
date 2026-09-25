import { selectAll, indentMore, indentLess } from '@codemirror/commands';
import { yUndo as undo, yRedo as redo } from './collab.js';
import { startCompletion } from '@codemirror/autocomplete';
import { openDropdown, closeDropdown, isDropdownOpenFor, anyDropdownOpen } from './dropdown.js';
import { insertAtCursor, wrapSelection, insertAtLineStart, SNIPPETS } from './editorCommands.js';

const SYMBOLS = ['α', 'β', 'π', '×', '±', '≈', '°', '§', '∞', '√'];

function alertStub(feature) {
  alert(`"${feature}" ist noch nicht umgesetzt (Backlog, siehe STATUS.md).`);
}

// R2: eine Toolbar-Zeile — Home-Button (32x32, rund) plus sechs Menü-Toggles
// mit 12px Abstand. Menüs sind 240px breit, Zeilen 36px hoch (dropdown.js).
export function setupMenuBar(ctx) {
  const bar = document.getElementById('menubar');
  bar.innerHTML = '';

  const home = document.createElement('button');
  home.id = 'btn-home';
  home.type = 'button';
  home.setAttribute('aria-label', 'Alle Projekte');
  home.title = 'Alle Projekte';
  home.innerHTML =
    '<img class="home-logo" src="/logo.png" alt="" width="32" height="32">' +
    '<span class="home-icon"><svg class="ol-icon"><use href="#i-home"></use></svg></span>';
  home.addEventListener('click', () => ctx.onHome && ctx.onHome());
  bar.appendChild(home);

  const menusWrap = document.createElement('div');
  menusWrap.id = 'menubar-menus';
  bar.appendChild(menusWrap);

  const view = () => ctx.getView && ctx.getView();
  const withView = (fn) => () => {
    const v = view();
    if (v) fn(v);
  };

  const MENUS = [
    {
      label: 'File',
      items: () => [
        { label: 'New file…', icon: 'note-add', onClick: () => ctx.onNewFile && ctx.onNewFile() },
        { label: 'New folder…', icon: 'folder-add', onClick: () => ctx.onNewFolder && ctx.onNewFolder() },
        { label: 'Upload file…', icon: 'upload', onClick: () => ctx.onUploadFile && ctx.onUploadFile() },
        { label: 'Make a copy', onClick: () => ctx.onMakeCopy && ctx.onMakeCopy() },
        { type: 'divider' },
        { label: 'Show version history', icon: 'history', onClick: () => ctx.onShowHistory() },
        { label: 'Word count', onClick: () => ctx.onWordCount && ctx.onWordCount() },
        { type: 'divider' },
        {
          label: 'Download',
          icon: 'download',
          submenu: [
            { label: 'Download as source (.zip)', onClick: () => window.location.assign('/api/download/zip') },
            { label: 'Download as PDF', onClick: () => downloadPdf(ctx) },
            { label: 'Export as Word (.docx)', onClick: () => alertStub('Export als Word (.docx)') },
            { label: 'Export as Markdown (.md)', onClick: () => alertStub('Export als Markdown (.md)') },
            { label: 'Export as HTML (.html)', onClick: () => alertStub('Export als HTML (.html)') },
          ],
        },
        { type: 'divider' },
        { label: 'Settings', icon: 'settings', onClick: () => ctx.onShowSettings() },
      ],
    },
    {
      label: 'Edit',
      items: () => [
        { label: 'Undo', icon: 'undo', shortcut: 'Ctrl Z', onClick: withView(undo) },
        { label: 'Redo', icon: 'redo', shortcut: 'Ctrl Y', onClick: withView(redo) },
        { type: 'divider' },
        { label: 'Find / Replace', icon: 'search', shortcut: 'Ctrl F', onClick: () => ctx.onFind() },
        {
          label: 'Im Projekt suchen',
          shortcut: 'Ctrl ⇧ F',
          onClick: () => ctx.onFindInProject && ctx.onFindInProject(),
        },
        { label: 'Select all', shortcut: 'Ctrl A', onClick: withView(selectAll) },
      ],
    },
    {
      label: 'Insert',
      items: () => [
        { label: 'Math', icon: 'math', onClick: withView((v) => insertAtCursor(v, '$$\n\n$$', { selectInner: 3 })) },
        {
          label: 'Symbol',
          submenu: SYMBOLS.map((s) => ({ label: s, onClick: withView((v) => insertAtCursor(v, s)) })),
        },
        { label: 'Figure', icon: 'image', onClick: withView((v) => insertAtCursor(v, SNIPPETS.figure)) },
        { label: 'Table', icon: 'table', onClick: withView((v) => insertAtCursor(v, SNIPPETS.table)) },
        // Befehl einfügen und direkt die Key-Vorschläge (Labels/Bib-Keys) öffnen.
        { label: 'Citation', onClick: withView((v) => { insertAtCursor(v, '\\cite{}', { selectInner: 6 }); startCompletion(v); }) },
        { label: 'Link', icon: 'link', onClick: () => insertLink(view()) },
        { label: 'Cross reference', onClick: withView((v) => { insertAtCursor(v, '\\ref{}', { selectInner: 5 }); startCompletion(v); }) },
        { label: 'Comment', icon: 'comment', onClick: () => ctx.onAddComment() },
        { type: 'divider' },
        { label: 'Abstract', onClick: withView((v) => insertAtCursor(v, SNIPPETS.abstract)) },
        { label: 'Keywords', onClick: withView((v) => insertAtCursor(v, '\\keywords{}')) },
        { label: 'Title', onClick: withView((v) => insertAtCursor(v, '\\title{}')) },
      ],
    },
    {
      label: 'View',
      items: () => [
        { type: 'header', label: 'Layout options' },
        ...layoutItems(ctx),
        { type: 'divider' },
        { type: 'header', label: 'Editor settings' },
        {
          label: 'Show file outline',
          checked: ctx.getOutlineVisible ? ctx.getOutlineVisible() : true,
          onClick: () => ctx.onToggleOutline && ctx.onToggleOutline(),
        },
        {
          label: 'Show editor toolbar',
          checked: ctx.getToolbarVisible ? ctx.getToolbarVisible() : true,
          onClick: () => ctx.onToggleToolbar && ctx.onToggleToolbar(),
        },
        { type: 'divider' },
        { type: 'header', label: 'PDF preview' },
        {
          label: 'PDF zoom',
          submenu: [
            { label: 'Zoom in', icon: 'zoom-in', onClick: () => ctx.onZoom(0.2) },
            { label: 'Zoom out', icon: 'zoom-out', onClick: () => ctx.onZoom(-0.2) },
          ],
        },
      ],
    },
    {
      label: 'Format',
      items: () => [
        { label: 'Bold', icon: 'bold', onClick: withView((v) => wrapSelection(v, '\\textbf{', '}')) },
        { label: 'Italics', icon: 'italic', onClick: withView((v) => wrapSelection(v, '\\textit{', '}')) },
        { type: 'divider' },
        { label: 'Bullet list', icon: 'list-bullet', onClick: withView((v) => insertAtCursor(v, SNIPPETS.itemize)) },
        { label: 'Numbered list', icon: 'list-number', onClick: withView((v) => insertAtCursor(v, SNIPPETS.enumerate)) },
        { type: 'divider' },
        { label: 'Increase indentation', onClick: withView(indentMore) },
        { label: 'Decrease indentation', onClick: withView(indentLess) },
        { type: 'divider' },
        { type: 'header', label: 'Paragraph styles' },
        { label: 'Section', icon: 'heading', onClick: withView((v) => insertAtLineStart(v, '\\section{}')) },
        { label: 'Subsection', onClick: withView((v) => insertAtLineStart(v, '\\subsection{}')) },
        { label: 'Subsubsection', onClick: withView((v) => insertAtLineStart(v, '\\subsubsection{}')) },
        { label: 'Paragraph', onClick: withView((v) => insertAtLineStart(v, '\\paragraph{}')) },
      ],
    },
    {
      label: 'Help',
      items: () => [
        { label: 'Keyboard shortcuts', onClick: () => ctx.onShowShortcuts() },
        { label: 'Customize shortcuts', onClick: () => ctx.onShowHotkeys() },
        { type: 'divider' },
        // Neutrale LaTeX-Doku (kein Bezug auf fremde Marken im veröffentlichten Tool).
        { label: 'Documentation', onClick: () => window.open('https://en.wikibooks.org/wiki/LaTeX', '_blank', 'noopener') },
      ],
    },
  ];

  for (const menu of MENUS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-btn';
    btn.id = `menu-${menu.label.toLowerCase()}`;
    btn.textContent = menu.label;
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isDropdownOpenFor(btn)) closeDropdown();
      else openDropdown(btn, menu.items());
    });
    // Klassisches Menubar-Verhalten: ist ein Menü offen, genügt Hover über
    // einen Nachbarn zum Umschalten (R2, Block 3).
    btn.addEventListener('mouseenter', () => {
      if (anyDropdownOpen() && !isDropdownOpenFor(btn)) openDropdown(btn, menu.items());
    });
    menusWrap.appendChild(btn);
  }

  return { closeAll: closeDropdown };
}

function downloadPdf(ctx) {
  const p = ctx.getPdfPath && ctx.getPdfPath();
  if (!p) return alert('Noch kein PDF vorhanden - zuerst kompilieren.');
  window.location.assign(`/api/pdf?path=${encodeURIComponent(p)}`);
}

function insertLink(view) {
  if (!view) return;
  const url = prompt('URL:', 'https://');
  if (!url) return;
  const label = prompt('Anzeigetext:', url) || url;
  insertAtCursor(view, `\\href{${url}}{${label}}`);
}

function layoutItems(ctx) {
  const mode = ctx.getLayout ? ctx.getLayout() : 'split';
  const item = (label, value, shortcut) => ({
    label,
    shortcut,
    checked: mode === value,
    onClick: () => ctx.onLayout(value),
  });
  return [
    item('Split view', 'split'),
    item('Editor only', 'editor-only'),
    item('PDF only', 'pdf-only'),
    item('Focus mode', 'focus', 'Ctrl Shift M'),
  ];
}

// R3: rechtsbündiges Layout-Dropdown am Kachel-Icon der Toolbar.
export function setupLayoutMenu(ctx) {
  const btn = document.getElementById('btn-layout');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isDropdownOpenFor(btn)) return closeDropdown();
    openDropdown(btn, [{ type: 'header', label: 'Layout options' }, ...layoutItems(ctx)], { align: 'right' });
  });
}

// R3: rechtsbündiges Projekt-Dropdown am Projekttitel; dupliziert bewusst
// Teile des File-Menüs, genau wie im Original.
export function setupProjectMenu(ctx) {
  const btn = document.getElementById('active-project-label');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isDropdownOpenFor(btn)) return closeDropdown();
    const items = [
      { label: 'Download as PDF', icon: 'download', onClick: () => downloadPdf(ctx) },
      { label: 'Download as source (.zip)', onClick: () => window.location.assign('/api/download/zip') },
      { type: 'divider' },
      { label: 'Make a copy', onClick: () => ctx.onMakeCopy && ctx.onMakeCopy() },
      { label: 'Word count', onClick: () => ctx.onWordCount && ctx.onWordCount() },
      { type: 'divider' },
      { label: 'Alle Projekte', icon: 'folder', onClick: () => ctx.onHome && ctx.onHome() },
    ];
    if (ctx.canOpenFolder && ctx.canOpenFolder()) {
      items.push({ label: 'Ordner öffnen…', onClick: () => ctx.onOpenFolder && ctx.onOpenFolder() });
    }
    openDropdown(btn, items, { align: 'right' });
  });
}
