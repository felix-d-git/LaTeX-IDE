import { api } from './api.js';

export function setupSyncTex({ editorMgr, pdfViewer, getActivePath, onJumpToCode }) {
  const btnToPdf = document.getElementById('btn-sync-to-pdf');
  const btnToCode = document.getElementById('btn-sync-to-code');
  let lastPdfClick = null; // { page, x, y } in synctex bp units

  async function syncToPdf() {
    const path = getActivePath();
    if (!path) {
      alert('Bitte zuerst eine .tex-Datei öffnen.');
      return;
    }
    const line = editorMgr.view.state.doc.lineAt(editorMgr.view.state.selection.main.head).number;
    try {
      const { page, h, v, boxes } = await api.forwardSync(path, line);
      pdfViewer.jumpToPoint(page, h, v, boxes);
    } catch (e) {
      alert('Sprung ins PDF fehlgeschlagen: ' + e.message);
    }
  }

  async function jumpFromPdfPoint(page, x, y) {
    lastPdfClick = { page, x, y };
    try {
      const { file, line } = await api.inverseSync(page, x, y);
      onJumpToCode(file, line);
    } catch (e) {
      alert('Sprung in den Code fehlgeschlagen: ' + e.message);
    }
  }

  async function syncToCode() {
    if (!lastPdfClick) {
      alert('Bitte zuerst eine Stelle im PDF doppelklicken.');
      return;
    }
    await jumpFromPdfPoint(lastPdfClick.page, lastPdfClick.x, lastPdfClick.y);
  }

  btnToPdf.addEventListener('click', syncToPdf);
  btnToCode.addEventListener('click', syncToCode);

  return { syncToPdf, syncToCode, handlePdfDoubleClick: jumpFromPdfPoint };
}
