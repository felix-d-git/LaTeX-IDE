// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import katex from 'katex';
import { withPid } from './api.js';
import * as pdfjsLib from 'pdfjs-dist';

// Visual-Modus: dieselbe LaTeX-Quelle, nur per Dekorationen
// gerendert. Jedes Konstrukt, das die Auswahl berührt, zeigt wieder seine
// Quelle - so bleibt alles editierbar, ohne eigenes Rich-Text-Modell.
// Neuaufbau per Regex über die ganze Datei (stex hat keinen Syntaxbaum), aber nur wenn
// nötig: Cursorbewegungen ohne geänderte Berührung behalten die Dekorationen, Tippen in
// einer Zeile reinen Texts verschiebt sie nur (reusable).
// ponytail: alles andere baut die ganze Datei neu, auch eine Strukturänderung in einer
// einzigen Zeile; bei Problemen mit sehr großen Dateien auf view.visibleRanges begrenzen.

export const refreshVisual = StateEffect.define();
// Hauptdatei oder Dateibaum geändert: auch gecachte Tabs bei ihrer nächsten Transaktion neu bauen.
let epoch = 0;
export const bumpVisualEpoch = () => epoch++;

const FORMAT = {
  part: 'cm-v-h cm-v-h1', chapter: 'cm-v-h cm-v-h1', section: 'cm-v-h cm-v-h2',
  subsection: 'cm-v-h cm-v-h3', subsubsection: 'cm-v-h cm-v-h4', paragraph: 'cm-v-h cm-v-h5',
  textbf: 'cm-v-b', textit: 'cm-v-i', emph: 'cm-v-i', underline: 'cm-v-u', texttt: 'cm-v-tt',
  textsc: 'cm-v-sc', caption: 'cm-v-caption', footnote: 'cm-v-footnote', url: 'cm-v-link',
};
const CHIP = /^(cite[a-zA-Z]*|[cC]?ref|eqref|autoref|pageref|nameref|vref|label)$/;
const CMD_RE = /\\([a-zA-Z]+)(\*?)\s*(\[[^\]\n]*\])?\{/g;
const VERBATIM = /\\begin\{(verbatim|lstlisting|minted|comment)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
const MATH_ENV = /^\\begin\{(equation|align|gather|multline|flalign|alignat)(\*?)\}/;
const LIST_BEGIN = /^\\begin\{(itemize|enumerate|description)\}(\[[^\]]*\])?$/;
const LIST_END = /^\\end\{(itemize|enumerate|description)\}$/;
const HIDE_LINE = /^(\\begin\{(figure|table|center|wrapfigure)\*?\}(\[[^\]]*\])?(\{[^}]*\})*|\\end\{(figure|table|center|wrapfigure)\*?\}|\\centering)$/;
const ITEM = /^(\s*)\\item(\[[^\]]*\])?\s?/;
const ESCAPED = /\\([%&_#$])/g;
const SPACES = /~|\\[,;]/g;

const hidden = Decoration.replace({});
const commentMark = Decoration.mark({ class: 'cm-v-comment' });

// Klick auf ein gerendertes Element setzt den Cursor davor → Quelle erscheint.
function revealOnClick(dom, view, pos) {
  dom.addEventListener('mousedown', (e) => {
    e.preventDefault();
    view.dispatch({ selection: { anchor: pos ?? view.posAtDOM(dom) } });
    view.focus();
  });
}

const mathCache = new Map();
function renderMath(src, display, macros) {
  const macroKey = JSON.stringify(macros);
  const key = (display ? 'D' : 'I') + macroKey + src;
  let html = mathCache.get(key);
  if (html == null) {
    // \label kennt KaTeX nicht; die Nummer liefert erst das PDF.
    const tex = src.replace(/\\label\{[^}]*\}/g, '');
    // Kopie, weil KaTeX das Objekt bei \gdef verändert.
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', macros: { ...macros } });
    if (mathCache.size > 500) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

class MathWidget extends WidgetType {
  constructor(src, display, macros) {
    super();
    this.src = src;
    this.display = display;
    this.macros = macros;
  }
  eq(o) {
    return o.src === this.src && o.display === this.display && JSON.stringify(o.macros) === JSON.stringify(this.macros);
  }
  toDOM(view) {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-v-math cm-v-math-display' : 'cm-v-math';
    el.innerHTML = renderMath(this.src, this.display, this.macros);
    revealOnClick(el, view);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(spec, body, macros) {
    super();
    this.spec = spec;
    this.body = body;
    this.macros = macros;
  }
  eq(o) {
    return o.spec === this.spec && o.body === this.body && JSON.stringify(o.macros) === JSON.stringify(this.macros);
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-v-table';
    const table = wrap.appendChild(document.createElement('table'));
    for (const row of parseTabular(this.spec, this.body)) {
      const tr = table.appendChild(document.createElement('tr'));
      for (const cell of row) {
        const td = tr.appendChild(document.createElement('td'));
        td.colSpan = cell.span;
        td.style.textAlign = cell.align;
        for (const part of cell.parts) {
          if (part.math == null) {
            td.appendChild(document.createTextNode(part.text));
          } else {
            const span = td.appendChild(document.createElement('span'));
            span.innerHTML = renderMath(part.math, false, this.macros);
          }
        }
      }
    }
    revealOnClick(wrap, view);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class TextWidget extends WidgetType {
  constructor(text, className, block = false, clickPos = null) {
    super();
    this.text = text;
    this.className = className;
    this.block = block;
    this.clickPos = clickPos;
  }
  eq(o) {
    return o.text === this.text && o.className === this.className && o.clickPos === this.clickPos;
  }
  toDOM(view) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = this.className;
    el.textContent = this.text;
    revealOnClick(el, view, this.clickPos);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class TitleWidget extends WidgetType {
  constructor(title, author, date) {
    super();
    this.parts = [title, author, date];
  }
  eq(o) {
    return o.parts.join('\0') === this.parts.join('\0');
  }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-v-title';
    ['cm-v-title-main', 'cm-v-title-author', 'cm-v-title-date'].forEach((cls, i) => {
      if (!this.parts[i]) return;
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = this.parts[i];
      el.appendChild(line);
    });
    revealOnClick(el, view);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// PDF-Abbildungen einmal per pdf.js rastern und als Data-URL merken, weil
// CodeMirror Widgets außerhalb des Viewports verwirft und neu erzeugt.
const pdfThumbs = new Map();
export const clearPdfThumbs = () => pdfThumbs.clear(); // bei Datei-/Baumänderung: neu hochgeladene PDFs neu rastern
async function pdfThumb(url) {
  if (!pdfThumbs.has(url)) {
    pdfThumbs.set(url, (async () => {
      const pdf = await pdfjsLib.getDocument({ url, wasmUrl: '/dist/pdfjs-wasm/' }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1000 / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pdf.destroy();
      return canvas.toDataURL('image/png');
    })().catch((e) => { pdfThumbs.delete(url); throw e; }));
  }
  return pdfThumbs.get(url);
}

class ImageWidget extends WidgetType {
  constructor(file, rawPath, width) {
    super();
    this.file = file; // projektrelativer Pfad oder null, wenn nicht gefunden
    this.rawPath = rawPath;
    this.width = width;
  }
  eq(o) {
    return o.file === this.file && o.rawPath === this.rawPath && o.width === this.width;
  }
  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'cm-v-figure';
    revealOnClick(el, view);
    if (!this.file || /\.eps$/i.test(this.file)) {
      const note = document.createElement('span');
      note.className = this.file ? 'cm-v-chip' : 'cm-v-chip cm-v-missing';
      note.textContent = this.file ? this.rawPath : `Bild fehlt: ${this.rawPath}`;
      el.appendChild(note);
      return el;
    }
    const img = document.createElement('img');
    img.alt = this.rawPath;
    img.style.width = `${Math.round(this.width * 100)}%`;
    img.addEventListener('load', () => view.requestMeasure());
    const url = withPid(`/api/raw?path=${encodeURIComponent(this.file)}`);
    if (/\.pdf$/i.test(this.file)) {
      pdfThumb(url).then((src) => (img.src = src)).catch(() => (img.alt = `PDF nicht lesbar: ${this.rawPath}`));
    } else {
      img.src = url;
    }
    el.appendChild(img);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function closeBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length && i < open + 20000; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// Titelblock für \maketitle: Befehle grob entfernen, \\ als Zeilenumbruch.
function plain(tex) {
  return tex
    .replace(/\\\\(\[[^\]]*\])?/g, '\n')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '')
    .trim();
}
function preambleArg(pre, cmd) {
  const i = pre.search(new RegExp('\\\\' + cmd + '\\s*\\{'));
  if (i < 0) return '';
  const open = pre.indexOf('{', i);
  const close = closeBrace(pre, open);
  return close < 0 ? '' : plain(pre.slice(open + 1, close));
}

function findDollar(s, i, to, dbl) {
  for (; i < to; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '\n' && s[i + 1] === '\n') return -1; // Absatzende: kein Mathe-Ende gefunden
    else if (c === '$') return dbl ? (s[i + 1] === '$' ? i : -1) : i;
  }
  return -1;
}

function scanMath(s, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '[' || n === '(') {
        const close = s.indexOf(n === '[' ? '\\]' : '\\)', i + 2);
        if (close > 0 && close < to) {
          out.push({ from: i, to: close + 2, src: s.slice(i + 2, close), display: n === '[' });
          i = close + 1;
          continue;
        }
      } else if (n === 'b') {
        const m = MATH_ENV.exec(s.slice(i, i + 30));
        if (m) {
          const endTag = `\\end{${m[1]}${m[2]}}`;
          const close = s.indexOf(endTag, i);
          if (close > 0 && close < to) {
            out.push({ from: i, to: close + endTag.length, src: s.slice(i, close + endTag.length), display: true });
            i = close + endTag.length - 1;
            continue;
          }
        }
      }
      i++;
    } else if (c === '$') {
      const dbl = s[i + 1] === '$';
      const start = i + (dbl ? 2 : 1);
      const close = findDollar(s, start, to, dbl);
      if (close < 0) continue;
      out.push({ from: i, to: close + (dbl ? 2 : 1), src: s.slice(start, close), display: dbl });
      i = close + (dbl ? 1 : 0);
    }
  }
  return out;
}

// \newcommand aus Präambeltext → KaTeX-Makros.
// ponytail: Makros mit optionalem Argument bleiben undefiniert (KaTeX kennt keine Vorgabewerte).
const NEWCOMMAND = /\\(?:re|provide)?newcommand\*?\s*(?:\{\s*\\([a-zA-Z]+)\s*\}|\\([a-zA-Z]+))\s*(?:\[\d\])?\s*(\[)?/g;
function parseMacros(s) {
  const macros = {};
  for (const m of s.matchAll(NEWCOMMAND)) {
    if (m[3]) continue;
    const open = m.index + m[0].length;
    if (s[open] !== '{') continue;
    const close = closeBrace(s, open);
    if (close > 0) macros['\\' + (m[1] || m[2])] = s.slice(open + 1, close);
  }
  return macros;
}

function parseGraphicspath(s) {
  const m = /\\graphicspath\s*\{/.exec(s);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const close = closeBrace(s, open);
  return close < 0 ? [] : [...s.slice(open + 1, close).matchAll(/\{([^{}]*)\}/g)].map((p) => p[1].trim()).filter(Boolean);
}

const stripComments = (s) => s.replace(/(^|[^\\])%.*$/gm, '$1');

// An \\ (Zeilen) oder & (Zellen) trennen, nicht innerhalb von {…} oder $…$.
function splitTop(s, sep) {
  const out = [];
  let start = 0;
  let depth = 0;
  let math = false;
  const top = () => depth === 0 && !math;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (sep === '\\' && s[i + 1] === '\\' && top()) {
        out.push(s.slice(start, i));
        const opt = /^\s*\[[^\]]*\]/.exec(s.slice(i + 2, i + 40));
        i += 1 + (opt ? opt[0].length : 0);
        start = i + 1;
      } else i++;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '$') math = !math;
    else if (c === '&' && sep === '&' && top()) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

const TABLE_RULES = /\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|cmidrule(?:\[[^\]]*\])?(?:\([^)]*\))?\{[^}]*\}|addlinespace(?:\[[^\]]*\])?)/g;
const columnAligns = (spec) =>
  [...spec
    .replace(/\*\{(\d+)\}\{([^{}]*)\}/g, (_, n, x) => x.repeat(Number(n)))
    .replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')]
    .filter((c) => 'lcrpmbX'.includes(c))
    .map((c) => (c === 'c' ? 'center' : c === 'r' ? 'right' : 'left'));

function cellParts(tex) {
  const parts = [];
  const pushText = (t) => {
    const p = plain(t).replace(ESCAPED, '$1');
    if (p) parts.push({ text: (/^\s/.test(t) ? ' ' : '') + p + (/\s$/.test(t) ? ' ' : '') });
  };
  let pos = 0;
  for (const m of scanMath(tex, 0, tex.length)) {
    pushText(tex.slice(pos, m.from));
    parts.push({ math: m.src });
    pos = m.to;
  }
  pushText(tex.slice(pos));
  return parts;
}

function parseTabular(spec, body) {
  const aligns = columnAligns(spec);
  const rows = [];
  for (const raw of splitTop(body, '\\')) {
    const line = raw.replace(TABLE_RULES, '').trim();
    if (!line) continue;
    let col = 0;
    rows.push(splitTop(line, '&').map((rawCell) => {
      const cell = { span: 1, align: aligns[col] || 'left', tex: rawCell.trim() };
      const m = /^\\multicolumn\s*\{(\d+)\}\s*\{/.exec(cell.tex);
      if (m) {
        const specOpen = m[0].length - 1;
        const specClose = closeBrace(cell.tex, specOpen);
        const open = cell.tex.indexOf('{', specClose);
        const close = open < 0 ? -1 : closeBrace(cell.tex, open);
        if (close > 0) {
          cell.span = Number(m[1]);
          cell.align = columnAligns(cell.tex.slice(specOpen + 1, specClose))[0] || 'left';
          cell.tex = cell.tex.slice(open + 1, close);
        }
      }
      col += cell.span;
      return { span: cell.span, align: cell.align, parts: cellParts(cell.tex) };
    }));
  }
  return rows;
}

// Ergebnis einer Berührungsprüfung: reicht zum Entscheiden, ob eine Cursorbewegung etwas ändert.
const hit = (c, sel) =>
  c.kind === 'preamble'
    ? sel.some((r) => r.to > 0 && r.from <= c.to)
    : c.kind === 'inside'
      ? sel.some((r) => r.from < c.to && r.to > c.from)
      : sel.some((r) => r.from <= c.to && r.to >= c.from);

function build(state, resolveImage, getPreamble) {
  const doc = state.doc;
  const text = doc.toString();
  const sel = state.selection.ranges;
  const checks = [];
  const check = (kind, from, to) => {
    const c = { kind, from, to };
    c.was = hit(c, sel);
    checks.push(c);
    return c.was;
  };
  const touched = (from, to) => check('touched', from, to);
  const inside = (from, to) => check('inside', from, to);
  const decos = [];

  // 1) Verbatim und Kommentare ausblenden (mit Leerzeichen maskieren, damit
  //    alle Offsets gleich bleiben), Kommentare grau markieren.
  const chars = text.split('');
  const mask = (a, b) => {
    for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  for (const m of text.matchAll(VERBATIM)) mask(m.index, m.index + m[0].length);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\') i++;
    else if (chars[i] === '%') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      decos.push(commentMark.range(i, j));
      mask(i, j);
      i = j;
    }
  }
  let s = chars.join('');

  // 2) Präambel einklappen, alles ab \end{document} ausblenden.
  let bodyFrom = 0;
  let bodyTo = text.length;
  let title = null;
  const begin = s.indexOf('\\begin{document}');
  if (begin >= 0) {
    const line = doc.lineAt(begin);
    bodyFrom = line.to;
    const pre = s.slice(0, begin);
    title = { title: preambleArg(pre, 'title'), author: preambleArg(pre, 'author'), date: preambleArg(pre, 'date') };
    // Beim Öffnen steht der Cursor auf 0 → Präambel bleibt trotzdem zu; Klick springt ans Ende der Zeile.
    if (!check('preamble', 0, line.to)) {
      decos.push(Decoration.replace({ widget: new TextWidget('Präambel', 'cm-v-preamble', true, line.to), block: true }).range(0, line.to));
    }
  }
  const end = s.indexOf('\\end{document}', bodyFrom);
  if (end >= 0) {
    const line = doc.lineAt(end);
    bodyTo = line.from;
    if (!touched(line.from, text.length)) decos.push(Decoration.replace({ block: true }).range(line.from, text.length));
  }

  // Kapiteldateien haben keine eigene Präambel: die der Hauptdatei gilt mit, eigene Definitionen zuletzt.
  const defs = stripComments(getPreamble()) + '\n' + s;
  const macros = parseMacros(defs);
  const graphicsPaths = parseGraphicspath(defs);

  // Block-Widget, wenn das Konstrukt allein auf seinen Zeilen steht.
  const pushWidget = (widget, from, to, canBlock) => {
    const a = doc.lineAt(from);
    const z = doc.lineAt(to);
    const block = canBlock && !text.slice(a.from, from).trim() && !text.slice(to, z.to).trim();
    decos.push(Decoration.replace({ widget, block }).range(block ? a.from : from, block ? z.to : to));
  };

  // 3a) Tabellen vor den Formeln, weil deren $…$ in die Zellen gehören.
  // ponytail: verschachtelte tabular bleiben Quelltext.
  for (const m of s.slice(0, bodyTo).matchAll(/\\begin\{tabular\}(?:\[[^\]]*\])?\s*\{/g)) {
    if (m.index < bodyFrom) continue;
    const open = m.index + m[0].length - 1;
    const specClose = closeBrace(s, open);
    const endAt = specClose < 0 ? -1 : s.indexOf('\\end{tabular}', specClose);
    if (endAt < 0 || endAt >= bodyTo) continue;
    const body = s.slice(specClose + 1, endAt);
    if (body.includes('\\begin{tabular}')) continue;
    const to = endAt + '\\end{tabular}'.length;
    mask(m.index, to);
    if (!touched(m.index, to)) pushWidget(new TableWidget(s.slice(open + 1, specClose), body, macros), m.index, to, true);
  }
  s = chars.join('');

  // 3) Formeln per KaTeX; danach maskieren, damit nichts darin weiter zerlegt wird.
  for (const m of scanMath(s, bodyFrom, bodyTo)) {
    mask(m.from, m.to);
    if (!m.src.trim() || touched(m.from, m.to)) continue;
    pushWidget(new MathWidget(m.src, m.display, macros), m.from, m.to, m.display);
  }
  s = chars.join('');

  // 4) Zeilenweise: Listen (Aufzählungszeichen/Nummern), reine Umgebungszeilen, \maketitle.
  const lists = [];
  const hideLine = (line) => {
    if (!touched(line.from, line.to)) decos.push(Decoration.replace({ block: true }).range(line.from, line.to));
  };
  for (let n = doc.lineAt(bodyFrom).number + (bodyFrom > 0 ? 1 : 0); n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.from >= bodyTo) break;
    const lineText = s.slice(line.from, line.to);
    const trimmed = lineText.trim();
    let m;
    if ((m = LIST_BEGIN.exec(trimmed))) {
      lists.push({ type: m[1], n: 0 });
      hideLine(line);
    } else if (LIST_END.test(trimmed)) {
      lists.pop();
      hideLine(line);
    } else if (HIDE_LINE.test(trimmed)) {
      hideLine(line);
    } else if (trimmed === '\\maketitle' && title) {
      if (!touched(line.from, line.to)) {
        decos.push(
          Decoration.replace({ widget: new TitleWidget(title.title, title.author, title.date), block: true }).range(line.from, line.to)
        );
      }
    } else if (lists.length) {
      const list = lists[lists.length - 1];
      decos.push(Decoration.line({ attributes: { class: 'cm-v-li', style: `padding-left: ${lists.length * 1.5}em` } }).range(line.from));
      if ((m = ITEM.exec(lineText))) {
        list.n++;
        const from = line.from + m[1].length;
        const to = line.from + m[0].length;
        const label = list.type === 'enumerate' ? `${list.n}.` : m[2] ? m[2].slice(1, -1) : '•';
        if (!inside(from, to)) decos.push(Decoration.replace({ widget: new TextWidget(label, 'cm-v-bullet') }).range(from, to));
      }
    }
  }

  // 5) Befehle mit Argument: Formatierung, Links, Chips, Abbildungen.
  CMD_RE.lastIndex = bodyFrom;
  let m;
  while ((m = CMD_RE.exec(s)) && m.index < bodyTo) {
    const name = m[1];
    const from = m.index;
    const open = from + m[0].length - 1;
    const close = closeBrace(s, open);
    if (close < 0 || close >= bodyTo) continue;
    const to = close + 1;
    if (FORMAT[name]) {
      if (close === open + 1 || touched(from, to)) continue;
      decos.push(hidden.range(from, open + 1), Decoration.mark({ class: FORMAT[name] }).range(open + 1, close), hidden.range(close, to));
    } else if (name === 'href') {
      if (s[to] !== '{') continue;
      const close2 = closeBrace(s, to);
      if (close2 < 0 || close2 === to + 1 || touched(from, close2 + 1)) continue;
      decos.push(hidden.range(from, to + 1), Decoration.mark({ class: 'cm-v-link' }).range(to + 1, close2), hidden.range(close2, close2 + 1));
    } else if (CHIP.test(name)) {
      CMD_RE.lastIndex = to;
      if (touched(from, to)) continue;
      const kind = name.startsWith('cite') ? 'cite' : name === 'label' ? 'label' : 'ref';
      const keys = s.slice(open + 1, close).trim();
      decos.push(Decoration.replace({ widget: new TextWidget(keys, `cm-v-chip cm-v-chip-${kind}`) }).range(from, to));
    } else if (name === 'includegraphics') {
      CMD_RE.lastIndex = to;
      if (touched(from, to)) continue;
      const rawPath = s.slice(open + 1, close).trim();
      const w = /width\s*=\s*([\d.]*)\s*\\(textwidth|linewidth|columnwidth)/.exec(m[3] || '');
      const width = w ? Math.min(1, parseFloat(w[1] || '1')) : 0.8;
      decos.push(Decoration.replace({ widget: new ImageWidget(resolveImage(rawPath, graphicsPaths), rawPath, width) }).range(from, to));
    }
  }

  // 6) \% \& \_ \# \$ als reines Zeichen zeigen, ~ \, \; als Leerzeichen.
  ESCAPED.lastIndex = bodyFrom;
  while ((m = ESCAPED.exec(s)) && m.index < bodyTo) {
    if (!touched(m.index, m.index + 2)) decos.push(hidden.range(m.index, m.index + 1));
  }
  SPACES.lastIndex = bodyFrom;
  while ((m = SPACES.exec(s)) && m.index < bodyTo) {
    const to = m.index + m[0].length;
    if (!touched(m.index, to)) decos.push(Decoration.replace({ widget: new TextWidget(' ', 'cm-v-space') }).range(m.index, to));
  }

  return { deco: Decoration.set(decos, true), checks, bodyFrom, epoch };
}

// Eine Zeile reinen Texts kann keine Struktur ändern (auch nicht mit dem Getippten).
const plainLine = (t) => !!t.trim() && !/[\\$%{}&~[\]]/.test(t);

// Getippt in einer reinen Textzeile außerhalb gerenderter Konstrukte: Dekorationen nur verschieben.
// ponytail: mehrzeiliges \newcommand in einer Kapiteldatei fällt hier durch, bis zum nächsten Neuaufbau.
function reusable(v, tr) {
  let n = 0;
  let ok = true;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    n++;
    const oldLine = tr.startState.doc.lineAt(fromA);
    const newLine = tr.newDoc.lineAt(fromB);
    if (fromA < v.bodyFrom || toA > oldLine.to || toB > newLine.to || !plainLine(oldLine.text) || !plainLine(newLine.text)) ok = false;
    // Zeile liegt innerhalb einer mehrzeiligen Formel o. Ä.: deren Quelle ändert sich mit.
    else v.deco.between(oldLine.from, oldLine.to, (a, b, d) => {
      if (d.point && a < b) ok = false;
    });
  });
  return ok && n === 1;
}

export function visualMode({ resolveImage, getPreamble = () => '' }) {
  const safeBuild = (state) => {
    try {
      return build(state, resolveImage, getPreamble);
    } catch (e) {
      console.error('[visual]', e);
      return { deco: Decoration.none, checks: [], bodyFrom: 0, epoch };
    }
  };
  const field = StateField.define({
    create: safeBuild,
    update: (v, tr) => {
      if (v.epoch !== epoch || tr.effects.some((e) => e.is(refreshVisual))) return safeBuild(tr.state);
      if (!tr.docChanged && !tr.selection) return v;
      const sel = tr.state.selection.ranges;
      if (!tr.docChanged) return v.checks.every((c) => hit(c, sel) === c.was) ? v : safeBuild(tr.state);
      if (!reusable(v, tr)) return safeBuild(tr.state);
      const checks = v.checks.map((c) => ({ ...c, from: tr.changes.mapPos(c.from), to: tr.changes.mapPos(c.to) }));
      if (!checks.every((c) => hit(c, sel) === c.was)) return safeBuild(tr.state);
      return { ...v, deco: v.deco.map(tr.changes), checks };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  return [field, EditorView.editorAttributes.of({ class: 'cm-visual' })];
}

export const _forTests = { parseTabular, parseMacros, parseGraphicspath };
