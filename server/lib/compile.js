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

// The TeX system is swappable and always runs as a separate process (spawn,
// no shell) - the app never links TeX code. latexmk = TeX Live/MiKTeX (default),
// tectonic = MIT-licensed single binary (XeTeX-based, fetches packages itself).
// tectonic can \input files outside the project even with --untrusted, so the
// multi-user server refuses it (server/index.js) - desktop app only.
// ponytail: tectonic ignores the compiler setting and has no synctex binary for
// the PDF<->source jump; SwiftLaTeX would be a browser-side (WASM) swap instead.
const BACKEND = process.env.TEX_BACKEND === 'tectonic' ? 'tectonic' : 'latexmk';

function texCommand(mainRelPath, settings, outDir) {
  if (BACKEND === 'tectonic') {
    return ['tectonic', ['-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', outDir, mainRelPath]];
  }
  return [
    'latexmk',
    [
      ENGINE_FLAG[settings.compiler] || ENGINE_FLAG.pdflatex,
      '-g', // force a real rerun even if latexmk thinks nothing changed since the last (possibly failed) run
      '-interaction=nonstopmode', // skip past recoverable errors instead of blocking on stdin
      // Default (Overleaf-style): keep producing a best-effort PDF past errors.
      // Opt-in "Stop on first error" setting swaps that for a hard halt instead.
      ...(settings.stopOnFirstError ? ['-halt-on-error'] : ['-f']),
      '-file-line-error', // emit "file:line: message" so errors can be mapped back to source
      '-synctex=1',
      `-outdir=${outDir}`,
      mainRelPath,
    ],
  ];
}

// An endless loop in a document (\def\foo{\foo}\foo) would otherwise block the
// global compile queue for every user until the server restarts.
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_LOG = 4e6; // TeX output loops must not grow the log without bound
const isWin = process.platform === 'win32';
const running = new Set(); // TeX process trees to kill when the server exits

// latexmk -> pdflatex -> biber …: kill the whole tree, not just latexmk.
function killTree(proc) {
  try {
    if (isWin) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else process.kill(-proc.pid, 'SIGKILL');
  } catch {}
}

// detached (own process group) means Ctrl+C no longer reaches TeX by itself.
process.on('exit', () => running.forEach(killTree));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    running.forEach(killTree);
    // Keep the default "terminate" unless someone else handles the signal.
    if (process.listenerCount(sig) === 0) process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
  });
}

// TeX writes <output-directory>/<jobname>.pdf, jobname = basename of the main
// file (latexmk runs without -cd from the project root).
function pdfNameFor(mainRelPath) {
  return String(mainRelPath).split(/[\\/]/).pop().replace(/\.tex$/i, '.pdf');
}

// outRel: output dir relative to root (per-user subdir of OUT_DIR on the server).
function compile(root, mainRelPath, settings = {}, outRel = OUT_DIR, timeoutMs = COMPILE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const outDir = path.join(root, outRel);
    fs.mkdirSync(outDir, { recursive: true });

    const [cmd, args] = texCommand(mainRelPath, settings, outRel.split(path.sep).join('/'));

    // openin_any=p: a document may not \input absolute paths or ../ outside the
    // project (other users' projects, auth-data.json). No -shell-escape either.
    const env = { ...process.env, openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: outDir };
    // \input/\includegraphics relative to a main file in a subfolder (cwd stays the
    // root, see pdfNameFor). "./" keeps log paths in the "(./x.tex" form parseLog
    // reads; the trailing separator appends TeX's default search path.
    const mainDir = path.dirname(mainRelPath).split(path.sep).join('/');
    if (mainDir !== '.') env.TEXINPUTS = `./${mainDir}${path.delimiter}${process.env.TEXINPUTS || ''}`;
    const proc = spawn(cmd, args, { cwd: root, env, detached: !isWin, windowsHide: true });
    running.add(proc);

    let log = '';
    const onData = (d) => {
      log += d.toString();
      // Keep start and end - that's where the error lines are.
      if (log.length > MAX_LOG) log = log.slice(0, 1e6) + '\n[… gekürzt …]\n' + log.slice(-2e6);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(proc);
      resolve(r);
    };
    // Resolve right away instead of waiting for 'close': a grandchild holding the
    // pipe open would delay it forever. No pdfPath - the PDF may be half-written,
    // the viewer keeps the previous one.
    const timer = setTimeout(() => {
      killTree(proc);
      const msg = `Abgebrochen: Zeitlimit von ${Math.round(timeoutMs / 1000)} s überschritten (Endlosschleife im Dokument?)`;
      finish({
        success: false,
        hasErrors: true,
        log: log + '\n' + msg,
        errors: [{ file: '', line: null, message: msg, hint: '', raw: '' }],
        warnings: [],
        infos: [],
        pdfPath: null,
      });
    }, timeoutMs);

    proc.on('error', (err) => {
      finish({
        success: false,
        log: `Konnte "${cmd}" nicht starten: ${err.message}\nIst ${cmd === 'tectonic' ? 'Tectonic' : 'TeX Live/MiKTeX'} im PATH installiert?`,
        errors: [],
        pdfPath: null,
      });
    });

    proc.on('close', (code) => {
      if (settled) return;
      const pdfName = pdfNameFor(mainRelPath);
      const pdfAbs = path.join(outDir, pdfName);
      const pdfExists = fs.existsSync(pdfAbs);
      const { errors, warnings, infos } = parseLog(log, root);
      finish({
        warnings,
        infos,
        // clean run: exit code 0, pdf produced, no error lines parsed out of the log
        success: code === 0 && pdfExists && errors.length === 0,
        // best-effort pdf exists despite errors/warnings (-f keeps latexmk going past them)
        hasErrors: errors.length > 0 || code !== 0,
        log,
        errors,
        pdfPath: pdfExists ? path.join(outRel, pdfName).split(path.sep).join('/') : null,
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

// Klartext-Erklärungen wie in Overleafs Log-Karten, nur für die häufigsten Meldungen.
const HINTS = [
  [/Undefined control sequence/, 'Der Befehl ist unbekannt: Tippfehler oder fehlendes \\usepackage.'],
  [/Missing \$ inserted/, 'Mathe-Zeichen (z. B. _ oder ^) außerhalb einer Mathe-Umgebung. Mit $…$ umschließen oder escapen.'],
  [/File `.*' not found/, 'Eine eingebundene Datei (Paket, Bild, \\input) wurde nicht gefunden. Pfad und Dateiname prüfen.'],
  [/Missing \\begin\{document\}/, 'Text oder Befehle vor \\begin{document}, die dort nicht stehen dürfen.'],
  [/Environment .* undefined/, 'Unbekannte Umgebung: Tippfehler oder fehlendes Paket.'],
  [/\\begin\{.*\} on input line .* ended by \\end/, '\\begin und \\end passen nicht zusammen.'],
  [/Citation .* undefined/, 'Zitat-Key existiert nicht in der .bib-Datei oder BibTeX lief noch nicht.'],
  [/Reference .* undefined/, 'Zu diesem \\ref gibt es kein passendes \\label (oder es fehlt ein weiterer Compile-Lauf).'],
  [/Overfull \\hbox/, 'Eine Zeile ist zu breit und ragt in den Rand.'],
  [/Underfull \\hbox/, 'Eine Zeile ist zu locker gesetzt (viel Weißraum).'],
];

const hintFor = (message) => (HINTS.find(([re]) => re.test(message)) || [])[1] || '';

// Liefert Fehler (file:line:-Format dank -file-line-error), Warnungen und
// Info (Over-/Underfull-Boxen) mit kurzem Log-Auszug.
function parseLog(log, root) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const seen = new Set();
  // latexmk on Windows emits \r\n; JS regex `.` doesn't match \r, so a
  // trailing \r would stop `$` from ever matching - normalize line endings first.
  const lines = log.split(/\r?\n/);
  // ponytail: Datei für Warnungen = zuletzt geöffnete "(./x.tex" im Log; schließende
  // Klammern werden ignoriert, kann also nach Ende eines \input falsch zuordnen.
  let currentFile = null;
  const excerpt = (i) => {
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length && j <= i + 4 && lines[j].trim(); j++) out.push(lines[j]);
    return out.join('\n');
  };
  const push = (list, entry, i) => {
    const key = `${list === errors}|${entry.file}|${entry.line}|${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ ...entry, hint: hintFor(entry.message), raw: excerpt(i) });
  };
  lines.forEach((line, i) => {
    for (const open of line.matchAll(/\((\.\/[^\s()]+\.tex)/g)) currentFile = normalizeTexPath(root, open[1]);
    let m = line.match(/^(?:error: )?(.*\.tex):(\d+):\s*(.*)$/); // tectonic prefixes "error: "
    // TeX bricht Log-Zeilen hart nach 79 Zeichen um - Fehlermeldung wieder zusammensetzen.
    for (let j = i; m && lines[j].length >= 79 && j + 1 < lines.length; j++) m[3] += lines[j + 1];
    if (m) return push(errors, { file: normalizeTexPath(root, m[1]), line: Number(m[2]), message: m[3].trim() }, i);
    m = line.match(/^((?:LaTeX|Package|Class) .*Warning: .*)$/);
    if (m) {
      // Warnungen laufen oft über mehrere Zeilen, die Zeilennummer steht am Ende.
      const full = excerpt(i).replace(/\n\(\w+\)\s*/g, ' ');
      const ln = full.match(/on input line (\d+)/);
      return push(warnings, { file: ln ? currentFile : null, line: ln ? Number(ln[1]) : null, message: full.split('\n')[0] }, i);
    }
    m = line.match(/^((?:Over|Under)full \\[hv]box .*?)(?:in paragraph |in alignment |detected )?at lines? (\d+)/);
    if (m) push(infos, { file: currentFile, line: Number(m[2]), message: line.trim() }, i);
  });
  return { errors, warnings, infos };
}

module.exports = { compile, findMainCandidate, OUT_DIR, parseLog, BACKEND, pdfNameFor, COMPILE_TIMEOUT_MS };
