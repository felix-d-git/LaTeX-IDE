import { api } from './api.js';

function formatLastModified(ms) {
  if (!ms) return '–';
  const diffMs = Date.now() - ms;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `vor ${diffH} Std.`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `vor ${diffD} Tag${diffD === 1 ? '' : 'en'}`;
  return new Date(ms).toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: 'numeric' });
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function iconMarkup(name) {
  return `<svg class="ol-icon"><use href="#i-${name}"></use></svg>`;
}

export function setupProjectsView({ onOpenProject, currentUser }) {
  const view = document.getElementById('projects-view');
  const searchInput = document.getElementById('projects-search');
  const tabProjects = document.getElementById('tab-projects');
  const tabShared = document.getElementById('tab-shared');
  const tabArchive = document.getElementById('tab-archive');
  const tabTrash = document.getElementById('tab-trash');
  const tbody = document.getElementById('projects-table-body');
  const emptyEl = document.getElementById('projects-empty');
  const btnAllProjects = document.getElementById('btn-all-projects');
  const btnNewProject = document.getElementById('btn-new-project');
  const sortHeaders = document.querySelectorAll('#projects-table th.sortable');
  const copyDialogEl = document.getElementById('copy-project-dialog');
  const copyNameInput = document.getElementById('copy-project-name-input');
  const btnCloseCopy = document.getElementById('btn-close-copy-project');
  const btnCancelCopy = document.getElementById('btn-cancel-copy-project');
  const btnConfirmCopy = document.getElementById('btn-confirm-copy-project');
  let pendingCopySource = null;

  let mode = 'projects'; // 'projects' | 'shared' | 'archive' | 'trash'
  let cache = { localProjects: [], trashedProjects: [], archivedProjects: [] };
  let sortKey = 'lastModified';
  let sortDir = -1; // -1 desc, 1 asc

  // Die Tab-Zeile liegt seit dem R1-Umbau in #editor-pane und damit in #main -
  // ausblenden von #main genügt, ein eigener Griff auf #tabbar-row entfällt.
  function show() {
    view.classList.remove('hidden');
    document.getElementById('main').classList.add('hidden');
    refresh();
  }

  function hide() {
    view.classList.add('hidden');
    document.getElementById('main').classList.remove('hidden');
  }

  function isVisible() {
    return !view.classList.contains('hidden');
  }

  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  async function refresh() {
    const data = await api.listProjects();
    cache = data;
    render();
  }

  function listForMode() {
    // Shared projects also belong under "Alle Projekte", flagged so they get owner-less actions.
    if (mode === 'projects') return [...cache.localProjects, ...(cache.sharedProjects || []).map((p) => ({ ...p, shared: true }))];
    if (mode === 'shared') return cache.sharedProjects || [];
    if (mode === 'archive') return cache.archivedProjects || [];
    return cache.trashedProjects;
  }

  function updateSortArrows() {
    sortHeaders.forEach((th) => {
      const arrow = th.querySelector('.sort-arrow');
      arrow.textContent = th.dataset.sort === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
    });
  }

  function render() {
    const list = listForMode();
    const q = searchInput.value.trim().toLowerCase();
    const filtered = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list.slice();
    filtered.sort((a, b) => {
      if (sortKey === 'name') return sortDir * a.name.localeCompare(b.name);
      return sortDir * ((a.lastModified || 0) - (b.lastModified || 0));
    });
    updateSortArrows();

    tbody.innerHTML = '';
    emptyEl.classList.toggle('hidden', filtered.length > 0);

    // R8: fünf Spalten — Auswahl, Titel, Eigentümer, Zuletzt geändert, Aktionen
    for (const p of filtered) {
      const tr = document.createElement('tr');

      const tdSelect = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('aria-label', `${p.name} auswählen`);
      tdSelect.appendChild(cb);
      tr.appendChild(tdSelect);

      const tdTitle = document.createElement('td');
      tdTitle.textContent = p.name;
      tdTitle.className = 'project-title';
      tdTitle.addEventListener('click', () => {
        if (mode !== 'projects' && mode !== 'shared') return;
        onOpenProject(p.root);
        hide();
      });
      tr.appendChild(tdTitle);

      const tdOwner = document.createElement('td');
      tdOwner.textContent = p.owner || (currentUser && currentUser.email) || 'ich';
      tr.appendChild(tdOwner);

      const tdModified = document.createElement('td');
      tdModified.textContent = formatLastModified(p.lastModified);
      tr.appendChild(tdModified);

      const tdActions = document.createElement('td');
      tdActions.className = 'project-actions';
      if (mode === 'projects' && !p.shared) {
        tdActions.appendChild(actionBtn('Öffnen', 'primary', () => {
          onOpenProject(p.root);
          hide();
        }));
        tdActions.appendChild(iconBtn('edit', 'Umbenennen', () => renameProject(p.name)));
        tdActions.appendChild(iconBtn('copy', 'Kopieren', () => showCopyDialogFor(p.name)));
        tdActions.appendChild(iconBtn('download', 'Download .zip', () => triggerDownload(api.projectZipUrl(p.name))));
        tdActions.appendChild(iconBtn('file', 'Download PDF', () => downloadPdf(p.name)));
        tdActions.appendChild(iconBtn('archive', 'Archivieren', () => archiveProject(p.name)));
        tdActions.appendChild(iconBtn('close', 'In Papierkorb', () => trashProject(p.name), 'danger'));
      } else if (mode === 'shared' || p.shared) {
        // Owner's project: only open here; leaving is in the share dialog.
        tdActions.appendChild(actionBtn('Öffnen', 'primary', () => {
          onOpenProject(p.root);
          hide();
        }));
      } else if (mode === 'archive') {
        tdActions.appendChild(actionBtn('Wiederherstellen', 'primary', () => unarchiveProject(p.name)));
        tdActions.appendChild(iconBtn('close', 'In Papierkorb', () => trashProject(p.name), 'danger'));
      } else {
        tdActions.appendChild(actionBtn('Wiederherstellen', 'primary', () => restoreProject(p.name)));
        tdActions.appendChild(iconBtn('close', 'Endgültig löschen', () => deletePermanently(p.name), 'danger'));
      }
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  }

  function actionBtn(label, cls, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (cls) btn.className = cls;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function iconBtn(icon, title, onClick, cls) {
    const btn = document.createElement('button');
    btn.innerHTML = iconMarkup(icon);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    if (cls) btn.className = cls;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  async function newProject() {
    const name = prompt('Name des neuen Projekts:');
    if (!name) return;
    try {
      const { root } = await api.createProject(name);
      await refresh();
      onOpenProject(root);
      hide();
    } catch (e) {
      alert('Fehler beim Anlegen: ' + e.message);
    }
  }

  async function renameProject(oldName) {
    const newName = prompt('Neuer Name:', oldName);
    if (!newName || newName === oldName) return;
    try {
      await api.renameProject(oldName, newName);
      await refresh();
    } catch (e) {
      alert('Fehler beim Umbenennen: ' + e.message);
    }
  }

  // Mirrors Overleaf's "Copy project" modal: name field pre-filled with
  // "<name> (Copy)", confirming navigates straight into the new project
  // instead of just refreshing the dashboard row.
  function showCopyDialogFor(name) {
    pendingCopySource = name;
    copyNameInput.value = `${name} (Copy)`;
    copyDialogEl.classList.remove('hidden');
    setTimeout(() => {
      copyNameInput.focus();
      copyNameInput.select();
    }, 0);
  }

  function hideCopyDialog() {
    copyDialogEl.classList.add('hidden');
    pendingCopySource = null;
  }

  async function confirmCopyDialog() {
    const newName = copyNameInput.value.trim();
    if (!newName || !pendingCopySource) return;
    try {
      const { root } = await api.copyProject(pendingCopySource, newName);
      hideCopyDialog();
      onOpenProject(root);
      hide();
    } catch (e) {
      alert('Fehler beim Kopieren: ' + e.message);
    }
  }

  btnCloseCopy.addEventListener('click', hideCopyDialog);
  btnCancelCopy.addEventListener('click', hideCopyDialog);
  btnConfirmCopy.addEventListener('click', confirmCopyDialog);

  async function downloadPdf(name) {
    try {
      const res = await fetch(api.projectPdfUrl(name));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'PDF nicht verfügbar.');
      }
      triggerDownload(api.projectPdfUrl(name));
    } catch (e) {
      alert(e.message);
    }
  }

  async function archiveProject(name) {
    try {
      await api.archiveProject(name);
      await refresh();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  async function unarchiveProject(name) {
    try {
      await api.unarchiveProject(name);
      await refresh();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  async function trashProject(name) {
    if (!confirm(`"${name}" in den Papierkorb verschieben?`)) return;
    try {
      await api.trashProject(name);
      await refresh();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  async function restoreProject(name) {
    try {
      await api.restoreProject(name);
      await refresh();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  async function deletePermanently(name) {
    if (!confirm(`"${name}" endgültig und unwiderruflich löschen?`)) return;
    try {
      await api.deleteProjectPermanently(name);
      await refresh();
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  }

  function setMode(newMode) {
    mode = newMode;
    tabProjects.classList.toggle('active', mode === 'projects');
    tabShared.classList.toggle('active', mode === 'shared');
    tabArchive.classList.toggle('active', mode === 'archive');
    tabTrash.classList.toggle('active', mode === 'trash');
    render();
  }

  // Der frühere Toolbar-Button "Alle Projekte" ist im Redesign der Home-Button
  // links in der Menüleiste (R2/R3) und ruft show() über main.js auf.
  if (btnAllProjects) btnAllProjects.addEventListener('click', show);
  btnNewProject.addEventListener('click', newProject);
  searchInput.addEventListener('input', render);
  tabProjects.addEventListener('click', () => setMode('projects'));
  tabShared.addEventListener('click', () => setMode('shared'));
  tabArchive.addEventListener('click', () => setMode('archive'));
  tabTrash.addEventListener('click', () => setMode('trash'));
  sortHeaders.forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = key === 'name' ? 1 : -1;
      }
      render();
    });
  });

  return { show, hide, toggle, isVisible, refresh, showCopyDialogFor };
}
