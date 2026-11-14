// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const { spawn, execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { childEnv } = require('./childEnv');
const { detectProjectEngine } = require('./detectEngine');

const OUT_DIR = '.latex-ide-out';

// The main file name reaches latexmk as an argument and from there a shell command line
// (pdflatex … "<name>"): "-x=…" is read as a latexmk option, `…` runs as a command
// inside the double quotes (#112). $ % \ ~ are refused by latexmk itself, " by treeOps.
const UNSAFE_MAIN_CHARS = /[\x00-\x1f\x7f`$%\\~"]/;

// null = usable as main file, otherwise the reason (German, shown in the UI).
function mainPathError(relPath) {
  const s = String(relPath || '').split(path.sep).join('/');
  if (!/\.tex$/i.test(s)) return 'Die Hauptdatei muss eine .tex-Datei sein.';
  if (path.isAbsolute(s) || s.split('/').includes('..')) return 'Die Hauptdatei muss im Projekt liegen.';
  if (UNSAFE_MAIN_CHARS.test(s)) return 'Der Pfad der Hauptdatei enthält ein nicht erlaubtes Zeichen (` $ % \\ ~ " oder Steuerzeichen). Bitte umbenennen.';
  if (s.startsWith('&') || s.split('/').some((seg) => seg.startsWith('-'))) return 'Datei- und Ordnernamen im Pfad der Hauptdatei dürfen nicht mit - beginnen (die Datei nicht mit &). Bitte umbenennen.';
  return null;
}

function findMainCandidate(root) {
  // Prefer main.tex, else first .tex at project root containing \documentclass.
  const rootFiles = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.tex') && !mainPathError(f));
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

// latexmk runs latexmkrc/.latexmkrc from the project folder (plus system/user rc files) as
// Perl code. Project files are untrusted (collaborators, zip import, TeX's own \openout),
// so never load them (#111). Opt-in for single-user setups only; the desktop app ignores it.
// The app's own rc (glossaries, #139) is part of the program, not the project, so it always loads.
const RC_ARGS = [...(process.env.LATEXMK_ALLOW_RC === '1' ? [] : ['-norc']), '-r', path.join(__dirname, 'latexmkrc')];

// LuaLaTeX (#119): openin_any=p (see compile()) also blocks Lua's io.open since TeX Live
// 2023, so luaotfload cannot read texmf-dist and every run aborts; older versions check
// nothing in Lua at all. luaSandbox.lua runs first (lualatex --lua=…) and applies the same
// rule to everything Lua can open, read-only access to the TeX/font folders included.
const LUA_SANDBOX = path.join(__dirname, 'luaSandbox.lua');

// latexmk runs the engine command through the shell (sh / cmd.exe) and replaces %S, %O … in
// it (%% = %). null: the path cannot be passed safely (cmd.exe expands %VAR% even in quotes).
function luaLatexCommand(file = LUA_SANDBOX, win = isWin) {
  let p = String(file);
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (win) {
    p = p.replace(/\\/g, '/'); // LuaTeX takes forward slashes on Windows too
    if (/["%]/.test(p)) return null;
    p = `"${p}"`;
  } else {
    p = `'${p.replace(/'/g, `'\\''`)}'`.replace(/%/g, '%%');
  }
  return `lualatex --lua=${p} %O %S`;
}

function texCommand(mainRelPath, settings, outDir) {
  if (BACKEND === 'tectonic') {
    return ['tectonic', ['-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', outDir, mainRelPath]];
  }
  const lua = settings.compiler === 'lualatex';
  return [
    'latexmk',
    [
      ...RC_ARGS, // first: latexmk reads the rc files before it looks at the other options
      ENGINE_FLAG[settings.compiler] || ENGINE_FLAG.pdflatex,
      ...(lua ? [`-lualatex=${luaLatexCommand()}`] : []),
      '-g', // force a real rerun even if latexmk thinks nothing changed since the last (possibly failed) run
      '-interaction=nonstopmode', // skip past recoverable errors instead of blocking on stdin
      // Default: keep producing a best-effort PDF past errors.
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

// luaotfload needs a writable cache. The one in TEXMFVAR is shared by all projects, so the
// sandbox keeps it read-only (a document could otherwise plant Lua code that other
// projects' runs load); each output folder gets its own instead.
const FONT_CACHE_DIR = 'texmf-cache';
const FONT_NAMES_DIR = ['luatex-cache', 'generic', 'names'];
const FONT_NAMES_FILES = ['luaotfload-names.lua.gz', 'luaotfload-names.lua', 'luaotfload-names.luc.gz', 'luaotfload-names.luc'];

// Cache folders of the TeX installation ($TEXMFSYSVAR, $TEXMFVAR …), asked once.
let fontCacheDirs = null;
function sharedFontCacheDirs() {
  if (!fontCacheDirs) {
    fontCacheDirs = new Promise((resolve) => {
      execFile('kpsewhich', ['-var-value=TEXMFCACHE'], { env: childEnv(), cwd: os.tmpdir(), timeout: 20000, windowsHide: true }, (err, stdout) => {
        resolve(err ? [] : String(stdout).trim().split(path.delimiter).filter((d) => d && path.isAbsolute(d)));
      });
    });
  }
  return fontCacheDirs;
}

// The font name database (\setmainfont{Name}) lives only in luaotfload's writable cache.
// Building it scans every TeX and system font (7 s with BasicTeX on a fast Mac, far longer
// with texlive-full on a Pi), so an output folder starts with a copy of one built
// beforehand (luaotfload-tool -u) if the installation has one. Never overwrites, never
// follows a planted file (COPYFILE_EXCL).
async function seedFontNames(outDir, dirs) {
  const dest = path.join(outDir, FONT_CACHE_DIR, ...FONT_NAMES_DIR);
  if (FONT_NAMES_FILES.some((f) => fs.existsSync(path.join(dest, f)))) return false;
  for (const dir of dirs || (await sharedFontCacheDirs())) {
    const src = path.join(dir, ...FONT_NAMES_DIR);
    const found = FONT_NAMES_FILES.filter((f) => fs.existsSync(path.join(src, f)));
    if (!found.length) continue;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of found) fs.copyFileSync(path.join(src, f), path.join(dest, f), fs.constants.COPYFILE_EXCL);
    return true;
  }
  return false;
}

// Extra environment for lualatex: font cache per output folder (relative to the project
// root = cwd, so special characters in the project path cannot break the path list),
// the installation's caches stay readable behind it.
function luaEnv(env, outRel) {
  const out = outRel.split(path.sep).join('/');
  return {
    // luaSandbox.lua refuses Lua every hidden folder in the project except the run's own
    // output folder (and the font cache in it).
    LATEX_IDE_OUT: out,
    TEXMFCACHE: [`${out}/${FONT_CACHE_DIR}`, env.TEXMFCACHE || ['$TEXMFSYSVAR', '$TEXMFVAR'].join(path.delimiter)].join(path.delimiter),
  };
}

function failed(message, file = '') {
  const error = { file, line: null, message, hint: '', raw: '' };
  return { success: false, hasErrors: true, log: message, errors: [error], warnings: [], infos: [], pdfPath: null };
}

// outRel: output dir relative to root (per-user subdir of OUT_DIR on the server).
async function compile(root, mainRelPath, settings = {}, outRel = OUT_DIR, timeoutMs = COMPILE_TIMEOUT_MS) {
  // Every caller (web, desktop, MCP, autocompile) passes through here before latexmk runs.
  const bad = mainPathError(mainRelPath);
  if (bad) return failed(bad, String(mainRelPath || ''));
  // Engine from the document itself when the project setting can't work (see detectEngine.js).
  // Before the LuaLaTeX check, so an automatic switch to lualatex still gets sandbox + font cache.
  let note = '';
  if (BACKEND === 'latexmk') {
    const { engine, reason, warning, changed } = detectProjectEngine(root, mainRelPath, settings.compiler);
    if (changed) {
      settings = { ...settings, compiler: engine };
      note = `[LaTeX-IDE] Compiler automatisch: ${engine} (erkannt: ${reason})\n`;
    }
    if (warning) note += `[LaTeX-IDE] ${warning}\n`;
  }
  const lua = BACKEND === 'latexmk' && settings.compiler === 'lualatex';
  if (lua && !(fs.existsSync(LUA_SANDBOX) && luaLatexCommand())) {
    return failed('LuaLaTeX ist hier nicht verfügbar: Das Sandbox-Skript fehlt oder der Installationspfad enthält " oder %. Bitte pdfLaTeX oder XeLaTeX wählen.');
  }
  const outDir = path.join(root, outRel);
  fs.mkdirSync(outDir, { recursive: true });
  if (lua) {
    try {
      await seedFontNames(outDir);
    } catch {} // without a copy luaotfload builds the database itself
  }
  return new Promise((resolve) => {
    const [cmd, args] = texCommand(mainRelPath, settings, outRel.split(path.sep).join('/'));

    // openin_any=p: a document may not \input absolute paths or ../ outside the
    // project (other users' projects, auth-data.json). No -shell-escape either.
    // max_print_line & Co.: kein harter Umbruch der Log-Zeilen nach 79 Zeichen (Pfade/Warnungen bleiben ganz).
    // Restricted \write18 (TeX Live default: repstopdf for EPS, makeindex …) stays on.
    const base = childEnv();
    const env = { ...base, openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: outDir, max_print_line: '10000', error_line: '254', half_error_line: '238' };
    if (lua) Object.assign(env, luaEnv(base, outRel));
    // \input/\includegraphics relative to a main file in a subfolder (cwd stays the
    // root, see pdfNameFor). "./" keeps log paths in the "(./x.tex" form parseLog
    // reads; the trailing separator appends TeX's default search path.
    const mainDir = path.dirname(mainRelPath).split(path.sep).join('/');
    if (mainDir !== '.') env.TEXINPUTS = `./${mainDir}${path.delimiter}${process.env.TEXINPUTS || ''}`;
    const proc = spawn(cmd, args, { cwd: root, env, detached: !isWin, windowsHide: true });
    running.add(proc);

    let log = '';
    // setEncoding (StringDecoder): Umlaute werden an Chunkgrenzen nicht zerrissen.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    const onData = (d) => {
      log += d;
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
      resolve({ ...r, log: note + r.log });
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

// Klartext-Erklärungen in den Log-Karten, nur für die häufigsten Meldungen.
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
  let lines = log.split(/\r?\n/);
  // latexmk wertet mehrere Läufe aus: nur ab dem letzten TeX-Lauf zählen (alte "undefined citation"/"Rerun" sind erledigt).
  let start = 0;
  lines.forEach((l, i) => {
    if (/^Run number \d+ of rule '(?:pdf|xe|lua|)latex'/.test(l)) start = i;
  });
  lines = lines.slice(start);
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
    let m = line.match(/^(?:error: )?(.*\.(?:tex|sty|cls|bbl|def|cfg|clo|ltx|tikz|pgf|lua)):(\d+):\s*(.*)$/); // tectonic prefixes "error: "
    // TeX bricht Log-Zeilen hart nach 79 Zeichen um - Fehlermeldung wieder zusammensetzen.
    for (let j = i; m && lines[j].length >= 79 && j + 1 < lines.length; j++) m[3] += lines[j + 1];
    if (m) return push(errors, { file: normalizeTexPath(root, m[1]), line: Number(m[2]), message: m[3].trim() }, i);
    m = line.match(/^(?:ERROR|FATAL) - (.*)$/); // biber
    if (m) return push(errors, { file: '', line: null, message: `biber: ${m[1].trim()}` }, i);
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

module.exports = { compile, findMainCandidate, mainPathError, OUT_DIR, parseLog, BACKEND, pdfNameFor, COMPILE_TIMEOUT_MS, texCommand, luaLatexCommand, luaEnv, seedFontNames, LUA_SANDBOX, FONT_CACHE_DIR };
