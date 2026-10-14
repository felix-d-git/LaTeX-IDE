const fs = require('fs');
const path = require('path');
const { isUtf8 } = require('buffer');

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.latex-ide-out', '.trash', '.latex-ide-history', '.latex-ide-yjs']);
const IGNORED_EXT = new Set([
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls',
  '.fdb_latexmk', '.bbl', '.blg', '.bcf',
]);
// Mehrteilige Endungen: path.extname liefert nur die letzte.
const IGNORED_SUFFIX = ['.synctex.gz', '.run.xml'];
const IGNORED_FILES = new Set(['.latex-ide-comments.json', '.latex-ide-project.json']);

function isIgnored(name) {
  if (IGNORED_DIRS.has(name)) return true;
  if (IGNORED_FILES.has(name) || name.startsWith('.latex-ide-comments.json.')) return true; // inkl. .tmp/.corrupt
  const lower = name.toLowerCase();
  return IGNORED_EXT.has(path.extname(lower)) || IGNORED_SUFFIX.some((s) => lower.endsWith(s));
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

const TEXT_EXTENSIONS = new Set([
  '.tex', '.ltx', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.lbx', '.dbx', '.def', '.dtx', '.ins', '.clo', '.cfg', '.fd',
  '.tikz', '.pgf', '.csv', '.tsv', '.dat', '.lua', '.txt', '.md',
]);
const TEXT_BASENAMES = new Set(['.latexmkrc', 'latexmkrc']); // no extension (path.extname('.latexmkrc') === '')

function isTextFile(relPath) {
  const base = path.posix.basename(String(relPath).replace(/\\/g, '/')).toLowerCase();
  return TEXT_EXTENSIONS.has(path.extname(base)) || TEXT_BASENAMES.has(base);
}

function safeResolve(root, relPath) {
  const abs = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error('Path escapes project root');
  }
  return abs;
}

// Bytes -> text only if they are valid UTF-8 (leading BOM dropped); null otherwise,
// so a Latin-1 file is never silently decoded to U+FFFD and written back.
function decodeText(buf) {
  if (!isUtf8(buf)) return null;
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function readUtf8OrNull(abs) {
  return decodeText(fs.readFileSync(abs));
}

// "Nach UTF-8 umwandeln": windows-1252 is a superset of Latin-1's printable range;
// the inputenc option has to follow, or pdflatex reads the UTF-8 bytes as Latin-1.
function toUtf8Text(buf) {
  return new TextDecoder('windows-1252')
    .decode(buf)
    .replace(/(\\usepackage\s*\[\s*)(?:latin1|latin9|ansinew|cp1252)(\s*\]\s*\{inputenc\})/g, '$1utf8$2');
}

const NOT_UTF8_MSG = 'Datei ist nicht UTF-8-kodiert (vermutlich Latin-1/Windows-1252). Zum Bearbeiten bitte nach UTF-8 umwandeln.';

// Wie safeResolve, aber die Projektwurzel selbst ist kein gültiges Ziel (delete/rename/move).
function resolveEntry(root, relPath) {
  const abs = safeResolve(root, String(relPath ?? ''));
  if (abs === path.resolve(root)) throw new Error('Die Projektwurzel kann nicht verändert werden.');
  return abs;
}

function sameEntry(a, b) {
  try {
    const x = fs.lstatSync(a, { bigint: true });
    const y = fs.lstatSync(b, { bigint: true });
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

// One spelling per file ('./x.tex', 'a//b.tex', 'a/../b.tex' -> 'x.tex' ...): MCP, /yjs and collab share it,
// otherwise the same file gets a second live doc and the two overwrite each other.
const canonRel = (rel) => path.posix.normalize(String(rel)).replace(/^(\.\/)+/, '');

// Start check: DATA_DIR must be writable (Docker volume owned by root = crash loop with an unclear message).
function dataDirError(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.schreibtest-${process.pid}.tmp`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    const uid = process.getuid ? process.getuid() : '?';
    return `Datenordner ${dir} ist nicht beschreibbar für uid ${uid} (${e.code || e.message}). Abhilfe: sudo chown 1000:1000 ${dir}`;
  }
}

module.exports = { canonRel, dataDirError, sameEntry, resolveEntry, buildTree, pickStartFile, isIgnored, isTextFile, TEXT_EXTENSIONS, safeResolve, decodeText, readUtf8OrNull, toUtf8Text, NOT_UTF8_MSG };
