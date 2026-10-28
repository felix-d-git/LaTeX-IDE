// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// R1: drei Resizer — 7px zwischen Sidebar und Editor/PDF-Gruppe, 7px zwischen
// Editor und PDF, 6px zwischen Dateibaum und Gliederung. Die Spalten teilen
// sich den Platz über flex-grow (flex-basis 0), nicht über feste Breiten;
// gezogen wird also das Verhältnis, nicht eine Pixelbreite. Ergebnis liegt in
// localStorage, damit die Aufteilung einen Reload überlebt.

const STORE_KEY = 'latex-ide-panel-sizes';

function loadSizes() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveSizes(sizes) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sizes));
  } catch (e) {
    /* localStorage kann im Privatmodus fehlen - Größen sind dann nur flüchtig */
  }
}

const sizes = loadSizes();

function applyPair(a, b, key) {
  const stored = sizes[key];
  if (!stored) return;
  a.style.flexGrow = stored[0];
  b.style.flexGrow = stored[1];
}

function setupPair({ handle, a, b, key, axis, min = 60 }) {
  if (!handle || !a || !b) return;
  applyPair(a, b, key);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const horizontal = axis === 'x';
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const startA = horizontal ? rectA.width : rectA.height;
    const startB = horizontal ? rectB.width : rectB.height;
    const total = startA + startB;
    const growTotal = (parseFloat(a.style.flexGrow) || defaultGrow(a)) + (parseFloat(b.style.flexGrow) || defaultGrow(b));
    const start = horizontal ? e.clientX : e.clientY;
    document.body.classList.add(horizontal ? 'is-resizing' : 'is-resizing-v');

    function onMove(ev) {
      const delta = (horizontal ? ev.clientX : ev.clientY) - start;
      let sizeA = Math.min(total - min, Math.max(min, startA + delta));
      const ratio = sizeA / total;
      const growA = +(growTotal * ratio).toFixed(3);
      const growB = +(growTotal - growA).toFixed(3);
      a.style.flexGrow = growA;
      b.style.flexGrow = growB;
      sizes[key] = [growA, growB];
    }

    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-resizing', 'is-resizing-v');
      saveSizes(sizes);
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function defaultGrow(el) {
  return parseFloat(getComputedStyle(el).flexGrow) || 1;
}

export function setupResizers() {
  setupPair({
    handle: document.getElementById('resizer-sidebar'),
    a: document.getElementById('sidebar'),
    b: document.getElementById('editor-and-pdf'),
    key: 'sidebar',
    axis: 'x',
    min: 120,
  });
  setupPair({
    handle: document.getElementById('resizer-pdf'),
    a: document.getElementById('editor-pane'),
    b: document.getElementById('pdf-pane'),
    key: 'editorPdf',
    axis: 'x',
    min: 160,
  });
  setupPair({
    handle: document.getElementById('resizer-tree'),
    a: document.getElementById('file-tree'),
    b: document.getElementById('file-outline'),
    key: 'treeOutline',
    axis: 'y',
    min: 60,
  });
}
