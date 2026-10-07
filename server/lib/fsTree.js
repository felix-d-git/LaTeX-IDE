const fs = require('fs');
const path = require('path');

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

module.exports = { buildTree, pickStartFile, isIgnored, isTextFile, TEXT_EXTENSIONS, safeResolve };
