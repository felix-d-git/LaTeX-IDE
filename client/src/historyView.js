import { api } from './api.js';
import { renderTree } from './fileTree.js';

const TRIGGER_LABEL = { autosave: 'Autosave', compile: 'Kompilieren' };

function formatDateHeader(iso) {
  return new Date(iso).toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function setupHistoryView() {
  const view = document.getElementById('history-view');
  const btnOpen = document.getElementById('btn-history');
  const btnClose = document.getElementById('btn-close-history');
  const tabAll = document.getElementById('history-tab-all');
  const tabLabels = document.getElementById('history-tab-labels');
  const fileTreeEl = document.getElementById('history-file-tree');
  const listEl = document.getElementById('history-snapshot-list');
  const diffEmpty = document.getElementById('history-diff-empty');
  const diffContent = document.getElementById('history-diff-content');

  let mode = 'all'; // 'all' | 'labels'
  let entries = [];
  let currentTree = null;
  let selectedFile = null;
  let selectedSnapshotId = null;

  // Die Tab-Zeile liegt seit dem R1-Umbau in #editor-pane (also in #main),
  // deshalb genügt hier das Aus-/Einblenden von #main.
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
    isVisible() ? hide() : show();
  }

  async function refresh() {
    const [{ tree }, { entries: historyEntries }] = await Promise.all([api.getTree(), api.getHistory()]);
    entries = historyEntries;
    currentTree = tree;
    renderFileTree();
    renderList();
  }

  function renderFileTree() {
    if (!currentTree) return;
    renderTree(fileTreeEl, currentTree, {
      activePath: selectedFile,
      mainFile: null,
      onOpen: (path) => {
        selectedFile = path;
        renderFileTree();
        loadDiff();
      },
      onSetMain: () => {},
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    const visible = mode === 'labels' ? entries.filter((e) => e.label) : entries;
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-list-empty';
      empty.textContent = mode === 'labels' ? 'Noch keine benannten Versionen.' : 'Noch keine Versionen vorhanden.';
      listEl.appendChild(empty);
      return;
    }

    let lastDateHeader = null;
    for (const entry of visible) {
      const dateHeader = formatDateHeader(entry.createdAt);
      if (dateHeader !== lastDateHeader) {
        const header = document.createElement('div');
        header.className = 'history-date-header';
        header.textContent = dateHeader;
        listEl.appendChild(header);
        lastDateHeader = dateHeader;
      }

      const item = document.createElement('div');
      item.className = 'history-item' + (entry.id === selectedSnapshotId ? ' active' : '');
      item.addEventListener('click', () => {
        selectedSnapshotId = entry.id;
        renderList();
        loadDiff();
      });

      const top = document.createElement('div');
      top.className = 'history-item-top';
      const time = document.createElement('span');
      time.textContent = formatTime(entry.createdAt);
      top.appendChild(time);
      const trigger = document.createElement('span');
      trigger.className = 'history-item-trigger';
      trigger.textContent = TRIGGER_LABEL[entry.trigger] || entry.trigger;
      top.appendChild(trigger);
      item.appendChild(top);

      if (entry.label) {
        const label = document.createElement('div');
        label.className = 'history-item-label';
        label.textContent = '🏷 ' + entry.label;
        item.appendChild(label);
      }

      const labelBtn = document.createElement('button');
      labelBtn.className = 'history-label-btn';
      labelBtn.textContent = entry.label ? 'Umbenennen' : '+ Label';
      labelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = prompt('Name für diese Version:', entry.label || '');
        if (!name || !name.trim()) return;
        await api.addHistoryLabel(entry.id, name.trim());
        await refresh();
      });
      item.appendChild(labelBtn);

      listEl.appendChild(item);
    }
  }

  async function loadDiff() {
    if (!selectedFile || !selectedSnapshotId) {
      diffEmpty.classList.remove('hidden');
      diffContent.classList.add('hidden');
      return;
    }
    try {
      const { parts } = await api.getHistoryDiff(selectedSnapshotId, 'current', selectedFile);
      renderDiff(parts);
      diffEmpty.classList.add('hidden');
      diffContent.classList.remove('hidden');
    } catch (e) {
      diffContent.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'history-diff-error';
      err.textContent = 'Diff konnte nicht geladen werden: ' + e.message;
      diffContent.appendChild(err);
      diffEmpty.classList.add('hidden');
      diffContent.classList.remove('hidden');
    }
  }

  function renderDiff(parts) {
    diffContent.innerHTML = '';
    for (const part of parts) {
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop(); // trailing split artifact from a value ending in \n
      for (const lineText of lines) {
        const row = document.createElement('div');
        row.className = 'diff-line' + (part.added ? ' diff-line-add' : part.removed ? ' diff-line-del' : '');
        const marker = document.createElement('span');
        marker.className = 'diff-line-marker';
        marker.textContent = part.added ? '+' : part.removed ? '-' : ' ';
        row.appendChild(marker);
        const text = document.createElement('span');
        text.textContent = lineText;
        row.appendChild(text);
        diffContent.appendChild(row);
      }
    }
  }

  btnOpen.addEventListener('click', show);
  btnClose.addEventListener('click', hide);
  tabAll.addEventListener('click', () => {
    mode = 'all';
    tabAll.classList.add('active');
    tabLabels.classList.remove('active');
    renderList();
  });
  tabLabels.addEventListener('click', () => {
    mode = 'labels';
    tabLabels.classList.add('active');
    tabAll.classList.remove('active');
    renderList();
  });

  return { show, hide, toggle, isVisible };
}
