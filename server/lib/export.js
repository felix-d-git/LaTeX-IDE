// Export to Word/Markdown/HTML with Pandoc (GPL, run as an external program).
// Pandoc's LaTeX reader would happily read any file on the server
// (\include{/etc/passwd}, absolute image paths, bibliography/csl in metadata),
// so it runs in two steps:
//  1. LaTeX -> JSON AST with --sandbox (no file access at all); \input/\include
//     are expanded by us first, restricted to the project.
//  2. The AST is cleaned: images only if they are files inside the project,
//     no raw blocks, metadata reduced to title/author/date/abstract.
//  3. AST -> target format, now with file access (images, validated .bib).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { safeResolve } = require('./fsTree');
const { expandInputs, stripComments } = require('./wordcount');

const PANDOC = process.env.PANDOC || 'pandoc';
const FORMATS = {
  docx: { to: 'docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  md: { to: 'markdown', ext: 'md', mime: 'text/markdown; charset=utf-8', args: ['--standalone'] },
  html: { to: 'html5', ext: 'html', mime: 'text/html; charset=utf-8', args: ['--standalone', '--self-contained'] },
};
const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps'];
const KEEP_META = ['title', 'author', 'date', 'abstract'];

function pandoc(args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(PANDOC, args, { cwd, encoding: 'buffer', maxBuffer: 200 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const errText = stderr && stderr.length ? stderr.toString('utf8').trim() : '';
        if (err.code === 'ENOENT') err.message = 'Pandoc ist auf dem Server nicht installiert.';
        else if (/Unknown option --sandbox/i.test(errText)) err.message = 'Pandoc ist zu alt (benötigt ≥ 2.15 für --sandbox).';
        else err.message = errText || err.message || 'Pandoc ist fehlgeschlagen.';
        return reject(err);
      }
      resolve(stdout);
    });
    // EPIPE when pandoc exits before reading all input; without a listener it ends the server.
    // The real error arrives in the callback above.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Project-relative path of an existing file, or null.
function projectFile(root, baseDir, rel, exts) {
  for (const ext of exts) {
    for (const p of [path.posix.join(baseDir, rel + ext), rel + ext]) {
      try {
        const abs = safeResolve(root, p);
        if (fs.statSync(abs).isFile()) return path.relative(root, abs).split(path.sep).join('/');
      } catch {}
    }
  }
  return null;
}

function cleanAst(node, root, baseDir) {
  if (Array.isArray(node)) {
    return node.filter((n) => !(n && (n.t === 'RawBlock' || n.t === 'RawInline'))).map((n) => cleanAst(n, root, baseDir));
  }
  if (!node || typeof node !== 'object') return node;
  if (node.t === 'Image') {
    const [attr, alt, [src, title]] = node.c;
    const file = /^[a-z][a-z0-9+.-]*:/i.test(src) ? null : projectFile(root, baseDir, src, IMAGE_EXTS);
    if (!file) return { t: 'Span', c: [['', [], []], cleanAst(alt, root, baseDir)] };
    return { t: 'Image', c: [attr, cleanAst(alt, root, baseDir), [file, title]] };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = cleanAst(v, root, baseDir);
  return out;
}

async function exportProject(root, mainRel, format) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error('Unbekanntes Format.');
  const baseDir = path.posix.dirname(mainRel);
  const tex = expandInputs(root, stripComments(fs.readFileSync(safeResolve(root, mainRel), 'utf8')));

  const ast = JSON.parse(await pandoc(['--sandbox', '-f', 'latex', '-t', 'json'], tex, root));
  const meta = {};
  for (const k of KEEP_META) if (ast.meta[k]) meta[k] = ast.meta[k];
  const clean = { ...ast, meta, blocks: cleanAst(ast.blocks, root, baseDir) };
  for (const k of Object.keys(meta)) meta[k] = cleanAst(meta[k], root, baseDir);

  const bibs = [];
  for (const m of tex.matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    for (const name of m[1].split(',')) {
      const file = projectFile(root, baseDir, name.trim().replace(/\.bib$/, ''), ['.bib']);
      if (file && !bibs.includes(file)) bibs.push(file);
    }
  }
  const args = ['-f', 'json', '-t', fmt.to, ...(fmt.args || []), '-o', '-'];
  const json = JSON.stringify(clean);
  if (bibs.length) {
    try {
      return { data: await pandoc([...args, '--citeproc', ...bibs.map((b) => `--bibliography=${b}`)], json, root), fmt };
    } catch {
      // Broken .bib: export without resolved citations rather than not at all.
    }
  }
  return { data: await pandoc(args, json, root), fmt };
}

// Checked once at startup (async, never throws); the client greys out the export menu entries without Pandoc.
let pandocOk = false;
execFile(PANDOC, ['--version'], { timeout: 10000 }, (err) => { pandocOk = !err; });
const pandocAvailable = () => pandocOk;

module.exports = { pandocAvailable, exportProject, FORMATS, cleanAst };
