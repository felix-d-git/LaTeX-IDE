import * as pdfjsLib from 'pdfjs-dist';

// build.js copies pdfjs-dist's worker build to client/dist/pdf.worker.min.mjs
pdfjsLib.GlobalWorkerOptions.workerSrc = '/dist/pdf.worker.min.mjs';

// R6: helle PDF-Spalte (#f4f5f6), weiße Seiten mit 12px Abstand, Toolbar mit
// Seitennavigation, Seiten-Eingabefeld und Zoomstufen-Dropdown.
export function createPdfViewer(container, toolbar, { onPdfDoubleClick } = {}) {
  let pdfDoc = null;
  let scale = 1.2;
  let zoomMode = 'fixed'; // 'fixed' | 'fit-width' | 'fit-page'
  let currentPath = null;
  let currentPage = 1;
  let renderToken = 0;
  const emptyEl = document.getElementById('pdf-empty');
  const pageWrappers = new Map(); // pageNumber -> wrapper element

  // Nach einem Compile wird dasselbe Dokument neu geladen - dann soll die
  // Ansicht exakt dort stehen bleiben, wo sie war (Seite + Position auf der
  // Seite). Nur bei einem *anderen* PDF fängt die Spalte wieder oben an.
  // Einstellungen ▸ PDF-Viewer "Browser": eingebauter Viewer des Browsers im
  // iframe (ohne SyncTeX/Zoom-Leiste der IDE).
  let native = false;
  function setNative(on) {
    native = !!on;
    document.body.classList.toggle('pdf-native', native);
    container.querySelectorAll('.pdf-native-frame').forEach((f) => f.remove());
    if (!native) pdfDoc = null; // nächster load() rendert wieder per PDF.js
    if (currentPath) load(currentPath);
  }

  async function load(path, attempt = 0) {
    if (native) {
      currentPath = path;
      if (emptyEl && emptyEl.parentNode) emptyEl.remove();
      container.querySelectorAll('.pdf-page').forEach((c) => c.remove());
      pageWrappers.clear();
      let frame = container.querySelector('.pdf-native-frame');
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'pdf-native-frame';
        frame.title = 'PDF';
        container.appendChild(frame);
      }
      frame.src = `/api/pdf?path=${encodeURIComponent(path)}&t=${Date.now()}`;
      return;
    }
    const samePdf = path === currentPath;
    const keep = samePdf ? captureScroll() : null;
    currentPath = path;
    const url = `/api/pdf?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    let doc;
    try {
      doc = await pdfjsLib.getDocument(url).promise;
    } catch (e) {
      // Der Datei-Watcher meldet die PDF teils, während latexmk noch schreibt -
      // dann liefert pdf.js einen InvalidPDFException. Einmal kurz später neu
      // versuchen und die bisherige Ansicht so lange stehen lassen.
      if (attempt < 2) {
        setTimeout(() => load(path, attempt + 1), 400);
        return;
      }
      console.warn('PDF konnte nicht geladen werden:', e && e.message);
      return;
    }
    pdfDoc = doc;
    if (emptyEl && emptyEl.parentNode) emptyEl.remove();
    if (!samePdf) currentPage = 1;
    await renderAll(keep);
    updateLabels();
  }

  // Position als Seite + Anteil innerhalb der Seite merken, damit sie auch
  // nach einem Zoomwechsel oder geänderter Seitenhöhe wieder passt.
  function captureScroll() {
    const wrapper = pageWrappers.get(currentPage);
    if (!wrapper) return null;
    const pageTop = wrapper.offsetTop - container.offsetTop;
    return {
      page: currentPage,
      ratio: (container.scrollTop - pageTop) / (wrapper.offsetHeight || 1),
      leftRatio: container.scrollWidth ? container.scrollLeft / container.scrollWidth : 0,
    };
  }

  function restoreScroll(state) {
    if (!state || !pdfDoc) return;
    const page = Math.min(Math.max(1, state.page), pdfDoc.numPages);
    const wrapper = pageWrappers.get(page);
    if (!wrapper) return;
    const pageTop = wrapper.offsetTop - container.offsetTop;
    container.scrollTop = Math.max(0, pageTop + state.ratio * wrapper.offsetHeight);
    container.scrollLeft = state.leftRatio * container.scrollWidth;
    currentPage = page;
  }

  async function effectiveScale(page) {
    if (zoomMode === 'fixed') return scale;
    const base = page.getViewport({ scale: 1 });
    const availW = container.clientWidth - 24;
    const availH = container.clientHeight - 24;
    if (zoomMode === 'fit-width') return Math.max(0.1, availW / base.width);
    return Math.max(0.1, Math.min(availW / base.width, availH / base.height));
  }

  // keepState: vorher gemerkte Position; ohne Angabe wird die aktuelle
  // Position übernommen (z.B. beim Zoomen), damit die Ansicht nicht springt.
  async function renderAll(keepState) {
    if (!pdfDoc) return;
    const restore = keepState === undefined ? captureScroll() : keepState;
    const token = ++renderToken;
    container.querySelectorAll('.pdf-page').forEach((c) => c.remove());
    pageWrappers.clear();
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      if (token !== renderToken) return; // neuer Renderlauf hat übernommen
      const s = await effectiveScale(page);
      if (zoomMode !== 'fixed') scale = s;
      const viewport = page.getViewport({ scale: s });
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page';
      wrapper.dataset.page = String(i);
      wrapper.style.width = viewport.width + 'px';
      wrapper.style.height = viewport.height + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);
      pageWrappers.set(i, wrapper);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      wrapper.addEventListener('dblclick', (e) => {
        if (!onPdfDoubleClick) return;
        const rect = wrapper.getBoundingClientRect();
        // SyncTeX-Koordinaten sind top-left-origin big points, also einfach
        // Canvas-Pixel / Zoom-Skalierung.
        const bpX = (e.clientX - rect.left) / scale;
        const bpY = (e.clientY - rect.top) / scale;
        onPdfDoubleClick(i, bpX, bpY);
      });
    }
    restoreScroll(restore);
    updateLabels();
  }

  function updateLabels() {
    if (toolbar.zoomLabel) toolbar.zoomLabel.textContent = zoomLabelText();
    const total = pdfDoc ? pdfDoc.numPages : 0;
    if (toolbar.pageLabel) toolbar.pageLabel.textContent = total ? `/ ${total}` : '–/–';
    if (toolbar.pageInput && document.activeElement !== toolbar.pageInput) {
      toolbar.pageInput.value = total ? String(currentPage) : '';
    }
  }

  function zoomLabelText() {
    if (zoomMode === 'fit-width') return 'Breite';
    if (zoomMode === 'fit-page') return 'Seite';
    return `${Math.round(scale * 100)}%`;
  }

  function zoom(delta) {
    zoomMode = 'fixed';
    scale = Math.min(3, Math.max(0.25, scale + delta));
    updateLabels();
    if (pdfDoc) renderAll();
  }

  function setZoom(value) {
    if (value === 'fit-width' || value === 'fit-page') zoomMode = value;
    else {
      zoomMode = 'fixed';
      scale = value;
    }
    updateLabels();
    if (pdfDoc) renderAll();
  }

  function getZoomMode() {
    return zoomMode === 'fixed' ? scale : zoomMode;
  }

  function goToPage(n) {
    if (!pdfDoc) return;
    const page = Math.min(pdfDoc.numPages, Math.max(1, n));
    const wrapper = pageWrappers.get(page);
    if (!wrapper) return;
    container.scrollTo({ top: wrapper.offsetTop - container.offsetTop - 12, behavior: 'smooth' });
    currentPage = page;
    updateLabels();
  }

  function getPageCount() {
    return pdfDoc ? pdfDoc.numPages : 0;
  }

  function getCurrentPage() {
    return currentPage;
  }

  // Sichtbare Seite aus der Scrollposition ableiten (kein pdf.js-Eventbus im
  // Einsatz, die Seiten sind einfache DOM-Kinder).
  container.addEventListener('scroll', () => {
    if (!pdfDoc) return;
    const top = container.scrollTop + 24;
    let page = 1;
    for (const [n, el] of pageWrappers) {
      if (el.offsetTop - container.offsetTop <= top) page = n;
    }
    if (page !== currentPage) {
      currentPage = page;
      updateLabels();
    }
  });

  function reload() {
    if (currentPath) load(currentPath);
  }

  function getCurrentPath() {
    return currentPath;
  }

  // Overleaf: Ziel-Absatz gelb hinterlegen (eine Box je SyncTeX-Treffer,
  // h/v = Grundlinie links, H = Höhe), dann ausblenden.
  function jumpToPoint(page, h, v, boxes = []) {
    const wrapper = pageWrappers.get(page);
    if (!wrapper) return;
    if (!boxes.length) boxes = [{ h, v, W: 20, H: 10 }];
    const markers = boxes.map((b) => {
      const marker = document.createElement('div');
      marker.className = 'pdf-sync-marker';
      marker.style.left = b.h * scale + 'px';
      marker.style.top = (b.v - b.H) * scale + 'px';
      marker.style.width = b.W * scale + 'px';
      marker.style.height = b.H * scale + 'px';
      wrapper.appendChild(marker);
      return marker;
    });
    markers[0].scrollIntoView({ block: 'center' });
    setTimeout(() => markers.forEach((m) => m.remove()), 2500);
  }

  return {
    load,
    setNative,
    zoom,
    setZoom,
    getZoomMode,
    reload,
    jumpToPoint,
    getCurrentPath,
    goToPage,
    getPageCount,
    getCurrentPage,
  };
}
