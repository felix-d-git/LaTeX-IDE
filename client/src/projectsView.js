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
  const selectAll = document.getElementById('projects-select-all');
  const bulkBar = document.getElementById('projects-bulk');
  const bulkCount = document.getElementById('projects-bulk-count');
  const bulkTrash = document.getElementById('bulk-trash');
  const bulkArchive = document.getElementById('bulk-archive');
  const bulkDownload = document.getElementById('bulk-download');
  const bulkLabels = document.getElementById('bulk-labels');
  const labelMenu = document.getElementById('label-menu');
  const labelsList = document.getElementById('labels-list');
  const labelForm = document.getElementById('label-form');
  const labelFormName = document.getElementById('label-form-name');
  const labelFormColors = document.getElementById('label-form-colors');
  const newMenu = document.getElementById('new-project-menu');
  const zipInput = document.getElementById('zip-input');

  let mode = 'projects'; // 'projects' | 'shared' | 'archive' | 'trash'
  let cache = { localProjects: [], trashedProjects: [], archivedProjects: [], labels: { labels: [], assign: {} }, labelColors: [] };
  const selected = new Set(); // Projektschlüssel: eigene = Ordnername, geteilte = Root-Pfad
  let labelFilter = null;
  let labelEditId = null; // null = neues Label
  let labelColor = null;
  let visibleKeys = [];
  const isShared = (p) => !!p.owner;
  const keyOf = (p) => (isShared(p) ? p.root : p.name);
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

  const labelsOf = (p) => (cache.labels.assign[keyOf(p)] || []).map((id) => cache.labels.labels.find((l) => l.id === id)).filter(Boolean);

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
    let filtered = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list.slice();
    if (labelFilter) filtered = filtered.filter((p) => (cache.labels.assign[keyOf(p)] || []).includes(labelFilter));
    filtered.sort((a, b) => {
      if (sortKey === 'name') return sortDir * a.name.localeCompare(b.name);
      return sortDir * ((a.lastModified || 0) - (b.lastModified || 0));
    });
    updateSortArrows();

    tbody.innerHTML = '';
    emptyEl.classList.toggle('hidden', filtered.length > 0);

    visibleKeys = filtered.map(keyOf);
    const existing = new Set([...cache.localProjects, ...(cache.sharedProjects || []), ...cache.trashedProjects, ...(cache.archivedProjects || [])].map(keyOf));
    for (const k of [...selected]) if (!existing.has(k)) selected.delete(k);
    renderLabels();

    // R8: fünf Spalten — Auswahl, Titel, Eigentümer, Zuletzt geändert, Aktionen
    for (const p of filtered) {
      const tr = document.createElement('tr');

      const tdSelect = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(keyOf(p));
      cb.setAttribute('aria-label', `${p.name} auswählen`);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(keyOf(p));
        else selected.delete(keyOf(p));
        updateBulk();
      });
      tdSelect.appendChild(cb);
      tr.appendChild(tdSelect);

      const tdTitle = document.createElement('td');
      tdTitle.textContent = p.name;
      for (const l of labelsOf(p)) tdTitle.appendChild(chip(l));
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
      tdActions.appendChild(iconBtn('dots', 'Labels', (e) => openLabelMenu([keyOf(p)], e.currentTarget)));
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
    updateBulk();
  }

  function chip(l) {
    const s = document.createElement('span');
    s.className = 'label-chip';
    s.textContent = l.name;
    s.style.background = l.color;
    return s;
  }

  // --- Mehrfachauswahl ---

  function updateBulk() {
    const sel = selected.size;
    bulkBar.classList.toggle('hidden', !sel);
    selectAll.checked = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
    if (!sel) return labelMenu.classList.add('hidden');
    const owned = ownedSelected().length > 0;
    bulkCount.textContent = `${sel} ausgewählt`;
    bulkTrash.classList.toggle('hidden', mode === 'trash' || !owned);
    bulkArchive.classList.toggle('hidden', !owned);
    bulkArchive.textContent = mode === 'archive' || mode === 'trash' ? 'Wiederherstellen' : 'Archivieren';
    bulkDownload.classList.toggle('hidden', mode === 'archive' || mode === 'trash');
  }

  // Nur eigene Projekte (Ordnername) - geteilte sind Root-Pfade.
  const ownedSelected = () => [...selected].filter((k) => !k.startsWith('/') && !/^[A-Za-z]:/.test(k));

  async function bulkRun(label, fn) {
    const names = ownedSelected();
    const errors = [];
    for (const n of names) {
      try {
        await fn(n);
      } catch (e) {
        errors.push(`${n}: ${e.message}`);
      }
    }
    selected.clear();
    await refresh();
    if (errors.length) alert(`${label} fehlgeschlagen:\n${errors.join('\n')}`);
  }

  bulkTrash.addEventListener('click', () => {
    if (confirm(`${ownedSelected().length} Projekt(e) in den Papierkorb verschieben?`)) bulkRun('In Papierkorb', (n) => api.trashProject(n));
  });
  bulkArchive.addEventListener('click', () => {
    if (mode === 'archive') bulkRun('Wiederherstellen', (n) => api.unarchiveProject(n));
    else if (mode === 'trash') bulkRun('Wiederherstellen', (n) => api.restoreProject(n));
    else bulkRun('Archivieren', (n) => api.archiveProject(n));
  });
  bulkDownload.addEventListener('click', () => {
    const keys = [...selected];
    triggerDownload(keys.length === 1 && ownedSelected().length === 1 ? api.projectZipUrl(keys[0]) : api.projectsZipUrl(keys));
  });
  bulkLabels.addEventListener('click', (e) => {
    e.stopPropagation();
    openLabelMenu([...selected], bulkLabels);
  });
  selectAll.addEventListener('change', () => {
    for (const k of visibleKeys) {
      if (selectAll.checked) selected.add(k);
      else selected.delete(k);
    }
    render();
  });

  // --- Labels ---

  function openLabelMenu(keys, anchor) {
    labelMenu.innerHTML = '';
    if (!cache.labels.labels.length) labelMenu.textContent = 'Noch keine Labels (links anlegen).';
    for (const l of cache.labels.labels) {
      const n = keys.filter((k) => (cache.labels.assign[k] || []).includes(l.id)).length;
      const row = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = n === keys.length;
      cb.indeterminate = n > 0 && n < keys.length;
      cb.addEventListener('change', async () => {
        try {
          cache.labels = await api.assignLabel(keys, l.id, cb.checked);
          render();
        } catch (e) {
          alert('Fehler: ' + e.message);
        }
      });
      row.append(cb, chip(l));
      labelMenu.appendChild(row);
    }
    labelMenu.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const pr = labelMenu.offsetParent.getBoundingClientRect();
    labelMenu.style.top = `${r.bottom - pr.top + labelMenu.offsetParent.scrollTop}px`;
    labelMenu.style.left = `${Math.max(0, Math.min(r.left - pr.left, pr.width - 220))}px`;
  }

  document.addEventListener('click', (e) => {
    if (!labelMenu.contains(e.target)) labelMenu.classList.add('hidden');
    if (!newMenu.contains(e.target) && e.target !== btnNewProject) newMenu.classList.add('hidden');
  });
  // Klick in der Menü-Checkbox rendert die Tabelle neu und entfernt das Ziel; Menü bleibt trotzdem offen.
  labelMenu.addEventListener('click', (e) => e.stopPropagation());

  function renderLabels() {
    labelsList.innerHTML = '';
    for (const l of cache.labels.labels) {
      const row = document.createElement('div');
      row.className = 'label-row' + (labelFilter === l.id ? ' active' : '');
      const b = document.createElement('button');
      b.className = 'dash-link';
      b.append(chip(l));
      b.title = 'Nach Label filtern';
      b.addEventListener('click', () => {
        labelFilter = labelFilter === l.id ? null : l.id;
        render();
      });
      const edit = document.createElement('button');
      edit.textContent = '✎';
      edit.title = 'Label bearbeiten';
      edit.addEventListener('click', () => showLabelForm(l));
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Label löschen';
      del.addEventListener('click', async () => {
        if (!confirm(`Label "${l.name}" löschen?`)) return;
        try {
          await api.deleteLabel(l.id);
          if (labelFilter === l.id) labelFilter = null;
          await refresh();
        } catch (e) {
          alert('Fehler: ' + e.message);
        }
      });
      row.append(b, edit, del);
      labelsList.appendChild(row);
    }
  }

  function showLabelForm(l) {
    labelEditId = l ? l.id : null;
    labelFormName.value = l ? l.name : '';
    labelColor = l ? l.color : cache.labelColors[0];
    labelFormColors.innerHTML = '';
    for (const c of cache.labelColors) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'label-swatch' + (c === labelColor ? ' active' : '');
      sw.style.background = c;
      sw.setAttribute('aria-label', c);
      sw.addEventListener('click', () => {
        labelColor = c;
        for (const o of labelFormColors.children) o.classList.toggle('active', o === sw);
      });
      labelFormColors.appendChild(sw);
    }
    labelForm.classList.remove('hidden');
    labelFormName.focus();
  }

  document.getElementById('btn-label-add').addEventListener('click', () => showLabelForm(null));
  document.getElementById('label-form-cancel').addEventListener('click', () => labelForm.classList.add('hidden'));
  labelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const name = labelFormName.value;
      if (labelEditId) await api.updateLabel(labelEditId, { name, color: labelColor });
      else await api.addLabel(name, labelColor);
      labelForm.classList.add('hidden');
      await refresh();
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  });

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
      onClick(e);
    });
    return btn;
  }

  async function uploadZip(file) {
    if (!file) return;
    const wrap = document.getElementById('zip-progress-wrap');
    const bar = document.getElementById('zip-progress');
    const lbl = document.getElementById('zip-progress-label');
    const setPct = (p) => { bar.value = p; lbl.textContent = p >= 100 ? 'Wird entpackt…' : `${file.name}: ${p} %`; };
    setPct(0);
    wrap.classList.remove('hidden');
    try {
      const { root } = await api.uploadZip(file, setPct);
      await refresh();
      onOpenProject(root);
      hide();
    } catch (e) {
      alert('Zip-Upload fehlgeschlagen: ' + e.message);
    } finally {
      wrap.classList.add('hidden');
    }
  }

  async function newProject() {
    newMenu.classList.add('hidden');
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
    selected.clear();
    labelFilter = null;
    tabProjects.classList.toggle('active', mode === 'projects');
    tabShared.classList.toggle('active', mode === 'shared');
    tabArchive.classList.toggle('active', mode === 'archive');
    tabTrash.classList.toggle('active', mode === 'trash');
    render();
  }

  // Der frühere Toolbar-Button "Alle Projekte" ist im Redesign der Home-Button
  // links in der Menüleiste (R2/R3) und ruft show() über main.js auf.
  if (btnAllProjects) btnAllProjects.addEventListener('click', show);
  btnNewProject.addEventListener('click', () => newMenu.classList.toggle('hidden'));
  document.getElementById('btn-new-empty').addEventListener('click', newProject);
  document.getElementById('btn-new-zip').addEventListener('click', () => {
    newMenu.classList.add('hidden');
    zipInput.click();
  });
  zipInput.addEventListener('change', () => {
    const f = zipInput.files[0];
    zipInput.value = '';
    uploadZip(f);
  });
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
