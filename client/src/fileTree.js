import { openDropdownAt } from './dropdown.js';

// Mehrfachauswahl (Strg/Cmd+Klick): bleibt über Neu-Rendern erhalten, bis ein
// normaler Klick sie aufhebt oder das Löschen durch ist.
const selected = new Set();

function clearSelection(container) {
  selected.clear();
  container.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
}

// Ist ein Ordner und ein Kind darin gewählt, reicht der Ordner.
function selectedRoots() {
  return [...selected].filter((p) => ![...selected].some((q) => q !== p && p.startsWith(q + '/')));
}

async function deleteSelected(container, ctx) {
  if (selected.size && ctx.onDeleteMany && (await ctx.onDeleteMany(selectedRoots()))) clearSelection(container);
}

export function renderTree(container, tree, ctx) {
  container.innerHTML = '';
  container.appendChild(renderNodes(tree, ctx, container));
  setupRootDrop(container, ctx);
  if (!ctx.onDeleteMany) return;
  container.tabIndex = -1; // damit die Entf-Taste hier ankommt
  container.onkeydown = (e) => {
    if (e.key === 'Delete' && selected.size) { e.preventDefault(); deleteSelected(container, ctx); }
  };
}

function dirnameOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

function basenameOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? relPath : relPath.slice(i + 1);
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

// R4: Zeilenhöhe 28, Pitch 32 (4px margin-bottom), Icon 20px + 4px Abstand,
// 32px rechts dauerhaft für den ⋮-Button freigehalten, damit der Name beim
// Auswählen nicht springt.
function renderNodes(nodes, ctx, container) {
  const wrap = document.createElement('div');
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    if (node.path === ctx.activePath) row.classList.add('active');
    if (node.path === ctx.mainFile) row.classList.add('main-file');
    if (ctx.onDeleteMany) {
      if (selected.has(node.path)) row.classList.add('selected');
      // zuerst registriert: Strg/Cmd+Klick wählt nur aus, alles andere hebt die Auswahl auf
      row.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.stopImmediatePropagation();
          if (selected.delete(node.path)) row.classList.remove('selected');
          else { selected.add(node.path); row.classList.add('selected'); }
        } else if (selected.size) clearSelection(container);
      });
    }

    const details = document.createElement('div');
    details.className = 'tree-entity-details';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = iconMarkup(node.type === 'dir' ? 'chevron-down' : fileIcon(node.name));
    details.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name + (node.path === ctx.mainFile ? '  ★' : '');
    label.title = node.name;
    details.appendChild(label);
    row.appendChild(details);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'tree-menu-btn';
    menuBtn.innerHTML = iconMarkup('dots');
    menuBtn.title = 'Aktionen';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      openNodeMenu(rect.left, rect.bottom, node, ctx, container);
    };
    row.appendChild(menuBtn);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNodeMenu(e.clientX, e.clientY + 18, node, ctx, container);
    };

    // historyView.js reuses this renderer for its read-only snapshot tree
    // (no onMove in its ctx) - only make rows draggable where moving is
    // actually wired up.
    if (ctx.onMove) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData(MOVE_MIME, node.path);
        e.dataTransfer.effectAllowed = 'move';
      });
    }

    el.appendChild(row);

    if (node.type === 'dir') {
      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-children';
      childrenWrap.appendChild(renderNodes(node.children, ctx, container));
      let expanded = true;
      row.addEventListener('click', () => {
        expanded = !expanded;
        icon.innerHTML = iconMarkup(expanded ? 'chevron-down' : 'chevron-right');
        childrenWrap.style.display = expanded ? 'block' : 'none';
      });
      setupDropTarget(row, node.path, ctx);
      el.appendChild(childrenWrap);
    } else {
      row.addEventListener('click', () => ctx.onOpen(node.path));
      if (node.name.toLowerCase().endsWith('.tex')) {
        row.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          ctx.onSetMain(node.path);
        });
        row.title = 'Doppelklick: als Hauptdatei setzen';
      }
    }
    wrap.appendChild(el);
  }
  return wrap;
}

function iconMarkup(name) {
  return `<svg class="ol-icon"><use href="#i-${name}"></use></svg>`;
}

function fileIcon(name) {
  if (/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(name)) return 'image';
  return 'file';
}

// --- Kontextmenü (R4: min-width 160 statt der 240 der Toolbar-Menüs) ---

function openNodeMenu(x, y, node, ctx, container) {
  const isDir = node.type === 'dir';
  const items = [];
  if (ctx.onRename) items.push({ label: 'Rename', onClick: () => ctx.onRename(node.path, isDir, node.name) });
  if (!isDir) {
    items.push({
      label: 'Download',
      icon: 'download',
      onClick: () => window.location.assign(`/api/raw?path=${encodeURIComponent(node.path)}`),
    });
  }
  if (!isDir && ctx.onSetMain && node.name.toLowerCase().endsWith('.tex')) {
    items.push({ type: 'divider' });
    items.push({
      label: 'Set as main document',
      checked: node.path === ctx.mainFile,
      onClick: () => ctx.onSetMain(node.path),
    });
  }
  if (ctx.onDelete) {
    items.push({ type: 'divider' });
    if (ctx.onDeleteMany && selected.size > 1 && selected.has(node.path)) {
      items.push({ label: `Delete ${selected.size} items`, icon: 'close', onClick: () => deleteSelected(container, ctx) });
    } else {
      items.push({ label: 'Delete', icon: 'close', onClick: () => ctx.onDelete(node.path, isDir) });
    }
  }
  if (ctx.onCreateFile) {
    // Bei Dateien (wie Overleaf) im Elternordner anlegen.
    const dir = isDir ? node.path : node.path.split('/').slice(0, -1).join('/');
    items.push({ type: 'divider' });
    items.push({ label: 'New file', icon: 'note-add', onClick: () => ctx.onCreateFile(dir) });
    items.push({ label: 'New folder', icon: 'folder-add', onClick: () => ctx.onCreateFolder(dir) });
    if (ctx.onUploadHere) items.push({ label: 'Upload', icon: 'upload', onClick: () => ctx.onUploadHere(dir) });
  }
  if (items.length === 0) return;
  openDropdownAt(x, y, items, { className: 'context-menu' });
}

// --- Drag & drop: internal move (tree -> tree) and upload from the OS ---
//
// Every row is draggable and carries its own path under a custom MIME type;
// drop targets (folders + tree root) check for that type first and treat it
// as an internal move, falling back to the OS-file-upload path (walked via
// DataTransferItem.webkitGetAsEntry(), Chromium/Firefox) otherwise.

const MOVE_MIME = 'application/x-latex-ide-move';

function setupDropTarget(row, dirPath, ctx) {
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-target');
    handleDrop(e.dataTransfer, dirPath, ctx);
  });
}

function setupRootDrop(container, ctx) {
  container.ondragover = (e) => {
    e.preventDefault();
    container.classList.add('drop-target-root');
  };
  container.ondragleave = (e) => {
    if (e.target === container) container.classList.remove('drop-target-root');
  };
  container.ondrop = (e) => {
    e.preventDefault();
    container.classList.remove('drop-target-root');
    handleDrop(e.dataTransfer, '', ctx);
  };
}

async function handleDrop(dataTransfer, targetDir, ctx) {
  const movedPath = dataTransfer.getData(MOVE_MIME);
  if (movedPath && ctx.onMove) {
    await ctx.onMove(movedPath, targetDir);
    return;
  }
  const entries = await collectDroppedFiles(dataTransfer);
  if (entries.length === 0) return;
  await ctx.onUploadFiles(targetDir, entries);
}

function readEntryRecursively(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => resolve([{ relPath: joinPath(prefix, entry.name), file }]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            const nested = await Promise.all(all);
            resolve(nested.flat());
            return;
          }
          for (const child of batch) {
            all.push(readEntryRecursively(child, joinPath(prefix, entry.name)));
          }
          readBatch();
        });
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

async function collectDroppedFiles(dataTransfer) {
  const items = dataTransfer.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const groups = [];
    for (const item of items) {
      // webkitGetAsEntry() can return null even for a real file item (seen e.g.
      // with programmatically-injected drops) - fall back to getAsFile() per
      // item instead of silently losing that file.
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) {
        groups.push(readEntryRecursively(entry, ''));
      } else {
        const file = item.getAsFile && item.getAsFile();
        if (file) groups.push(Promise.resolve([{ relPath: file.name, file }]));
      }
    }
    const nested = await Promise.all(groups);
    return nested.flat();
  }
  return Array.from(dataTransfer.files || []).map((file) => ({ relPath: file.name, file }));
}

export { dirnameOf, basenameOf, joinPath };
