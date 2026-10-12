const fs = require('fs');
const path = require('path');
const { isUtf8 } = require('buffer');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.latex-ide-out', '.trash', '.latex-ide-history', '.latex-ide-yjs']);
const IGNORED_EXT = new Set([
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls',
  '.fdb_latexmk', '.synctex.gz', '.bbl', '.blg', '.bcf', '.run.xml',
]);
const IGNORED_FILES = new Set(['.latex-ide-comments.json']);

function isIgnored(name) {
  if (IGNORED_DIRS.has(name)) return true;
  if (IGNORED_FILES.has(name)) return true;
  const ext = path.extname(name).toLowerCase();
  return IGNORED_EXT.has(ext);
}

function buildTree(root, relDir = '') {
  const absDir = path.join(root, relDir);
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const relPath = path.join(relDir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      nodes.push({
        type: 'dir',
        name: entry.name,
        path: relPath,
        children: buildTree(root, relPath),
      });
    } else {
      nodes.push({
        type: 'file',
        name: entry.name,
        path: relPath,
      });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

// Startdatei beim Öffnen: flachste main.tex, sonst die erste .tex (Wurzel zuerst, dann Baum-Reihenfolge).
function pickStartFile(root) {
  let level = buildTree(root);
  let first = null;
  while (level.length) {
    const tex = level.filter((n) => n.type === 'file' && n.name.toLowerCase().endsWith('.tex'));
    const main = tex.find((n) => n.name === 'main.tex');
    if (main) return main.path;
    if (!first && tex.length) first = tex[0].path;
    level = level.flatMap((n) => n.children || []);
  }
  return first;
}

const TEXT_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.bst', '.cls', '.txt', '.md', '.cfg']);

function isTextFile(relPath) {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function safeResolve(root, relPath) {
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error('Path escapes project root');
  }
  return abs;
}

// Live editing, replace and history work on UTF-8 only: decoding an older
// Latin-1 file as UTF-8 turns every umlaut into U+FFFD, and writing that back
// destroys it for good.
const NOT_UTF8 = 'Datei ist nicht UTF-8-kodiert (vermutlich Latin-1/Windows-1252). Zum Bearbeiten bitte nach UTF-8 umwandeln.';

function readUtf8OrNull(abs) {
  const buf = fs.readFileSync(abs);
  return isUtf8(buf) ? buf.toString('utf8') : null;
}

// Windows-1252 (superset of Latin-1). Node's TextDecoder treats it as plain
// Latin-1, so 0x80-0x9F (€, „, “, – …) are mapped here.
const CP1252_80 = '\u20ac\x81\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\x8d\u017d\x8f\x90\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\x9d\u017e\u0178';
function decodeCp1252(buf) {
  return buf.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252_80[c.charCodeAt(0) - 0x80]);
}

module.exports = { buildTree, pickStartFile, isIgnored, isTextFile, TEXT_EXTENSIONS, safeResolve, isUtf8, readUtf8OrNull, decodeCp1252, NOT_UTF8 };
