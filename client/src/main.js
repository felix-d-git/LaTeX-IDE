import { api, authApi } from './api.js';
import { setupAuthView } from './authView.js';
import { connectWs } from './wsClient.js';
import { renderTree } from './fileTree.js';
import { createEditorManager } from './editor.js';
import {
  configureCollab, setCollabUser, setCollabProject, openSession, closeAllSessions, openTexts, listConflicts,
} from './collab.js';
import { createPdfViewer } from './pdfViewer.js';
import { setupSearchPanel } from './searchPanel.js';
import { setupProjectDialog } from './projectDialog.js';
import { setupProjectsView } from './projectsView.js';
import { createCommentsManager } from './comments.js';
import { setupCommentsPanel } from './commentsPanel.js';
import { createPreviewManager, fileKind } from './previewManager.js';
import { setupSyncTex } from './syncTex.js';
import { setupErrorPanel } from './errorPanel.js';
import { setupHotkeySettings, setupShortcutsReference } from './hotkeySettings.js';
import { setupShareDialog } from './shareDialog.js';
import { setupHistoryView } from './historyView.js';
import { setupMenuBar, setupLayoutMenu, setupProjectMenu } from './menuBar.js';
import { setupSettingsDialog } from './settingsDialog.js';
import { setupNewFileDialog, setupNewFolderDialog } from './newFileDialog.js';
import { setupWordCountDialog } from './wordCountDialog.js';
import { setupReviewPanel } from './reviewPanel.js';
import { setReviewingMode } from './trackChanges.js';
import { registerAction, initGlobalHotkeys } from './keybindings.js';
import { setupRail } from './rail.js';
import { setupResizers } from './resizers.js';
import { setupOutline } from './outline.js';
import { setupEditorToolbar } from './editorToolbar.js';
import { openDropdown, openDropdownAt, closeDropdown, isDropdownOpenFor } from './dropdown.js';
import { setupModals } from './modals.js';

const els = {
  activeProjectLabel: document.querySelector('#active-project-label .project-name'),
  projectButton: document.getElementById('active-project-label'),
  fileTree: document.getElementById('file-tree'),
  tabbar: document.getElementById('tabbar'),
  editorContainer: document.getElementById('editor-container'),
  previewContainer: document.getElementById('preview-container'),
  compileBtn: document.getElementById('btn-compile'),
  compileOptionsBtn: document.getElementById('btn-compile-options'),
  pdfContainer: document.getElementById('pdf-container'),
  pdfLogView: document.getElementById('pdf-log-view'),
  downloadPdfBtn: document.getElementById('btn-download-pdf'),
};

const authView = setupAuthView({ onAuthenticated: () => location.reload() });

// Everything the app does lives inside startApp(), only entered once
// /api/auth/me confirms a live session - showing the login/register screen
// otherwise instead of letting the rest of this file run against a
// logged-out session (every API call would just 401).
(async function boot() {
  let currentUser;
  try {
    currentUser = (await authApi.me()).user;
  } catch (e) {
    // Desktop app without a (valid) token: log in via the server's web UI.
    if (e.data && e.data.desktopLogin) return location.replace('/desktop/login');
    authView.show();
    return;
  }
  if (authView.showDesktopConnect(currentUser)) return;
  authView.hide();
  await startApp(currentUser);
})();

async function startApp(currentUser) {

let currentTree = null;
let mainFile = null;
let activeProjectRoot = '';
let commentsPanel = null; // set once setupCommentsPanel runs (needs editorMgr first)
let reviewPanel = null; // set once setupReviewPanel runs (needs editorMgr first)
let syncTex = null; // set once setupSyncTex runs (needs pdfViewer first)
let outline = null; // set once setupOutline runs (needs editorMgr first)
let openOrder = []; // ordered list of open tab paths, text and preview tabs interleaved
let activePaneKind = 'text'; // 'text' | 'preview' - which of the two panes is currently shown

const commentsManager = createCommentsManager();

const editorMgr = createEditorManager(els.editorContainer, {
  getInitialComments: (path) => commentsManager.getForFile(path),
  onCommentClick: (id) => commentsPanel && commentsPanel.highlightComment(id),
  onTrackChangeClick: (id) => reviewPanel && reviewPanel.highlight(Number(id)),
  onDocChanged: () => {
    if (reviewPanel && reviewPanel.isOpen()) reviewPanel.render();
    scheduleOutlineRefresh();
  },
  onSelectionChanged: () => scheduleOutlineRefresh(),
  onDropImages: (files, pos) => insertDroppedImages(files, pos),
  resolveImage: (rawPath) => resolveImagePath(rawPath),
});

const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function treeFiles() {
  const out = new Set();
  const walk = (nodes) => {
    for (const n of nodes || []) n.type === 'dir' ? walk(n.children) : out.add(n.path);
  };
  walk(currentTree);
  return out;
}

// \includegraphics-Pfad → Projektdatei; LaTeX sucht relativ zur Hauptdatei,
// Endung darf fehlen. ponytail: kein \graphicspath.
function resolveImagePath(rawPath) {
  const files = treeFiles();
  const bases = [dirOf(mainFile), dirOf(editorMgr.getActivePath())];
  for (const base of bases) {
    const parts = [];
    for (const seg of `${base}/${rawPath}`.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const p = parts.join('/');
    for (const ext of ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps']) if (files.has(p + ext)) return p + ext;
  }
  return null;
}

function relativeTo(fromDir, target) {
  const a = fromDir ? fromDir.split('/') : [];
  const b = target.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

// Bild in den Editor gezogen: nach <Ordner der Datei>/Bilder hochladen und
// eine komplette figure-Umgebung an der Drop-Stelle einfügen.
async function insertDroppedImages(files, pos) {
  const path = editorMgr.getActivePath();
  if (!path) return;
  const dir = dirOf(path) ? `${dirOf(path)}/Bilder` : 'Bilder';
  const blocks = [];
  try {
    for (const file of files) {
      const name = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]/g, '-');
      const { path: saved } = await api.uploadFile(dir, name, await readFileAsBase64(file));
      const rel = relativeTo(dirOf(mainFile), saved.replace(/\\/g, '/'));
      const stem = rel.split('/').pop().replace(/\.[^.]+$/, '');
      blocks.push(
        `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{${rel}}\n  \\caption{}\n  \\label{fig:${stem}}\n\\end{figure}\n`
      );
    }
  } catch (e) {
    alert('Fehler beim Hochladen: ' + e.message);
  }
  await loadTree();
  if (!blocks.length || editorMgr.getActivePath() !== path) return;
  const view = editorMgr.view;
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const empty = !line.text.trim();
  const at = empty ? line.from : line.to;
  const insert = (empty ? '' : '\n') + blocks.join('\n');
  const caret = at + insert.indexOf('\\caption{') + '\\caption{'.length;
  view.dispatch({ changes: { from: at, to: empty ? line.to : at, insert }, selection: { anchor: caret }, scrollIntoView: true });
  view.focus();
}

const previewMgr = createPreviewManager(els.previewContainer);

const pdfViewer = createPdfViewer(
  els.pdfContainer,
  {
    zoomLabel: document.getElementById('pdf-zoom-level'),
    pageLabel: document.getElementById('pdf-page-label'),
    pageInput: document.getElementById('pdf-page-input'),
  },
  { onPdfDoubleClick: (page, x, y) => syncTex && syncTex.handlePdfDoubleClick(page, x, y) }
);

// --- PDF-Toolbar (R6) ---------------------------------------------------

document.getElementById('pdf-zoom-in').addEventListener('click', () => pdfViewer.zoom(0.2));
document.getElementById('pdf-zoom-out').addEventListener('click', () => pdfViewer.zoom(-0.2));
document.getElementById('pdf-prev').addEventListener('click', () => pdfViewer.goToPage(pdfViewer.getCurrentPage() - 1));
document.getElementById('pdf-next').addEventListener('click', () => pdfViewer.goToPage(pdfViewer.getCurrentPage() + 1));

const pageInput = document.getElementById('pdf-page-input');
pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(pageInput.value, 10);
  if (!Number.isNaN(n)) pdfViewer.goToPage(n);
  pageInput.blur();
});

const zoomBtn = document.getElementById('pdf-zoom-level');
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2];
zoomBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (isDropdownOpenFor(zoomBtn)) return closeDropdown();
  const mode = pdfViewer.getZoomMode();
  const items = [
    { label: 'An Breite anpassen', checked: mode === 'fit-width', onClick: () => pdfViewer.setZoom('fit-width') },
    { label: 'Ganze Seite', checked: mode === 'fit-page', onClick: () => pdfViewer.setZoom('fit-page') },
    { type: 'divider' },
    ...ZOOM_LEVELS.map((z) => ({
      label: `${Math.round(z * 100)}%`,
      checked: mode === z,
      onClick: () => pdfViewer.setZoom(z),
    })),
  ];
  openDropdown(zoomBtn, items, { align: 'right' });
});

// --- Layout -------------------------------------------------------------

const LAYOUT_STORAGE_KEY = 'latex-ide-layout-mode';
const appEl = document.getElementById('app');
let layoutMode = 'split';

function applyLayout(mode) {
  layoutMode = mode || 'split';
  appEl.classList.remove('layout-editor-only', 'layout-pdf-only', 'layout-focus');
  if (layoutMode !== 'split') appEl.classList.add('layout-' + layoutMode);
  localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
}

applyLayout(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'split');

const rail = setupRail();
setupResizers();

function showPane(kind) {
  activePaneKind = kind;
  els.editorContainer.classList.toggle('hidden', kind !== 'text');
  els.previewContainer.classList.toggle('hidden', kind !== 'preview');
}

function getActiveOpenPath() {
  return activePaneKind === 'text' ? editorMgr.getActivePath() : previewMgr.getActivePath();
}

// --- Datei-Tabs (R5) ----------------------------------------------------

function tabIconFor(path) {
  return /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(path) ? 'image' : 'file';
}

function renderTabbar() {
  els.tabbar.innerHTML = '';
  for (const path of openOrder) {
    const kind = fileKind(path);
    const paneKind = kind === 'text' ? 'text' : 'preview';
    const activePathForKind = paneKind === 'text' ? editorMgr.getActivePath() : previewMgr.getActivePath();
    const isActive = activePaneKind === paneKind && activePathForKind === path;

    const tab = document.createElement('div');
    tab.className = 'tab' + (isActive ? ' active' : '');

    const content = document.createElement('div');
    content.className = 'tab-content';

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.innerHTML = `<svg class="ol-icon"><use href="#i-${tabIconFor(path)}"></use></svg>`;
    content.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tab-label';
    const dirty = paneKind === 'text' && editorMgr.isDirty(path);
    label.textContent = path.split('/').pop() + (dirty ? ' •' : '');
    content.appendChild(label);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = 'Tab schließen';
    close.innerHTML = '<svg class="ol-icon"><use href="#i-close"></use></svg>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (paneKind === 'text') editorMgr.closeTab(path);
      else previewMgr.closeTab(path);
      openOrder = openOrder.filter((p) => p !== path);
      renderTabbar();
    });
    content.appendChild(close);

    tab.appendChild(content);
    tab.addEventListener('click', () => openFile(path));
    els.tabbar.appendChild(tab);
  }
}

function closeActiveTab() {
  const path = getActiveOpenPath();
  if (!path) return;
  const paneKind = fileKind(path) === 'text' ? 'text' : 'preview';
  if (paneKind === 'text') editorMgr.closeTab(path);
  else previewMgr.closeTab(path);
  openOrder = openOrder.filter((p) => p !== path);
  renderTabbar();
}

function cycleTab(delta) {
  if (openOrder.length === 0) return;
  const current = getActiveOpenPath();
  const idx = current ? openOrder.indexOf(current) : -1;
  const nextIdx = ((idx === -1 ? 0 : idx) + delta + openOrder.length) % openOrder.length;
  openFile(openOrder[nextIdx]);
}

let outlineTimer = null;
function scheduleOutlineRefresh() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => outline && outline.render(), 400);
}

async function openFile(path, line) {
  const kind = fileKind(path);
  if (!openOrder.includes(path)) openOrder.push(path);

  if (kind === 'text') {
    try {
      await openSession(path);
    } catch (e) {
      alert(`Datei kann nicht geöffnet werden: ${path}\n${e.message}`);
      openOrder = openOrder.filter((p) => p !== path);
      renderTabbar();
      return;
    }
    editorMgr.openFile(path);
    showPane('text');
  } else {
    previewMgr.openFile(path, kind);
    showPane('preview');
  }

  renderTabbar();
  refreshTreeHighlight();
  if (outline) outline.render();
  if (commentsPanel && commentsPanel.isOpen()) commentsPanel.renderList();
  if (line && kind === 'text') {
    const doc = editorMgr.view.state.doc;
    const ln = Math.min(line, doc.lines);
    const pos = doc.line(ln).from;
    editorMgr.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    editorMgr.view.focus();
    if (outline) outline.render();
  }
}

function closeTabsUnder(relPath) {
  const affected = openOrder.filter((p) => p === relPath || p.startsWith(relPath + '/'));
  for (const p of affected) {
    if (fileKind(p) === 'text') editorMgr.closeTab(p);
    else previewMgr.closeTab(p);
  }
  openOrder = openOrder.filter((p) => !affected.includes(p));
  renderTabbar();
}

function createTreeFolder(parentPath) {
  newFolderDialog.show(parentPath);
}

function createTreeFile(parentPath) {
  newFileDialog.show(parentPath);
}

async function renameTreeNode(relPath, isDir, currentName) {
  const newName = prompt('Neuer Name:', currentName);
  if (!newName || newName === currentName) return;
  try {
    await api.renamePath(relPath, newName);
    closeTabsUnder(relPath); // renamed path's tabs would otherwise point at a now-nonexistent file
    await loadTree();
  } catch (e) {
    alert('Fehler beim Umbenennen: ' + e.message);
  }
}

async function deleteTreeNode(relPath, isDir) {
  const label = isDir ? 'den Ordner (inkl. Inhalt)' : 'die Datei';
  if (!confirm(`${label.charAt(0).toUpperCase() + label.slice(1)} "${relPath}" wirklich löschen?`)) return;
  try {
    await api.deletePath(relPath);
    closeTabsUnder(relPath);
    await loadTree();
  } catch (e) {
    alert('Fehler beim Löschen: ' + e.message);
  }
}

async function moveTreeNode(sourcePath, targetDir) {
  try {
    let result = await api.movePath(sourcePath, targetDir, false);
    if (result.conflict) {
      const name = sourcePath.split('/').pop();
      if (!confirm(`"${name}" existiert bereits im Zielordner. Überschreiben?`)) return;
      result = await api.movePath(sourcePath, targetDir, true);
    }
    closeTabsUnder(sourcePath); // moved path's tabs would otherwise point at a now-nonexistent location
    await loadTree();
  } catch (e) {
    alert('Fehler beim Verschieben: ' + e.message);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadDroppedFiles(targetDir, entries) {
  try {
    for (const { relPath, file } of entries) {
      const content = await readFileAsBase64(file);
      const slash = relPath.lastIndexOf('/');
      const subDir = slash === -1 ? '' : relPath.slice(0, slash);
      const name = slash === -1 ? relPath : relPath.slice(slash + 1);
      const dir = targetDir && subDir ? `${targetDir}/${subDir}` : targetDir || subDir;
      await api.uploadFile(dir, name, content);
    }
    await loadTree();
  } catch (e) {
    alert('Fehler beim Hochladen: ' + e.message);
  }
}

function refreshTreeHighlight() {
  if (!currentTree) return;
  renderTree(els.fileTree, currentTree, {
    activePath: getActiveOpenPath(),
    mainFile,
    onOpen: openFile,
    onSetMain: setMainFile,
    onCreateFolder: createTreeFolder,
    onCreateFile: createTreeFile,
    onRename: renameTreeNode,
    onDelete: deleteTreeNode,
    onMove: moveTreeNode,
    onUploadFiles: uploadDroppedFiles,
    onUploadHere: (dir) => newFileDialog.show(dir, 'upload'),
  });
}

async function setMainFile(path) {
  await api.setMainFile(path);
  mainFile = path;
  refreshTreeHighlight();
}

let currentProjectId = null;
async function loadTree() {
  const { tree, mainFile: mf, projectId } = await api.getTree();
  if (projectId !== currentProjectId) {
    // Other project: tabs of the previous one point at files that don't exist here.
    for (const p of [...openOrder]) {
      if (fileKind(p) === 'text') editorMgr.closeTab(p);
      else previewMgr.closeTab(p);
    }
    openOrder = [];
    closeAllSessions();
    setCollabProject(projectId);
    currentProjectId = projectId;
    renderTabbar();
  }
  currentTree = tree;
  mainFile = mf;
  refreshTreeHighlight();
}

async function loadProject(root) {
  activeProjectRoot = root;
  const name = root.split(/[\\/]/).pop() || root;
  els.activeProjectLabel.textContent = name;
  els.projectButton.title = root;
  await Promise.all([loadTree(), commentsManager.loadAll()]);
}

async function openProjectByRoot(root) {
  try {
    const result = await api.openProject(root);
    mainFile = result.mainFile;
    await loadProject(result.activeRoot);
  } catch (e) {
    alert('Fehler beim Öffnen: ' + e.message);
  }
}

// --- Kompilieren (R6: Zustand steckt im Button und im Badge, keine
//     eigene Statuszeile - die gibt es im Original nicht) ----------------

let autoCompile = localStorage.getItem('latex-ide-autocompile') === '1';

els.compileOptionsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (isDropdownOpenFor(els.compileOptionsBtn)) return closeDropdown();
  openDropdown(
    els.compileOptionsBtn,
    [
      { label: 'Jetzt kompilieren', icon: 'play', onClick: () => els.compileBtn.click() },
      { type: 'divider' },
      {
        label: 'Automatisch kompilieren (beim Speichern)',
        checked: autoCompile,
        onClick: () => {
          autoCompile = !autoCompile;
          localStorage.setItem('latex-ide-autocompile', autoCompile ? '1' : '0');
        },
      },
      { label: 'Logs anzeigen', icon: 'bug', onClick: () => errorPanel.show() },
    ],
    { align: 'left' }
  );
});

els.downloadPdfBtn.addEventListener('click', async () => {
  const p = pdfViewer.getCurrentPath();
  if (!p) return alert('Noch kein PDF vorhanden - zuerst kompilieren.');
  const projectName = activeProjectRoot.split(/[\\/]/).pop() || 'dokument';
  const res = await fetch(`/api/pdf?path=${encodeURIComponent(p)}`);
  if (!res.ok) return alert('PDF konnte nicht heruntergeladen werden.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName}.pdf`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

els.compileBtn.addEventListener('click', async () => {
  els.compileBtn.disabled = true;
  els.compileBtn.textContent = 'Kompiliere…';
  try {
    // Desktop app compiles locally and may be offline: hand it the live texts.
    const result = await api.compile(isDesktop ? openTexts() : undefined);
    els.pdfLogView.textContent = result.log;
    errorPanel.setLog(result);
    if (result.success) {
      errorPanel.hide();
    } else if (!result.pdfPath) {
      // Ohne PDF ist die Log-Ansicht das einzig Sinnvolle in der Spalte
      errorPanel.show();
    }
    if (result.pdfPath) pdfViewer.load(result.pdfPath);
  } catch (e) {
    els.pdfLogView.textContent = String(e.message || e);
    errorPanel.setLog({ errors: [{ file: '', line: null, message: e.message }] });
    errorPanel.show();
  } finally {
    els.compileBtn.disabled = false;
    els.compileBtn.textContent = 'Kompilieren';
  }
});

const searchPanelApi = setupSearchPanel({
  onOpenResult: (file, line) => openFile(file, line),
});

setupProjectDialog({
  onOpened: ({ activeRoot, mainFile: mf }) => {
    mainFile = mf;
    loadProject(activeRoot);
  },
});

const projectsView = setupProjectsView({
  onOpenProject: openProjectByRoot,
  currentUser,
});

commentsPanel = setupCommentsPanel({
  commentsManager,
  editorMgr,
  getActivePath: () => editorMgr.getActivePath(),
});

reviewPanel = setupReviewPanel({
  editorMgr,
  getActivePath: () => editorMgr.getActivePath(),
});

document.getElementById('review-mode-select').addEventListener('change', (e) => {
  setReviewingMode(e.target.value === 'reviewing');
});

const newFileDialog = setupNewFileDialog({
  onCreated: async (newPath) => {
    await loadTree();
    if (fileKind(newPath) === 'text') openFile(newPath);
  },
  onUpload: uploadDroppedFiles,
});

const newFolderDialog = setupNewFolderDialog({ onCreated: () => loadTree() });

const wordCountDialog = setupWordCountDialog();

syncTex = setupSyncTex({
  editorMgr,
  pdfViewer,
  getActivePath: () => editorMgr.getActivePath(),
  onJumpToCode: (file, line) => openFile(file, line),
});

const errorPanel = setupErrorPanel({
  onJumpTo: (file, line) => openFile(file, line),
});

const hotkeySettings = setupHotkeySettings();
const shortcutsReference = setupShortcutsReference();
const shareDialog = setupShareDialog({ currentUser, onLeft: () => projectsView.show() });
const historyView = setupHistoryView();
const settingsDialog = setupSettingsDialog({
  editorMgr,
  onShowHotkeys: () => hotkeySettings.show(),
  currentUser,
  onLogout: async () => {
    await authApi.logout();
    location.reload();
  },
});

outline = setupOutline({
  editorMgr,
  getActivePath: () => editorMgr.getActivePath(),
});
outline.render();

const editorToolbar = setupEditorToolbar({
  getView: () => editorMgr.view,
  onFind: () => editorMgr.openSearch(),
  onFindInProject: () => searchPanelApi.toggle(),
  onAddComment: () => commentsPanel.triggerAddComment(),
  onSetVisual: (on) => editorMgr.setVisual(on),
  isVisual: () => editorMgr.isVisual(),
});

const menuCtx = {
  getView: () => editorMgr.view,
  onFind: () => editorMgr.openSearch(),
  onFindInProject: () => searchPanelApi.toggle(),
  onShowHistory: () => historyView.show(),
  onShowHotkeys: () => hotkeySettings.show(),
  onShowShortcuts: () => shortcutsReference.show(),
  onShowSettings: () => settingsDialog.show(),
  onAddComment: () => commentsPanel.triggerAddComment(),
  getPdfPath: () => pdfViewer.getCurrentPath(),
  onZoom: (delta) => pdfViewer.zoom(delta),
  onLayout: (mode) => applyLayout(mode),
  getLayout: () => layoutMode,
  onTreeChanged: () => loadTree(),
  onNewFile: () => newFileDialog.show(''),
  onNewFolder: () => newFolderDialog.show(''),
  onUploadFile: () => newFileDialog.show('', 'upload'),
  onWordCount: () => wordCountDialog.show(),
  onHome: () => projectsView.show(),
  onOpenFolder: () => document.getElementById('btn-open-project').click(),
  canOpenFolder: () => !!currentUser.isAdmin,
  getOutlineVisible: () => !document.getElementById('pane-files').classList.contains('outline-collapsed'),
  onToggleOutline: () => document.querySelector('.outline-toggle').click(),
  getToolbarVisible: () => editorToolbar.isVisible(),
  onToggleToolbar: () => editorToolbar.setVisible(!editorToolbar.isVisible()),
  onMakeCopy: () => {
    const name = activeProjectRoot.split(/[\\/]/).pop();
    if (name) projectsView.showCopyDialogFor(name);
  },
};

setupMenuBar(menuCtx);

// Overleaf-Kontextmenü im Editor statt des Browser-Standardmenüs.
editorMgr.view.dom.addEventListener('contextmenu', (e) => {
  if (!editorMgr.getActivePath()) return;
  e.preventDefault();
  const v = editorMgr.view;
  const { from, to, text } = editorMgr.getSelection();
  const replaceSel = (insert) => v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  openDropdownAt(e.clientX, e.clientY, [
    { label: 'Cut', shortcut: 'Ctrl X', disabled: !text, onClick: async () => { await navigator.clipboard.writeText(text); replaceSel(''); v.focus(); } },
    { label: 'Copy', shortcut: 'Ctrl C', disabled: !text, onClick: () => navigator.clipboard.writeText(text) },
    { label: 'Paste', shortcut: 'Ctrl V', onClick: async () => { replaceSel(await navigator.clipboard.readText()); v.focus(); } },
    { type: 'divider' },
    { label: 'Add comment', icon: 'comment', disabled: !text, onClick: () => commentsPanel.triggerAddComment() },
    { label: 'Jump to location in PDF', onClick: () => syncTex.syncToPdf() },
  ], { className: 'context-menu' });
});
setupModals();
setupLayoutMenu(menuCtx);
setupProjectMenu(menuCtx);

// Arbitrary local-folder access only makes sense for the admin (who runs the
// server and owns the pre-existing outside-of-projects/ Bachelorarbeit
// folder) - non-admin accounts are restricted server-side to their own
// isolated projects/users/<id>/ folder anyway, so the dialog would just
// produce confusing 403s for them.
if (!currentUser.isAdmin) document.getElementById('btn-open-project').classList.add('hidden');

// Die Suche hatte bisher keinen eigenen Button (nur Strg+F) - im Redesign
// ist sie ein Rail-Tab und braucht deshalb eine Verdrahtung.
document.getElementById('btn-search').addEventListener('click', () => searchPanelApi.toggle());
document.getElementById('btn-settings').addEventListener('click', () => settingsDialog.show());
document.getElementById('btn-tree-new-folder').addEventListener('click', () => createTreeFolder(''));
document.getElementById('btn-tree-new-file').addEventListener('click', () => createTreeFile(''));
document.getElementById('btn-tree-upload').addEventListener('click', () => newFileDialog.show('', 'upload'));
document.getElementById('btn-cancel-comment-2').addEventListener('click', () =>
  document.getElementById('btn-cancel-comment').click()
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  hotkeySettings.hide();
  shareDialog.hide();
  settingsDialog.hide();
  if (appEl.classList.contains('layout-focus')) applyLayout('split');
});

registerAction('compile', () => els.compileBtn.click());
registerAction('toggleAllProjects', () => projectsView.toggle());
registerAction('toggleComments', () => commentsPanel.toggle());
registerAction('toggleErrors', () => errorPanel.toggle());
registerAction('toggleSearch', () => searchPanelApi.toggle());
// Strg+F: Suchen/Ersetzen-Leiste unten im Editor, in beiden Scopes registriert
// (greift also auch, wenn der Fokus gerade außerhalb des Editors liegt).
registerAction('searchInFile', () => editorMgr.openSearch());
registerAction('searchInFileEditor', () => editorMgr.openSearch());
registerAction('toggleHistory', () => historyView.toggle());
registerAction('closeTab', () => closeActiveTab());
registerAction('nextTab', () => cycleTab(1));
registerAction('prevTab', () => cycleTab(-1));
registerAction('addComment', () => commentsPanel.triggerAddComment());
registerAction('syncToPdf', () => syncTex.syncToPdf());
initGlobalHotkeys();

// --- Live collaboration status + conflicts ---
const collabBadge = document.createElement('span');
collabBadge.className = 'collab-offline-badge hidden';
collabBadge.textContent = 'Offline – Änderungen werden lokal gespeichert';
els.compileBtn.parentElement.insertBefore(collabBadge, els.compileBtn);
setCollabUser(currentUser);
configureCollab({
  onStatus: (online) => collabBadge.classList.toggle('hidden', online),
  onConflicts: (path) => {
    editorMgr.refreshConflicts(path);
    if (path === editorMgr.getActivePath() && listConflicts(path).length) reviewPanel.show();
    else if (reviewPanel.isOpen()) reviewPanel.render();
  },
  // Server re-created the doc or the file vanished: reopen / drop the tab.
  onReset: (path) => {
    editorMgr.closeTab(path);
    if (openOrder.includes(path)) openFile(path);
  },
  onGone: (path) => {
    editorMgr.closeTab(path);
    openOrder = openOrder.filter((p) => p !== path);
    renderTabbar();
    loadTree();
  },
});
let isDesktop = false;
fetch('/api/desktop/info')
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => (isDesktop = !!d.desktop))
  .catch(() => {});

connectWs({
  fileChanged: (msg) => {
    editorMgr.applyExternalChange(msg.path, msg.content, msg.changedRanges);
    renderTabbar();
    scheduleOutlineRefresh();
  },
  fileDeleted: (msg) => {
    closeTabsUnder(msg.path);
    loadTree();
  },
  treeChanged: () => loadTree(),
  pdfChanged: (msg) => pdfViewer.reload(),
  compileStatus: (msg) => {
    if (msg.status === 'running') els.compileBtn.textContent = 'Kompiliere…';
  },
  commentsChanged: async (msg) => {
    await commentsManager.loadAll();
    editorMgr.refreshCommentsForPath(msg.path, commentsManager.getForFile(msg.path));
    if (commentsPanel.isOpen() && editorMgr.getActivePath() === msg.path) commentsPanel.renderList();
  },
});

(async function init() {
  const { activeRoot } = await api.listProjects();
  if (activeRoot) {
    await loadProject(activeRoot);
  } else {
    projectsView.show();
  }
})();

}
