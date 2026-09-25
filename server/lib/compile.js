const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUT_DIR = '.latex-ide-out';

function findMainCandidate(root) {
  // Prefer main.tex, else first .tex at project root containing \documentclass.
  const rootFiles = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.tex'));
  if (rootFiles.includes('main.tex')) return 'main.tex';
  for (const f of rootFiles) {
    const content = fs.readFileSync(path.join(root, f), 'utf8');
    if (/\\documentclass/.test(content)) return f;
  }
  return rootFiles[0] || null;
}

const ENGINE_FLAG = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

function compile(root, mainRelPath, settings = {}) {
  return new Promise((resolve) => {
    const outDir = path.join(root, OUT_DIR);
    fs.mkdirSync(outDir, { recursive: true });

    const engineFlag = ENGINE_FLAG[settings.compiler] || ENGINE_FLAG.pdflatex;
    const args = [
      engineFlag,
      '-g', // force a real rerun even if latexmk thinks nothing changed since the last (possibly failed) run
      '-interaction=nonstopmode', // skip past recoverable errors instead of blocking on stdin
      // Default (Overleaf-style): keep producing a best-effort PDF past errors.
      // Opt-in "Stop on first error" setting swaps that for a hard halt instead.
      ...(settings.stopOnFirstError ? ['-halt-on-error'] : ['-f']),
      '-file-line-error', // emit "file:line: message" so errors can be mapped back to source
      '-synctex=1',
      `-outdir=${OUT_DIR}`,
      mainRelPath,
    ];

    const proc = spawn('latexmk', args, { cwd: root, shell: true });

    let log = '';
    proc.stdout.on('data', (d) => (log += d.toString()));
    proc.stderr.on('data', (d) => (log += d.toString()));

    proc.on('error', (err) => {
      resolve({
        success: false,
        log: `Konnte "latexmk" nicht starten: ${err.message}\nIst TeX Live/MiKTeX im PATH installiert?`,
        errors: [],
        pdfPath: null,
      });
    });

    proc.on('close', (code) => {
      const pdfName = mainRelPath.replace(/\.tex$/i, '.pdf');
      const pdfAbs = path.join(outDir, pdfName);
      const pdfExists = fs.existsSync(pdfAbs);
      const errors = parseErrors(log, root);
      resolve({
        // clean run: exit code 0, pdf produced, no error lines parsed out of the log
        success: code === 0 && pdfExists && errors.length === 0,
        // best-effort pdf exists despite errors/warnings (-f keeps latexmk going past them)
        hasErrors: errors.length > 0 || code !== 0,
        log,
        errors,
        pdfPath: pdfExists ? path.join(OUT_DIR, pdfName).split(path.sep).join('/') : null,
      });
    });
  });
}

// pdflatex is run with -file-line-error, so real errors show up as
// "./chapter/foo.tex:42: message" - normalize that back to a tree-relative,
// forward-slash path so the client can pass it straight to openFile(path, line).
function normalizeTexPath(root, raw) {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (path.isAbsolute(p)) {
    p = path.relative(root, p).split(path.sep).join('/');
  }
  return p;
}

function parseErrors(log, root) {
  const errors = [];
  const seen = new Set();
  // latexmk on Windows emits \r\n; JS regex `.` doesn't match \r, so a
  // trailing \r would stop `$` from ever matching - normalize line endings first.
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^(.*\.tex):(\d+):\s*(.*)$/);
    if (!m) continue;
    const file = normalizeTexPath(root, m[1]);
    const lineNo = Number(m[2]);
    const message = m[3].trim();
    const key = `${file}|${lineNo}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ file, line: lineNo, message });
  }
  return errors;
}

module.exports = { compile, findMainCandidate, OUT_DIR };
