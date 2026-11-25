// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { api } from './api.js';

export function setupProjectDialog({ onOpened }) {
  const dialog = document.getElementById('open-project-dialog');
  const pathInput = document.getElementById('open-project-path');
  const recentEl = document.getElementById('open-project-recent');
  const btnOpen = document.getElementById('btn-open-project');
  const btnCancel = document.getElementById('btn-cancel-open');
  const btnConfirm = document.getElementById('btn-confirm-open');

  let known = new Set(); // projectIds from the list; anything else typed is a folder path
  async function show() {
    dialog.classList.remove('hidden');
    const { recentProjects, localProjects } = await api.listProjects();
    recentEl.innerHTML = '';
    known = new Set([...recentProjects, ...localProjects.map((p) => p.id)]);
    const all = [...new Set([...recentProjects, ...localProjects.map((p) => p.id)])];
    for (const root of all) {
      const el = document.createElement('div');
      el.className = 'recent-item';
      el.textContent = root;
      el.addEventListener('click', () => {
        pathInput.value = root;
      });
      recentEl.appendChild(el);
    }
    pathInput.focus();
  }

  function hide() {
    dialog.classList.add('hidden');
  }

  async function confirmOpen() {
    const root = pathInput.value.trim();
    if (!root) return;
    try {
      const result = await api.openProject(known.has(root) ? { projectId: root } : root);
      hide();
      onOpened(result);
    } catch (e) {
      alert('Fehler beim Öffnen: ' + e.message);
    }
  }

  btnOpen.addEventListener('click', show);
  btnCancel.addEventListener('click', hide);
  btnConfirm.addEventListener('click', confirmOpen);
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmOpen();
  });

  return { show, hide };
}
