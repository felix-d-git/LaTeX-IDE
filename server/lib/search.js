// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildTree, isTextFile } = require('./fsTree');

function flattenFiles(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'dir') flattenFiles(n.children, out);
    else if (isTextFile(n.path)) out.push(n.path);
  }
  return out;
}

const MAX_PATTERN = 500; // Zeichen im Suchmuster
const MAX_LINE = 5000; // längere Zeilen werden nicht durchsucht (begrenzt Backtracking-Eingabe)
const SEARCH_TIMEOUT_MS = 5000;

function toRegex(query, { regex, caseSensitive, wholeWord }) {
  if (query.length > MAX_PATTERN) throw new Error(`Suchmuster zu lang (max. ${MAX_PATTERN} Zeichen).`);
  let pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b kennt nur ASCII-Wortzeichen: mit Unicode-Lookarounds sind ä/ö/ü/ß Wortzeichen.
  if (wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  return new RegExp(pattern, (caseSensitive ? 'g' : 'gi') + (wholeWord ? 'u' : ''));
}

// Synchroner Kern; läuft im Worker (searchWorker.js), nie im Haupt-Thread des Servers.
function searchProjectSync(root, query, opts = {}) {
  if (!query) return [];
  const re = toRegex(query, opts);
  const files = flattenFiles(buildTree(root));
  const results = [];
  for (const relPath of files) {
    const abs = path.join(root, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      if (lineText.length > MAX_LINE) return;
      re.lastIndex = 0;
      let match;
      const matches = [];
      while ((match = re.exec(lineText)) !== null) {
        matches.push({ col: match.index, length: match[0].length });
        if (match[0].length === 0) re.lastIndex++;
      }
      if (matches.length) {
        results.push({ file: relPath, line: idx + 1, lineText, matches });
      }
    });
  }
  return results;
}

// Regex-Suche im Worker mit hartem Timeout (ReDoS, #155): hängt das Muster, wird der Worker beendet.
async function searchProject(root, query, opts = {}, timeoutMs = SEARCH_TIMEOUT_MS) {
  if (!query) return [];
  toRegex(query, opts); // ungültige/zu lange Muster sofort ablehnen
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'searchWorker.js'), { workerData: { root, query, opts } });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('Suche abgebrochen: Zeitlimit überschritten (Muster zu aufwendig).'));
    }, timeoutMs);
    w.once('message', (m) => {
      clearTimeout(timer);
      w.terminate();
      m.error ? reject(new Error(m.error)) : resolve(m.results);
    });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Labels aus .tex und Bib-Keys aus .bib für \ref{}/\cite{}-Vorschläge und
// Insert > Citation/Cross reference.
function collectRefs(root) {
  const labels = new Set();
  const bibKeys = new Map();
  for (const relPath of flattenFiles(buildTree(root))) {
    const ext = path.extname(relPath).toLowerCase();
    if (ext !== '.tex' && ext !== '.bib') continue;
    const content = fs.readFileSync(path.join(root, relPath), 'utf8');
    if (ext === '.tex') {
      for (const m of content.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1]);
    } else {
      for (const m of content.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
        if (/^(comment|string|preamble)$/i.test(m[1])) continue;
        // Titel mit einer Ebene verschachtelter Klammern ("{JEDEC} Standard"), Klammern danach entfernen.
        const title = (m[3].match(/\btitle\s*=\s*[{"]((?:[^{}"]|\{[^{}]*\})*)/i) || [])[1] || '';
        const author = (m[3].match(/\bauthor\s*=\s*[{"]((?:[^{}"]|\{[^{}]*\})*)/i) || [])[1] || '';
        bibKeys.set(m[2], { title: title.replace(/[{}]/g, '').trim(), author: author.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim(), file: relPath });
      }
    }
  }
  return {
    labels: [...labels].sort(),
    bibKeys: [...bibKeys].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

module.exports = { searchProject, searchProjectSync, collectRefs };
