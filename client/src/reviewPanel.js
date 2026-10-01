import { listChanges, acceptChange, rejectChange, onReviewChanged } from './trackChanges.js';
import { listConflicts, resolveConflict } from './collab.js';

function snippetOf(text, max = 80) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

export function setupReviewPanel({ editorMgr, getActivePath }) {
  const panel = document.getElementById('review-panel');
  const fileLabel = document.getElementById('review-file-label');
  const list = document.getElementById('review-list');
  const emptyEl = document.getElementById('review-empty');
  const btnToggle = document.getElementById('btn-review');
  const btnClose = document.getElementById('btn-close-review');

  function isOpen() {
    return !panel.classList.contains('hidden');
  }

  function show() {
    panel.classList.remove('hidden');
    render();
  }

  function hide() {
    panel.classList.add('hidden');
  }

  function toggle() {
    if (isOpen()) hide();
    else show();
  }

  function render() {
    const path = getActivePath();
    fileLabel.textContent = path ? `– ${path.split('/').pop()}` : '';
    list.innerHTML = '';

    if (!path) {
      emptyEl.textContent = 'Keine Datei geöffnet.';
      emptyEl.classList.remove('hidden');
      return;
    }

    // Offline conflicts first: both versions were merged in, the lines need a human look.
    const conflicts = listConflicts(path);
    for (const c of conflicts) {
      const doc = editorMgr.view.state.doc;
      const l1 = doc.lineAt(Math.min(c.from, doc.length)).number;
      const l2 = doc.lineAt(Math.min(c.to, doc.length)).number;
      const el = document.createElement('div');
      el.className = 'review-item type-conflict';
      const type = document.createElement('div');
      type.className = 'review-item-type';
      type.textContent = `⚠ Konflikt · Zeile ${l1 === l2 ? l1 : `${l1}–${l2}`}`;
      const text = document.createElement('div');
      text.className = 'review-item-text';
      text.textContent =
        'Du hast hier offline geändert, während jemand anderes dieselben Zeilen bearbeitet hat. Beide Änderungen wurden zusammengeführt – bitte prüfen.';
      const actions = document.createElement('div');
      actions.className = 'review-item-actions';
      const doneBtn = document.createElement('button');
      doneBtn.textContent = 'Erledigt';
      doneBtn.className = 'primary';
      doneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resolveConflict(path, c.id);
      });
      actions.appendChild(doneBtn);
      el.append(type, text, actions);
      el.addEventListener('click', () => editorMgr.jumpToRange(c.from, c.to));
      list.appendChild(el);
    }

    const items = listChanges(path);
    emptyEl.classList.toggle('hidden', items.length + conflicts.length > 0);
    if (items.length === 0) {
      emptyEl.textContent = 'Keine nachverfolgten Änderungen in dieser Datei.';
      return;
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = `review-item type-${item.type}`;
      el.dataset.tcId = item.id;

      const type = document.createElement('div');
      type.className = 'review-item-type';
      type.textContent = `${item.type === 'insert' ? '+ Einfügung' : '– Löschung'}${item.user ? ' · ' + item.user.name : ''}`;
      el.appendChild(type);

      const text = document.createElement('div');
      text.className = 'review-item-text';
      text.textContent = snippetOf(item.text) || '(leer)';
      el.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'review-item-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.textContent = 'Accept';
      acceptBtn.className = 'primary';
      acceptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        acceptChange(path, item.id);
      });
      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'Reject';
      rejectBtn.className = 'danger';
      rejectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        rejectChange(path, item.id);
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(rejectBtn);
      el.appendChild(actions);

      el.addEventListener('click', () => {
        editorMgr.jumpToRange(item.from, item.to);
      });
      list.appendChild(el);
    }
  }

  function highlight(id) {
    if (!isOpen()) show();
    render();
    const node = list.querySelector(`[data-tc-id="${id}"]`);
    if (!node) return;
    node.classList.add('highlighted');
    node.scrollIntoView({ block: 'nearest' });
    setTimeout(() => node.classList.remove('highlighted'), 1500);
  }

  onReviewChanged((p) => {
    if (isOpen() && p === getActivePath()) render();
  });
  btnToggle.addEventListener('click', toggle);
  btnClose.addEventListener('click', hide);

  return { show, hide, toggle, isOpen, render, highlight };
}
