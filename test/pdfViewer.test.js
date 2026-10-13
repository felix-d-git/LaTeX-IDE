// PDF-Viewer (#45, #46): nur ein laufender load(), alte Dokumente werden zerstört,
// Seite/Scrollposition bleibt beim Neuladen erhalten. pdfjs-dist ist gemockt, das DOM
// ist eine Minimal-Nachbildung (Seiten 1000 px hoch, 12 px Abstand).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { register } = require('node:module');

const mock = (globalThis.__pdfjsMock = { workers: 0, docs: [], active: 0, maxActive: 0, numPages: 40 });
const mockSrc = `
const m = globalThis.__pdfjsMock;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const GlobalWorkerOptions = {};
export class PDFWorker { constructor() { m.workers++; } destroy() {} }
export function getDocument() {
  m.active++; m.maxActive = Math.max(m.maxActive, m.active);
  const doc = {
    numPages: m.numPages, destroyed: false,
    async getPage() {
      await delay(1);
      if (doc.destroyed) throw new Error('destroyed');
      return {
        getViewport: () => ({ width: 700, height: 1000 }),
        render: () => ({ promise: delay(1).then(() => { if (doc.destroyed) throw new Error('destroyed'); }) }),
      };
    },
    destroy() { doc.destroyed = true; },
  };
  m.docs.push(doc);
  return { promise: delay(20).then(() => { m.active--; return doc; }), destroy() {} };
}`;
const mockUrl = 'data:text/javascript,' + encodeURIComponent(mockSrc);
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(s, c, next) {
      if (s === 'pdfjs-dist') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true };
      return next(s, c);
    }
    // package.json sagt "commonjs", der Client-Code ist aber ESM (sonst bündelt ihn esbuild)
    export async function load(url, c, next) {
      if (url.includes('/client/src/')) return next(url, { ...c, format: 'module' });
      return next(url, c);
    }`)
);

// --- Minimal-DOM ---
const GAP = 12, H = 1000;
class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.className = '';
    this.dataset = {}; this.style = {}; this.listeners = {};
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (!this.parent) return;
    const p = this.parent;
    p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
    if (p.clamp) p.clamp();
  }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  getContext() { return {}; }
  get offsetTop() {
    const pages = this.parent ? this.parent.children.filter((c) => c.className === 'pdf-page') : [];
    return GAP + pages.indexOf(this) * (H + GAP);
  }
  get offsetHeight() { return H; }
}
function makeContainer() {
  const c = new El('div');
  let top = 0;
  Object.defineProperty(c, 'offsetTop', { value: 0 });
  c.clientHeight = 800; c.clientWidth = 900; c.scrollLeft = 0; c.scrollWidth = 900;
  const max = () => Math.max(0, GAP + c.children.filter((x) => x.className === 'pdf-page').length * (H + GAP) - c.clientHeight);
  Object.defineProperty(c, 'scrollTop', {
    get: () => top,
    set: (v) => {
      const n = Math.min(Math.max(0, v), max());
      if (n === top) return;
      top = n;
      (c.listeners.scroll || []).forEach((f) => f());
    },
  });
  c.clamp = () => { c.scrollTop = top; };
  c.querySelectorAll = (sel) => c.children.filter((x) => '.' + x.className === sel);
  return c;
}
globalThis.document = {
  getElementById: () => null,
  createElement: (t) => new El(t),
  body: { classList: { toggle() {} } },
  activeElement: null,
  cookie: '',
};

const pageTop = (n) => GAP + (n - 1) * (H + GAP);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const loadModule = () => import(pathToFileURL(path.join(__dirname, '../client/src/pdfViewer.js')).href);

async function viewerOnPage20() {
  const { createPdfViewer } = await loadModule();
  const container = makeContainer();
  const viewer = createPdfViewer(container, {});
  await viewer.load('.latex-ide-out/main.pdf');
  container.scrollTop = pageTop(20) + 100;
  assert.strictEqual(viewer.getCurrentPage(), 20);
  return { viewer, container };
}

test('überlappende load()-Aufrufe halten Seite + Scrollposition (#45)', async () => {
  const { viewer, container } = await viewerOnPage20();
  mock.maxActive = 0;
  const a = viewer.reload(); // Compile-Antwort
  await wait(30); // erster Load rendert gerade
  const b = viewer.reload(); // pdfChanged
  await Promise.all([a, b]);
  await wait(50);
  assert.strictEqual(mock.maxActive, 1, 'nie zwei Ladevorgänge gleichzeitig');
  assert.strictEqual(viewer.getCurrentPage(), 20);
  assert.strictEqual(container.scrollTop, pageTop(20) + 100);
});

test('Zoomen während des Neuladens springt nicht auf Seite 1 (#45)', async () => {
  const { viewer } = await viewerOnPage20();
  const a = viewer.reload();
  await wait(30);
  viewer.zoom(0.1);
  await a;
  await wait(100);
  assert.strictEqual(viewer.getCurrentPage(), 20);
});
