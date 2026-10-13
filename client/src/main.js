import { api, authApi, adminApi, shareApi, setProjectId, withPid } from './api.js';
import { setupAuthView } from './authView.js';
import { connectWs, wsSubscribe } from './wsClient.js';
import { renderTree, resetTreeSelection } from './fileTree.js';
import { createEditorManager } from './editor.js';
import {
  configureCollab, setCollabUser, setCollabProject, openSession, closeAllSessions, openTexts, listConflicts, prewarm,
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
import { setupAdminDialog, setupProfileDialog } from './profileDialog.js';
import { setupHelpDialog } from './helpDialog.js';
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
import { offlineBanner } from './offlineBanner.js';

let isDesktop = false; // set once /api/desktop/info answers

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
// Share link (?join=<token>) must survive login/registration.
const joinToken = new URLSearchParams(location.search).get('join');
if (joinToken) {
  try {
    sessionStorage.setItem('latex-ide-join', joinToken);
  } catch {}
  history.replaceState({}, '', location.pathname);
}

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
  onTrackChangeClick: (id) => reviewPanel && reviewPanel.highlight(id),
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
    const paneKind = editorMgr.isOpen(path) ? 'text' : 'preview';
    const isActive = getActiveOpenPath() === path;

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
      closeAnyTab(path);
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
  closeAnyTab(path);
  openOrder = openOrder.filter((p) => p !== path);
  renderTabbar();
}

// Text files that are not UTF-8 sit in the preview pane, so close in both.
function closeAnyTab(path) {
  editorMgr.closeTab(path);
  previewMgr.closeTab(path);
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
      if (e.status === 415) return openLegacyFile(path, e.data && e.data.error);
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

// Latin-1 etc.: read-only view; converting snapshots first (history) and then opens the editor.
async function openLegacyFile(path, message) {
  let file;
  try {
    file = await api.getFile(path);
  } catch (e) {
    alert(`Datei kann nicht geöffnet werden: ${path}\n${e.message}`);
    openOrder = openOrder.filter((p) => p !== path);
    renderTabbar();
    return;
  }
  editorMgr.closeTab(path);
  previewMgr.openFile(path, 'legacy', {
    message: message || 'Datei ist nicht UTF-8-kodiert.',
    content: file.content,
    onConvert: async () => {
      try {
        await api.convertUtf8(path);
      } catch (e) {
        alert(`Umwandeln fehlgeschlagen: ${e.message}`);
        return;
      }
      previewMgr.closeTab(path);
      openFile(path);
    },
  });
  showPane('preview');
  renderTabbar();
  refreshTreeHighlight();
}

function closeTabsUnder(relPath) {
  const affected = openOrder.filter((p) => p === relPath || p.startsWith(relPath + '/'));
  for (const p of affected) closeAnyTab(p);
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

async function deleteTreeNodes(paths) {
  if (!confirm(`${paths.length} Einträge (Ordner inkl. Inhalt) wirklich löschen?\n\n${paths.join('\n')}`)) return false;
  try {
    for (const p of paths) {
      await api.deletePath(p);
      closeTabsUnder(p);
    }
  } catch (e) {
    alert('Fehler beim Löschen: ' + e.message);
  }
  await loadTree();
  return true;
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

// Gleichnamige Datei schon da → Dialog „Überschreiben/Überspringen" (Escape = überspringen).
// Resolves to { overwrite, all }.
function askUploadConflict(name, more) {
  const box = document.getElementById('upload-conflict');
  const all = document.getElementById('upload-conflict-all');
  document.getElementById('upload-conflict-name').textContent = name;
  document.getElementById('upload-conflict-all-row').classList.toggle('hidden', !more);
  all.checked = false;
  box.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (overwrite) => {
      box.classList.add('hidden');
      for (const [id, fn] of handlers) document.getElementById(id).removeEventListener('click', fn);
      resolve({ overwrite, all: all.checked });
    };
    const handlers = [
      ['btn-upload-overwrite', () => done(true)],
      ['btn-upload-skip', () => done(false)],
      ['btn-upload-conflict-close', () => done(false)],
    ];
    for (const [id, fn] of handlers) document.getElementById(id).addEventListener('click', fn);
  });
}

async function uploadDroppedFiles(targetDir, entries) {
  const existing = treeFiles();
  let decideAll = null; // true/false, sobald „für alle" angehakt wurde
  try {
    for (let i = 0; i < entries.length; i++) {
      const { relPath, file } = entries[i];
      const slash = relPath.lastIndexOf('/');
      const subDir = slash === -1 ? '' : relPath.slice(0, slash);
      const name = slash === -1 ? relPath : relPath.slice(slash + 1);
      const dir = targetDir && subDir ? `${targetDir}/${subDir}` : targetDir || subDir;
      let overwrite = false;
      if (existing.has(dir ? `${dir}/${name}` : name)) {
        if (decideAll === null) {
          const ans = await askUploadConflict(name, i < entries.length - 1);
          overwrite = ans.overwrite;
          if (ans.all) decideAll = ans.overwrite;
        } else overwrite = decideAll;
        if (!overwrite) continue;
      }
      await api.uploadFile(dir, name, await readFileAsBase64(file), overwrite);
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
    onDeleteMany: deleteTreeNodes,
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
let treeSeq = 0;
async function loadTree() {
  const seq = ++treeSeq;
  const { tree, mainFile: mf, projectId } = await api.getTree();
  // A slower, older answer (e.g. old project, requested before an open) must not undo a newer one.
  if (seq !== treeSeq) return;
  if (projectId !== currentProjectId) {
    // Other project: tabs of the previous one point at files that don't exist here.
    for (const p of [...openOrder]) closeAnyTab(p);
    openOrder = [];
    closeAllSessions();
    setCollabProject(projectId);
    currentProjectId = projectId;
    renderTabbar();
  }
  currentTree = tree;
  mainFile = mf;
  refreshTreeHighlight();
  if (isDesktop && !offlineBanner.isOffline()) prewarm([...treeFiles()].filter((p) => fileKind(p) === 'text'));
}

async function loadProject(root, projectId) {
  document.getElementById('project-switched')?.remove();
  setProjectId(projectId);
  wsSubscribe(projectId);
  activeProjectRoot = root;
  resetTreeSelection();
  const name = root.split(/[\\/]/).pop() || root;
  els.activeProjectLabel.textContent = name;
  els.projectButton.title = root;
  await Promise.all([loadTree(), commentsManager.loadAll(), applyRole()]);
}

// Server says this window's project is gone (moved, archived, deleted, share revoked).
function showProjectGone() {
  if (document.getElementById('project-switched') || !activeProjectRoot) return;
  const bar = document.createElement('div');
  bar.id = 'project-switched';
  bar.setAttribute('role', 'alert');
  bar.appendChild(Object.assign(document.createElement('span'), { textContent: 'Dieses Projekt ist nicht mehr verfügbar (verschoben, archiviert, gelöscht oder Zugriff entzogen).' }));
  const home = Object.assign(document.createElement('button'), { textContent: 'Zur Übersicht' });
  home.addEventListener('click', () => {
    bar.remove();
    projectsView.show();
  });
  bar.append(home);
  document.body.appendChild(bar);
}
window.addEventListener('lide-project-gone', showProjectGone);

async function applyRole() {
  let role = 'owner';
  try {
    role = (await shareApi.get()).myRole;
  } catch {}
  const reviewer = role === 'reviewer';
  editorMgr.setReadOnly(reviewer);
  document.body.classList.toggle('role-reviewer', reviewer);
  els.activeProjectLabel.title = reviewer ? 'Nur kommentieren' : '';
}

async function openProjectByRoot(root) {
  try {
    const result = await api.openProject(root);
    mainFile = result.mainFile;
    await loadProject(result.activeRoot, result.projectId);
    if (result.startFile) await openFile(result.startFile);
  } catch (e) {
    alert('Fehler beim Öffnen: ' + e.message);
  }
}

// --- Kompilieren (R6: Zustand steckt im Button und im Badge, keine
//     eigene Statuszeile) ------------------------------------------------

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
  const res = await fetch(withPid(`/api/pdf?path=${encodeURIComponent(p)}`));
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
    editorMgr.setCompileDiagnostics(result);
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
  onOpened: async ({ activeRoot, mainFile: mf, startFile, projectId }) => {
    mainFile = mf;
    await loadProject(activeRoot, projectId);
    if (startFile) await openFile(startFile);
  },
});

const projectsView = setupProjectsView({
  onOpenProject: openProjectByRoot,
  currentUser,
});

commentsPanel = setupCommentsPanel({
  commentsManager,
  editorMgr,
  currentUser,
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
  onPdfViewer: (mode) => pdfViewer.setNative(mode === 'browser'),
  onBreadcrumbs: (on) => document.getElementById('editor-breadcrumbs').classList.toggle('hidden', !on),
  onShowAccount: () => profileDialog.show(),
});
const adminDialog = setupAdminDialog({ currentUser, onUpdateRequested: () => checkServerUpdate() });
const profileDialog = setupProfileDialog({
  currentUser,
  onShowAdmin: () => adminDialog.show(),
  onLogout: async () => {
    await authApi.logout();
    location.reload();
  },
});
const helpDialog = setupHelpDialog();

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
  onShowHelp: () => helpDialog.show(),
  onShowAbout: () => helpDialog.showAbout(),
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

// Eigenes Kontextmenü im Editor statt des Browser-Standardmenüs.
editorMgr.view.dom.addEventListener('contextmenu', (e) => {
  if (!editorMgr.getActivePath()) return;
  e.preventDefault();
  const v = editorMgr.view;
  const { from, to, text } = editorMgr.getSelection();
  const ro = v.state.readOnly;
  const replaceSel = (insert) => v.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
  openDropdownAt(e.clientX, e.clientY, [
    { label: 'Cut', shortcut: 'Ctrl X', disabled: !text || ro, onClick: async () => { await navigator.clipboard.writeText(text); replaceSel(''); v.focus(); } },
    { label: 'Copy', shortcut: 'Ctrl C', disabled: !text, onClick: () => navigator.clipboard.writeText(text) },
    { label: 'Paste', shortcut: 'Ctrl V', disabled: ro, onClick: async () => { replaceSel(await navigator.clipboard.readText()); v.focus(); } },
    { type: 'divider' },
    { label: 'Add comment', icon: 'comment', disabled: !text, onClick: () => commentsPanel.triggerAddComment() },
    { label: 'Jump to location in PDF', onClick: () => syncTex.syncToPdf() },
  ], { className: 'context-menu' });
});
setupModals();
setupLayoutMenu(menuCtx);
setupProjectMenu(menuCtx);

// Arbitrary local-folder access only makes sense for the admin (who runs the
// server and may open folders outside projects/) - non-admin accounts are restricted server-side to their own
// isolated projects/users/<id>/ folder anyway, so the dialog would just
// produce confusing 403s for them.
if (!currentUser.isAdmin) document.getElementById('btn-open-project').classList.add('hidden');

// Die Suche hatte bisher keinen eigenen Button (nur Strg+F) - im Redesign
// ist sie ein Rail-Tab und braucht deshalb eine Verdrahtung.
document.getElementById('btn-search').addEventListener('click', () => searchPanelApi.toggle());
for (const [ids, dlg] of [[['btn-settings', 'btn-dash-settings'], settingsDialog], [['btn-help', 'btn-dash-help'], helpDialog], [['btn-profile', 'btn-dash-profile'], profileDialog]]) {
  for (const id of ids) document.getElementById(id).addEventListener('click', () => dlg.show());
}
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
  profileDialog.hide();
  adminDialog.hide();
  helpDialog.hide();
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
setCollabUser(currentUser);
configureCollab({
  onStatus: (online) => offlineBanner.set(!online),
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
  // Every open doc of the project gets 4410 at once -> one notice.
  onProjectGone: () => {
    if (projectGoneNotice) return;
    projectGoneNotice = setTimeout(() => (projectGoneNotice = null), 2000);
    closeAllSessions();
    projectsView.show();
    alert('Das Projekt wurde vom Eigentümer umbenannt, archiviert oder gelöscht. Deine Änderungen sind gespeichert.');
  },
});
let projectGoneNotice = null;
// Offline = the banner, nothing else: alerts that only say "server unreachable" are dropped.
const nativeAlert = window.alert.bind(window);
window.alert = (msg) => {
  if (offlineBanner.isOffline() && /offline|nicht erreichbar|Failed to fetch/i.test(String(msg))) return;
  nativeAlert(msg);
};

// Desktop app: the local proxy pings the server every 2 s; we ask it every 2 s (cheap, localhost)
// and on the browser's own offline/online events. Back online -> reload the tree (starts prewarm).
let proxyOnline = true;
async function pollDesktopState() {
  const d = await fetch('/api/desktop/info').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!d || !d.desktop) return;
  isDesktop = true;
  window.dispatchEvent(new CustomEvent('lide-offline', { detail: d.online === false }));
  if (d.online && !proxyOnline && currentProjectId) loadTree().catch(() => {});
  proxyOnline = d.online !== false;
  showSyncWarnings(d.warnings || []);
}

// Desktop sync warnings (emergency brake, case-only names): the proxy forgets them after the next
// clean sync, so the banner keeps every text it has shown until the user closes it.
const seenSyncWarnings = new Set();
function showSyncWarnings(list) {
  const fresh = list.filter((w) => !seenSyncWarnings.has(w));
  if (!fresh.length) return;
  let bar = document.getElementById('sync-warning');
  if (!bar) {
    bar = Object.assign(document.createElement('div'), { id: 'sync-warning', role: 'alert' });
    const close = Object.assign(document.createElement('button'), { className: 'update-banner-close', textContent: '×', title: 'Ausblenden' });
    close.addEventListener('click', () => bar.remove());
    bar.appendChild(close);
    document.body.appendChild(bar);
  }
  for (const w of fresh) {
    seenSyncWarnings.add(w);
    bar.appendChild(Object.assign(document.createElement('div'), { textContent: `Lokale Kopie – ${w}` }));
  }
}
fetch('/api/desktop/info')
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => {
    isDesktop = !!d.desktop;
    if (isDesktop && d.online === false) offlineBanner.set(true);
    if (isDesktop) {
      proxyOnline = d.online !== false;
      setInterval(pollDesktopState, 2000);
      window.addEventListener('offline', pollDesktopState);
      window.addEventListener('online', pollDesktopState);
      checkDesktopUpdate();
    }
  })
  .catch(() => {});

// Admins: banner when GitHub has a newer server release (text/button depend on UPDATE_MODE).
// In button mode the host cron picks the request up within a minute; the banner then follows
// .update-status (written by scripts/server-update.sh) until the new version answers.
async function checkServerUpdate() {
  document.getElementById('update-banner')?.remove(); // re-run from the admin page
  const u = await adminApi.updateStatus().catch(() => null);
  if (!u) return;
  const st = u.status;
  const running = st && st.state === 'running';
  if (!u.available && !running) return;
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  const text = document.createElement('span');
  bar.appendChild(text);
  const log = document.createElement('details');
  log.hidden = true;
  log.append(Object.assign(document.createElement('summary'), { textContent: 'Protokoll' }), document.createElement('pre'));
  bar.appendChild(log);
  if (u.url) bar.appendChild(Object.assign(document.createElement('a'), { href: u.url, target: '_blank', rel: 'noopener', textContent: 'Release-Notizen' }));
  const close = Object.assign(document.createElement('button'), { className: 'update-banner-close', textContent: '×', title: 'Ausblenden' });
  let timer = null;
  close.addEventListener('click', () => { clearTimeout(timer); bar.remove(); });

  // .update-status holds release tags (v1.2.3), the API plain versions (1.2.3).
  const ver = (x) => String(x || '').replace(/^v/, '');
  const from = u.current;
  const target = u.version;
  const failed = (s) => {
    text.textContent = `Update auf ${ver(s.to) || target} fehlgeschlagen (${new Date(s.at).toLocaleString()}). Details im Protokoll bzw. in latex-update.log auf dem Server.`;
    log.querySelector('pre').textContent = s.log || '';
    log.hidden = !s.log;
  };
  // Poll until the server reports the new version (fetch errors = container is restarting).
  // Give up after ~30 min (script killed, server not coming back) instead of polling forever.
  let polls = 0;
  const follow = () => {
    timer = setTimeout(async () => {
      if (!bar.isConnected) return;
      if (++polls > 180) { text.textContent = `Update auf ${target}: nach 30 Minuten noch nicht fertig. Bitte auf dem Server prüfen (latex-update.log).`; return; }
      const v = await adminApi.updateStatus().catch(() => null);
      if (!v) { text.textContent = `Update auf ${target}: Server startet neu …`; return follow(); }
      if (v.current !== from) {
        text.textContent = `Version ${v.current} installiert. `;
        const reload = Object.assign(document.createElement('button'), { textContent: 'Neu laden' });
        reload.addEventListener('click', () => location.reload());
        text.after(reload);
        return;
      }
      const s = v.status;
      const fresh = s && s.at !== seenAt; // new status line since we started watching (no clock comparison)
      if (fresh && s.state === 'failed' && (!s.from || ver(s.from) === from)) return failed(s);
      // Script finished but this server still reports the old version (e.g. .release already on the new tag).
      if (fresh && s.state === 'done') { text.textContent = `Update-Skript meldet ${ver(s.to)} als installiert, der Server läuft aber noch mit ${from}. Bitte auf dem Server prüfen (latex-update.log).`; return; }
      text.textContent = s && s.state === 'running'
        ? `Update auf ${ver(s.to) || target} läuft (Backup, Download, Neubau – dauert einige Minuten) …`
        : `Update auf ${target} angefordert, startet innerhalb einer Minute …`;
      follow();
    }, 10000);
  };
  const seenAt = st ? st.at : null;

  if (running) {
    text.textContent = `Update auf ${ver(st.to) || target} läuft (Backup, Download, Neubau – dauert einige Minuten) …`;
    follow();
  } else if (u.requested) {
    text.textContent = `Update auf ${target} angefordert, startet innerhalb einer Minute …`;
    follow();
  } else {
    text.textContent = `Server-Update verfügbar: Version ${target} (installiert: ${from}). ` +
      (u.mode === 'auto' ? 'Wird nachts automatisch installiert (mit Backup).' : u.mode === 'button' ? '' : 'Installation auf dem Server per scripts/server-update.sh.');
    if (st && st.state === 'failed' && (!st.from || ver(st.from) === from)) failed(st);
    if (u.mode === 'button') {
      const btn = Object.assign(document.createElement('button'), { textContent: st && st.state === 'failed' ? 'Erneut versuchen' : 'Jetzt aktualisieren' });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await adminApi.requestUpdate();
        } catch (e) { btn.disabled = false; return alert(e.message); }
        btn.remove();
        log.hidden = true;
        text.textContent = `Update auf ${target} angefordert, startet innerhalb einer Minute …`;
        follow();
      });
      text.after(btn);
    }
  }
  bar.appendChild(close);
  document.body.appendChild(bar);
}
if (currentUser.isAdmin) checkServerUpdate();

// Desktop app: the local server asks GitHub for a newer release.
async function checkDesktopUpdate() {
  const u = await fetch('/api/desktop/update').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u || !u.available) return;
  if (!confirm(`Update verfügbar – Version ${u.version} (installiert: ${u.current}).\n\nJetzt installieren? Die App wird dafür beendet.`)) return;
  const csrf = document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
  const r = await fetch('/api/desktop/update/install', { method: 'POST', headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf[1]) } : {} }).catch(() => null);
  if (!r || !r.ok) alert('Update konnte nicht geladen werden. Später erneut versuchen.');
}

// Events of another project (this user's active project was switched in another window) are dropped.
const forThisProject = (handlers) =>
  Object.fromEntries(Object.entries(handlers).map(([k, fn]) => [k, (msg) => (msg.projectId && msg.projectId !== currentProjectId ? undefined : fn(msg))]));
connectWs(forThisProject({
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
  // Nur das gerade gezeigte PDF neu laden (oder das erste, falls noch keins offen ist).
  pdfChanged: (msg) => {
    const cur = pdfViewer.getCurrentPath();
    if (msg.path && (!cur || msg.path === cur)) pdfViewer.load(msg.path);
  },
  compileStatus: (msg) => {
    if (msg.status === 'running') els.compileBtn.textContent = 'Kompiliere…';
  },
  commentsChanged: async (msg) => {
    await commentsManager.loadAll();
    editorMgr.refreshCommentsForPath(msg.path, commentsManager.getForFile(msg.path));
    if (commentsPanel.isOpen() && editorMgr.getActivePath() === msg.path) commentsPanel.renderList();
  },
}));

(async function init() {
  let join = null;
  try {
    join = sessionStorage.getItem('latex-ide-join');
    sessionStorage.removeItem('latex-ide-join');
  } catch {}
  if (join) {
    try {
      const { root } = await shareApi.join(join);
      return openProjectByRoot(root);
    } catch (e) {
      alert(e.message);
    }
  }
  // Start und Login landen immer in der Projektübersicht, nicht im zuletzt aktiven Projekt.
  projectsView.show();
})();

}
