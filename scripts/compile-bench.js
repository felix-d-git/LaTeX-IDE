#!/usr/bin/env node
// Performance-Test der Compiler (#121): ruft compile() aus server/lib/compile.js direkt auf.
// Nur Wegwerf-Projekte unter os.tmpdir(), nie echte Projekte.
//
//   node scripts/compile-bench.js [--n 5] [--engines pdflatex,xelatex,lualatex] [--docs T1,T2,T3,T4,T5]
//                                 [--skip-load] [--keep] [--json out.json]
//   TEX_BACKEND=tectonic node scripts/compile-bench.js --engines tectonic --docs T1,T2
//
// Ausgabe: Markdown-Tabellen auf stdout (Median, Min–Max in s), Rohdaten optional als JSON.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);
const N = Math.max(1, Number(arg('n', 5)));
const TECTONIC = process.env.TEX_BACKEND === 'tectonic';
const ENGINES = arg('engines', TECTONIC ? 'tectonic' : 'pdflatex,xelatex,lualatex').split(',');
const DOCS = arg('docs', 'T1,T2,T3,T4,T5').split(',');

// compile() setzt -g fest; für den Vergleich ohne -g filtert BENCH_NO_G es aus den latexmk-Argumenten.
// Muss vor dem require von compile.js passieren (destrukturiert spawn beim Laden).
const origSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => origSpawn(cmd, process.env.BENCH_NO_G ? args.filter((a) => a !== '-g') : args, opts);
const { compile, parseLog, OUT_DIR, FONT_CACHE_DIR } = require('../server/lib/compile');
const { detectProjectEngine } = require('../server/lib/detectEngine');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-bench-'));
const sec = (ms) => (ms / 1000).toFixed(2);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stat = (a) => (a.length ? `${sec(median(a))} (${sec(Math.min(...a))}–${sec(Math.max(...a))})` : '–');

// --- Testdokumente ---------------------------------------------------------------------------

// Einfarbiges PNG ohne Abhängigkeiten (zlib + crc32 aus Node).
function png(file, w = 400, h = 300, rgb = [70, 130, 180]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function bib(n) {
  return Array.from({ length: n }, (_, i) => `@article{ref${i},\n  author = {Muster, Max and Beispiel, Erika},\n  title = {Titel Nummer ${i}},\n  journal = {Journal of Examples},\n  year = {${2000 + (i % 25)}},\n  volume = {${i + 1}},\n  pages = {1--10}\n}\n`).join('\n');
}

// Engine-spezifischer Vorspann; der Rest des Dokuments ist für alle Engines gleich.
const fontPre = (engine) => (engine === 'pdflatex' ? '\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n' : '\\usepackage{fontspec}\n');

// Gibt { files: {name: inhalt}, setup(dir) } zurück; MARKER wird für den warmen Lauf ersetzt.
const MARKER = 'Messlauf-Text';
const DOCGEN = {
  T1: (e) => ({ files: { 'main.tex': `\\documentclass{article}\n${fontPre(e)}\\begin{document}\nHallo Welt. ${MARKER}.\n\\end{document}\n` } }),

  T2: (e) => ({
    files: {
      'main.tex': `\\documentclass{report}\n${fontPre(e)}\\usepackage{graphicx,lipsum}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{lit.bib}\n\\begin{document}\n\\tableofcontents\n${MARKER}.\n` +
        Array.from({ length: 6 }, (_, c) => `\\chapter{Kapitel ${c + 1}}\n` + Array.from({ length: 3 }, (_, s) => `\\section{Abschnitt ${s + 1}}\n\\lipsum[1-7] \\cite{ref${c * 3 + s}}\n`).join('') + (c < 2 ? `\\begin{figure}[h]\\centering\\includegraphics[width=.6\\textwidth]{abb${c}.png}\\caption{Abbildung ${c + 1}}\\end{figure}\n` : '')).join('') +
        '\\printbibliography\n\\end{document}\n',
      'lit.bib': bib(30),
    },
    setup: (dir) => [0, 1].forEach((i) => png(path.join(dir, `abb${i}.png`))),
  }),

  T3: (e) => ({
    files: {
      'main.tex': `\\documentclass{report}\n${fontPre(e)}\\usepackage{graphicx,lipsum,tikz,makeidx}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{lit.bib}\n` +
        // \\makenoidxglossaries statt makeglossaries: latexmk -norc ruft makeglossaries nicht auf (#139).
        '\\usepackage{glossaries}\n\\makenoidxglossaries\n\\makeindex\n' +
        Array.from({ length: 30 }, (_, i) => `\\newglossaryentry{g${i}}{name={Begriff${i}},description={Beschreibung ${i}}}\n`).join('') +
        `\\begin{document}\n\\tableofcontents\n\\listoffigures\n${MARKER}.\n` +
        Array.from({ length: 10 }, (_, c) =>
          `\\chapter{Kapitel ${c + 1}}\n` +
          Array.from({ length: 4 }, (_, s) => {
            const f = c * 4 + s;
            const img = f % 2 ? `abb${f}.pdf` : `abb${f}.png`;
            return `\\section{Abschnitt ${s + 1}}\n\\lipsum[1-7]\\index{Begriff${f % 30}} \\gls{g${f % 30}} \\cite{ref${f % 50}}\n` +
              `\\begin{figure}[htbp]\\centering\\includegraphics[width=.5\\textwidth]{${img}}\\caption{Abbildung ${f + 1}}\\end{figure}\n` +
              (s === 0 ? `\\begin{figure}[htbp]\\centering\\begin{tikzpicture}\\draw[step=.5,gray] (0,0) grid (6,4);\\foreach \\x in {0,...,60}{\\fill[blue!\\x] (\\x/10,{2+1.5*sin(\\x*12)}) circle (2pt);}\\end{tikzpicture}\\caption{TikZ ${c + 1}}\\end{figure}\n` : '');
          }).join('')).join('') +
        '\\printnoidxglossaries\n\\printbibliography\n\\printindex\n\\end{document}\n',
      'lit.bib': bib(50),
    },
    setup: (dir) => {
      for (let f = 0; f < 40; f += 2) png(path.join(dir, `abb${f}.png`), 400, 300, [f * 6, 120, 200 - f * 4]);
      for (let f = 1; f < 40; f += 2) fs.copyFileSync(FIG_PDF, path.join(dir, `abb${f}.pdf`));
    },
  }),

  // Nur xelatex/lualatex: Font-Ladezeit mit drei Schriften über den Namen (Font-Datenbank).
  T4: (e) =>
    e === 'pdflatex'
      ? null
      : { files: { 'main.tex': `\\documentclass{article}\n\\usepackage{fontspec,lipsum}\n\\setmainfont{TeX Gyre Termes}\n\\setsansfont{TeX Gyre Heros}\n\\setmonofont{TeX Gyre Cursor}\n\\begin{document}\n${MARKER}. \\lipsum[1-3]\n\n\\textsf{\\lipsum[4]}\n\n\\texttt{\\lipsum[5]}\n\\end{document}\n` } },

  T5: (e) => ({
    files: {
      'main.tex': `\\documentclass{beamer}\n${e === 'pdflatex' ? '\\usepackage[T1]{fontenc}\n' : ''}\\usetheme{Madrid}\n\\begin{document}\n\\begin{frame}{Start}${MARKER}\\end{frame}\n` +
        Array.from({ length: 49 }, (_, i) => `\\begin{frame}{Folie ${i + 2}}\n\\begin{itemize}\\item<1-> Punkt A\\item<2-> Punkt B\\item<3-> Punkt C\\end{itemize}\n\\only<3>{Zusatz ${i}}\\pause Ende\n\\end{frame}\n`).join('') +
        '\\end{document}\n',
    },
  }),
};

let FIG_PDF = null;
async function makeFigPdf() {
  const dir = path.join(TMP, '_fig');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'fig.tex'), '\\documentclass[tikz]{standalone}\\begin{document}\\begin{tikzpicture}\\draw[thick,red] (0,0) rectangle (4,3);\\draw (0,0) -- (4,3);\\end{tikzpicture}\\end{document}\n');
  const r = await compile(dir, 'fig.tex', { compiler: 'pdflatex' });
  if (!r.pdfPath) throw new Error('Abbildungs-PDF ließ sich nicht erzeugen:\n' + r.log.slice(-2000));
  FIG_PDF = path.join(dir, r.pdfPath);
}

// --- Messhilfen ------------------------------------------------------------------------------

const TEX_PROC = /^(latexmk|perl|runscript|pdf(la)?tex|xe(la)?tex|lua(la)?tex|luahbtex|xdvipdfmx|biber|makeindex|bibtex8?|tectonic)(\.exe)?$/i;

// Spitzen-RAM (Summe RSS aller TeX-Prozesse) per Polling; nur bei seriellen Läufen sinnvoll.
// ponytail: Polling alle ~200 ms verpasst kurze Spitzen; im Container stattdessen memory.peak der cgroup lesen.
function ramSampler() {
  let peak = 0;
  let stop = false;
  const sample = () => {
    let sum = 0;
    if (process.platform === 'win32') {
      const out = cp.execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","\d+","[^"]*","\d+","([\d.,\s ]+) K"/);
        if (m && TEX_PROC.test(m[1])) sum += Number(m[2].replace(/[^\d]/g, '')) * 1024;
      }
    } else {
      for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        try {
          const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
          if (TEX_PROC.test((s.match(/^Name:\s+(\S+)/m) || [])[1] || '')) sum += Number((s.match(/^VmRSS:\s+(\d+)/m) || [0, 0])[1]) * 1024;
        } catch {}
      }
    }
    peak = Math.max(peak, sum);
  };
  const loop = (async () => {
    while (!stop) {
      try { sample(); } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return async () => {
    stop = true;
    await loop;
    return peak;
  };
}

const dirSize = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size;
  return n;
};
const mb = (b) => (b / 1048576).toFixed(0);

async function timed(dir, engine, { ram = false } = {}) {
  const stopRam = ram ? ramSampler() : null;
  const t0 = performance.now();
  const r = await compile(dir, 'main.tex', { compiler: engine });
  const ms = performance.now() - t0;
  const peak = stopRam ? await stopRam() : 0;
  const runs = (r.log.match(/^Run number \d+ of rule '(?:pdf|xe|lua|)latex'/gm) || []).length;
  const pages = Number((r.log.match(/Output written on .*?\((\d+) pages?/) || [])[1]) || null;
  const auto = (r.log.match(/Compiler automatisch: (\w+)/) || [])[1];
  if (!r.pdfPath) throw new Error(`${engine}: kein PDF in ${dir}\n${r.log.slice(-3000)}`);
  return { ms, peak, runs, pages, auto, errors: r.errors.length };
}

// --- Messungen -------------------------------------------------------------------------------

async function benchDoc(doc, engine) {
  const gen = DOCGEN[doc](engine === 'tectonic' ? 'xelatex' : engine);
  if (!gen) return null;
  const dir = path.join(TMP, `${doc}-${engine}`);
  fs.mkdirSync(dir);
  for (const [f, c] of Object.entries(gen.files)) fs.writeFileSync(path.join(dir, f), c);
  if (gen.setup) gen.setup(dir);
  const main = path.join(dir, 'main.tex');
  const res = { doc, engine, cold: [], warm: [], noop: [], noopNoG: [], peak: 0, runsCold: [], runsWarm: [], pages: null, outMB: 0, auto: null };
  for (let i = 0; i < N; i++) {
    // kalt: frischer Ausgabeordner = auch leerer Font-Cache (lualatex: Cache liegt im Ausgabeordner)
    fs.rmSync(path.join(dir, OUT_DIR), { recursive: true, force: true });
    fs.writeFileSync(main, gen.files['main.tex']);
    const c = await timed(dir, engine, { ram: true });
    res.cold.push(c.ms);
    res.runsCold.push(c.runs);
    res.peak = Math.max(res.peak, c.peak);
    res.pages = c.pages;
    res.auto = c.auto || null;
    if (i === 0) res.outMB = dirSize(path.join(dir, OUT_DIR));
    // warm: nur Text geändert
    fs.writeFileSync(main, gen.files['main.tex'].replace(MARKER, `${MARKER} ${i}`));
    const w = await timed(dir, engine, { ram: true });
    res.warm.push(w.ms);
    res.runsWarm.push(w.runs);
    res.peak = Math.max(res.peak, w.peak);
    // Kosten von -g: erneut kompilieren ohne Änderung, mit und ohne -g (nur T2, latexmk)
    if (doc === 'T2' && !TECTONIC) {
      res.noop.push((await timed(dir, engine)).ms);
      process.env.BENCH_NO_G = '1';
      res.noopNoG.push((await timed(dir, engine)).ms);
      delete process.env.BENCH_NO_G;
    }
    process.stderr.write(`  ${doc} ${engine} #${i + 1}: kalt ${sec(c.ms)} s, warm ${sec(w.ms)} s\n`);
  }
  return res;
}

// N gleichzeitige Compiles von T2 (pdflatex): wie der Server (eine globale Queue) und echt parallel.
async function benchLoad(p, engine = 'pdflatex') {
  const dirs = [];
  for (let i = 0; i < p; i++) {
    const gen = DOCGEN.T2(engine);
    const dir = path.join(TMP, `load${p}-${i}`);
    fs.mkdirSync(dir);
    for (const [f, c] of Object.entries(gen.files)) fs.writeFileSync(path.join(dir, f), c);
    gen.setup(dir);
    dirs.push(dir);
  }
  const cpuTotals = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
  const out = {};
  for (const mode of ['queue', 'parallel']) {
    dirs.forEach((d) => fs.rmSync(path.join(d, OUT_DIR), { recursive: true, force: true }));
    const c0 = cpuTotals();
    const t0 = performance.now();
    let chain = Promise.resolve();
    const done = dirs.map((d) => {
      const run = mode === 'queue' ? chain.then(() => compile(d, 'main.tex', { compiler: engine })) : compile(d, 'main.tex', { compiler: engine });
      chain = run.catch(() => {});
      return run.then(() => performance.now() - t0);
    });
    const waits = await Promise.all(done);
    const c1 = cpuTotals();
    out[mode] = { waits, cpu: (100 * (c1.busy - c0.busy)) / (c1.all - c0.all) };
  }
  return out;
}

function benchParseLog() {
  // Log knapp unter MAX_LOG (4e6 Zeichen): viele Warnungen, ein paar Fehler.
  const lines = [];
  for (let i = 0, len = 0; len < 3.9e6; i++) {
    const l = i % 500 === 0 ? `./kap/k${i % 7}.tex:${i}: Undefined control sequence.\nl.${i} \\foo` : `LaTeX Warning: Reference \`sec:${i}' on page ${i % 120} undefined on input line ${i}.`;
    lines.push(l);
    len += l.length + 1;
  }
  const log = "Run number 1 of rule 'pdflatex'\n" + lines.join('\n');
  const t = [];
  let r;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    r = parseLog(log, TMP);
    t.push(performance.now() - t0);
  }
  return { chars: log.length, ms: median(t), errors: r.errors.length, warnings: r.warnings.length };
}

function benchDetect() {
  const dir = path.join(TMP, 'detect');
  fs.mkdirSync(dir);
  const filler = '\\section{Abschnitt}\nText mit $x^2$ und \\textbf{fett}. % Kommentar\n'.repeat(Math.ceil(1048576 / 60));
  fs.writeFileSync(path.join(dir, 'main.tex'), `\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\n${filler}\\end{document}\n`);
  const t = [];
  let r;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    r = detectProjectEngine(dir, 'main.tex', 'pdflatex');
    t.push(performance.now() - t0);
  }
  return { bytes: fs.statSync(path.join(dir, 'main.tex')).size, ms: median(t), max: Math.max(...t), engine: r.engine };
}

// --- Ablauf ----------------------------------------------------------------------------------

(async () => {
  const report = { host: os.hostname(), platform: `${process.platform}/${os.arch()}`, cpus: `${os.cpus().length}× ${os.cpus()[0].model.trim()}`, ramGB: (os.totalmem() / 2 ** 30).toFixed(0), node: process.version, n: N, backend: TECTONIC ? 'tectonic' : 'latexmk', docs: [] };
  try {
    report.tex = cp.execFileSync(TECTONIC ? 'tectonic' : 'pdflatex', ['--version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0];
  } catch {
    report.tex = '?';
  }
  process.stderr.write(`Wegwerf-Ordner: ${TMP}\n`);
  try {
    if (DOCS.includes('T3')) await makeFigPdf();
    for (const doc of DOCS) for (const e of ENGINES) {
      try {
        const r = await benchDoc(doc, e);
        if (r) report.docs.push(r);
      } catch (err) {
        process.stderr.write(`  ${doc} ${e}: FEHLER ${err.message.slice(0, 2000)}\n`);
        report.docs.push({ doc, engine: e, error: err.message.split('\n')[0] });
      }
    }
    if (!flag('skip-load') && !TECTONIC) {
      report.load = {};
      for (const p of [2, 5, 10]) {
        process.stderr.write(`  Last: ${p} gleichzeitig\n`);
        report.load[p] = await benchLoad(p);
      }
    }
    report.parseLog = benchParseLog();
    report.detect = benchDetect();
  } finally {
    if (!flag('keep')) fs.rmSync(TMP, { recursive: true, force: true });
  }

  const o = [];
  o.push(`**${report.host}** · ${report.platform} · ${report.cpus} · ${report.ramGB} GB RAM · Node ${report.node} · ${report.tex} · N=${N}`, '');
  o.push('| Dok | Engine | Seiten | kalt [s] | warm [s] | Läufe kalt/warm | Spitzen-RAM TeX [MB] | Ausgabeordner [MB] |', '|---|---|---|---|---|---|---|---|');
  for (const r of report.docs) {
    if (r.error) { o.push(`| ${r.doc} | ${r.engine} | Fehler: ${r.error} |||||| `); continue; }
    o.push(`| ${r.doc} | ${r.engine}${r.auto ? ` → ${r.auto}` : ''} | ${r.pages ?? '?'} | ${stat(r.cold)} | ${stat(r.warm)} | ${median(r.runsCold)}/${median(r.runsWarm)} | ${mb(r.peak)} | ${mb(r.outMB)} |`);
  }
  const g = report.docs.filter((r) => r.noop && r.noop.length);
  if (g.length) {
    o.push('', 'Erneut kompilieren ohne Änderung (T2): mit `-g` (Standard) vs. ohne', '', '| Engine | mit -g [s] | ohne -g [s] |', '|---|---|---|');
    for (const r of g) o.push(`| ${r.engine} | ${stat(r.noop)} | ${stat(r.noopNoG)} |`);
  }
  if (report.load) {
    o.push('', 'Gleichzeitige Compiles (T2, pdflatex, kalt): Zeit bis zum eigenen PDF', '', '| gleichzeitig | Queue (wie Server): Median / max [s] | CPU | parallel: Median / max [s] | CPU |', '|---|---|---|---|---|');
    for (const [p, l] of Object.entries(report.load)) o.push(`| ${p} | ${sec(median(l.queue.waits))} / ${sec(Math.max(...l.queue.waits))} | ${l.queue.cpu.toFixed(0)} % | ${sec(median(l.parallel.waits))} / ${sec(Math.max(...l.parallel.waits))} | ${l.parallel.cpu.toFixed(0)} % |`);
  }
  o.push('', `parseLog: ${(report.parseLog.chars / 1e6).toFixed(1)} M Zeichen → ${report.parseLog.ms.toFixed(0)} ms (${report.parseLog.errors} Fehler, ${report.parseLog.warnings} Warnungen)`);
  o.push(`detectEngine: ${(report.detect.bytes / 1048576).toFixed(2)} MB → Median ${report.detect.ms.toFixed(1)} ms, max ${report.detect.max.toFixed(1)} ms (erkannt: ${report.detect.engine})`);
  console.log(o.join('\n'));
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
