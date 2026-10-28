// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { withPid } from './api.js';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp']);

export function fileKind(relPath) {
  const dot = relPath.lastIndexOf('.');
  const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

export function createPreviewManager(container) {
  const tabs = new Set();
  let activePath = null;

  function render(path, kind, legacy) {
    container.innerHTML = '';
    if (kind === 'legacy') {
      // Text file that is not UTF-8: shown read-only, editing only after converting.
      const box = document.createElement('div');
      box.className = 'file-preview-legacy';
      const bar = document.createElement('div');
      bar.className = 'file-preview-legacy-bar';
      const msg = document.createElement('span');
      msg.textContent = legacy.message;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = 'Nach UTF-8 umwandeln';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        Promise.resolve(legacy.onConvert()).finally(() => (btn.disabled = false));
      });
      bar.append(msg, btn);
      const pre = document.createElement('pre');
      pre.textContent = legacy.content;
      box.append(bar, pre);
      container.appendChild(box);
      return;
    }
    const url = withPid(`/api/raw?path=${encodeURIComponent(path)}&t=${Date.now()}`);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'file-preview-image';
      img.src = url;
      container.appendChild(img);
    } else {
      const iframe = document.createElement('iframe');
      iframe.className = 'file-preview-pdf';
      iframe.src = url;
      container.appendChild(iframe);
    }
  }

  function openFile(path, kind, legacy) {
    tabs.add(path);
    activePath = path;
    render(path, kind, legacy);
  }

  function closeTab(path) {
    tabs.delete(path);
    if (activePath === path) {
      activePath = null;
      container.innerHTML = '';
    }
  }

  function getActivePath() {
    return activePath;
  }

  function getTabs() {
    return [...tabs];
  }

  function isOpen(path) {
    return tabs.has(path);
  }

  return { openFile, closeTab, getActivePath, getTabs, isOpen };
}
