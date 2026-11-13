// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectEngine, detectProjectEngine } = require('../server/lib/detectEngine');

// files: project files the main file may pull in ({ 'praeambel.tex': '…' }).
const reader = (files) => files && ((name) => (Object.hasOwn(files, name) ? files[name] : null));
const eng = (src, sel, files) => detectEngine(src, sel, reader(files)).engine;
const why = (src, sel, files) => detectEngine(src, sel, reader(files)).reason;

test('detectEngine', () => {
  assert.strictEqual(eng('% !TEX program = xelatex\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('%!TEX TS-program = pdflatex\n\\directlua{}', 'lualatex'), 'pdflatex');
  assert.strictEqual(eng('\\usepackage[ngerman]{babel}\n\\usepackage{amsmath}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\usepackage{amsmath,fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\usepackage{fontspec}', 'xelatex'), 'xelatex'); // working choice stays
  assert.strictEqual(eng('\\usepackage[german, bidi=basic, provide=*]{babel}', 'xelatex'), 'lualatex');
  assert.strictEqual(eng('\\babelprovide[import, onchar=ids fonts]{german}', 'pdflatex'), 'lualatex');
  assert.strictEqual(eng('\\usepackage{xeCJK}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('% \\usepackage{fontspec}\n50\\% Rabatt', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('', undefined), 'pdflatex');
});

// #122: Grenzfälle, je Punkt aus dem Issue mindestens eine Zeile.

test('#122 Vorspann in eigener Datei: \\input/\\include/\\subfile der Hauptdatei, eine Ebene', () => {
  const pre = { 'praeambel.tex': '\\usepackage{fontspec}\n' };
  assert.strictEqual(eng('\\documentclass{article}\n\\input{praeambel}\n\\begin{document}x\\end{document}', 'pdflatex', pre), 'xelatex');
  assert.strictEqual(why('\\input{praeambel}', 'pdflatex', pre), 'fontspec in praeambel.tex'); // steht so im Log
  assert.strictEqual(eng('\\input{praeambel.tex}', 'pdflatex', pre), 'xelatex');
  assert.strictEqual(eng('\\input praeambel\n', 'pdflatex', pre), 'xelatex'); // TeX-Syntax ohne Klammern
  assert.strictEqual(eng('\\input{"praeambel"}', 'pdflatex', pre), 'xelatex');
  assert.strictEqual(eng('\\include{kapitel1}', 'pdflatex', { 'kapitel1.tex': '\\directlua{tex.print("x")}' }), 'lualatex');
  assert.strictEqual(eng('\\subfile{teile/einleitung}', 'pdflatex', { 'teile/einleitung.tex': '\\setmainfont{TeX Gyre Pagella}' }), 'xelatex');
  assert.strictEqual(eng('\\import{teile/}{vorspann}', 'pdflatex', { 'teile/vorspann.tex': '\\usepackage{fontspec}' }), 'xelatex');
  // Nur eine Ebene: was die eingebundene Datei selbst einbindet, wird nicht gelesen.
  assert.strictEqual(eng('\\input{a}', 'pdflatex', { 'a.tex': '\\input{b}', 'b.tex': '\\usepackage{fontspec}' }), 'pdflatex');
  // Kein Leser (alter Aufruf), fehlende Datei, \input im toten Zweig, \includegraphics: nichts umschalten.
  assert.strictEqual(eng('\\input{praeambel}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\input{fehlt}', 'pdflatex', pre), 'pdflatex');
  assert.strictEqual(eng('\\iffalse\n\\input{praeambel}\n\\fi', 'pdflatex', pre), 'pdflatex');
  assert.strictEqual(eng('\\includegraphics{praeambel}\\inputencoding{praeambel}', 'pdflatex', pre), 'pdflatex');
  // Ein Magic Comment in der eingebundenen Datei zählt nicht (nur die Hauptdatei).
  assert.strictEqual(eng('\\input{praeambel}', 'pdflatex', { 'praeambel.tex': '% !TEX program = lualatex\n' }), 'pdflatex');
  // Höchstens 32 Dateien neben der Hauptdatei.
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}.tex`, i === 39 ? '\\usepackage{fontspec}' : 'Text']));
  const inputs = Object.keys(many).map((f) => `\\input{${f}}`).join('\n');
  assert.strictEqual(eng(inputs, 'pdflatex', many), 'pdflatex');
  many['k5.tex'] = '\\usepackage{fontspec}';
  assert.strictEqual(eng(inputs, 'pdflatex', many), 'xelatex');
});

test('#122 eigene .cls/.sty im Projekt, die fontspec laden', () => {
  const cls = { 'hsthesis.cls': '\\NeedsTeXFormat{LaTeX2e}\n\\LoadClass{scrreprt}\n\\RequirePackage{fontspec}\n\\setmainfont{Arial}\n' };
  assert.strictEqual(eng('\\documentclass[12pt]{hsthesis}', 'pdflatex', cls), 'xelatex');
  assert.strictEqual(why('\\documentclass[12pt]{hsthesis}', 'pdflatex', cls), 'fontspec in hsthesis.cls');
  assert.strictEqual(eng('\\usepackage{meinstil}', 'pdflatex', { 'meinstil.sty': '\\RequirePackage[no-math]{fontspec}' }), 'xelatex');
  assert.strictEqual(eng('\\usepackage{styles/meinstil}', 'pdflatex', { 'styles/meinstil.sty': '\\RequirePackage{unicode-math}' }), 'xelatex');
  assert.strictEqual(eng('\\documentclass{hsthesis}', 'pdflatex', { 'hsthesis.cls': '\\LoadClass{ctexart}' }), 'xelatex');
  assert.strictEqual(eng('\\documentclass{hsthesis}', 'pdflatex', { 'hsthesis.cls': '\\LoadClass{article}\\RequirePackage[T1]{fontenc}' }), 'pdflatex');
  // fontspec nur im \iffalse-Teil der Klasse
  assert.strictEqual(eng('\\documentclass{hsthesis}', 'pdflatex', { 'hsthesis.cls': '\\iffalse\\RequirePackage{fontspec}\\fi' }), 'pdflatex');
  // Eine Ebene: das Paket, das die Klasse lädt, wird nicht mehr gelesen.
  assert.strictEqual(eng('\\documentclass{hsthesis}', 'pdflatex', { 'hsthesis.cls': '\\RequirePackage{hsfonts}', 'hsfonts.sty': '\\RequirePackage{fontspec}' }), 'pdflatex');
});

test('#122 Klassen, die eine Engine erzwingen (ctex, LuaTeX-ja, jlreq)', () => {
  assert.strictEqual(eng('\\documentclass[UTF8]{ctexart}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\documentclass{ctexbook}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\documentclass{ctexart}', 'xelatex'), 'xelatex');
  assert.strictEqual(eng('\\documentclass{ctexart}', 'lualatex'), 'lualatex'); // ctex läuft mit beiden
  assert.strictEqual(eng('\\documentclass{article}\\usepackage{ctex}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\documentclass{ltjsarticle}', 'pdflatex'), 'lualatex');
  assert.strictEqual(eng('\\documentclass{ltjsarticle}', 'xelatex'), 'lualatex');
  assert.strictEqual(eng('\\documentclass{ltjarticle}', 'pdflatex'), 'lualatex');
  assert.strictEqual(eng('\\documentclass[paper=a4]{jlreq}', 'pdflatex'), 'lualatex');
  assert.strictEqual(eng('\\usepackage{luatexja-preset}', 'pdflatex'), 'lualatex');
  assert.strictEqual(eng('\\usepackage{mathspec}', 'lualatex'), 'xelatex'); // mathspec gibt es nur für XeTeX
  // Installierte Hochschul-Klassen (nicht im Projekt) sieht die Erkennung nicht: Einstellung bleibt.
  assert.strictEqual(eng('\\documentclass{tudscrartcl}', 'pdflatex', {}), 'pdflatex');
});

test('#122 fontspec nur in verbatim/lstlisting/\\iffalse … \\fi schaltet nicht um', () => {
  const after = '\n\\usepackage{amsmath}';
  assert.strictEqual(eng(`\\begin{verbatim}\n\\usepackage{fontspec}\n\\end{verbatim}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng(`\\begin{verbatim*}\n\\usepackage{fontspec}\n\\end{verbatim*}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng(`\\begin{Verbatim}[frame=single]\n\\usepackage{fontspec}\n\\end{Verbatim}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng(`\\begin{lstlisting}[language={[LaTeX]TeX}]\n\\usepackage{fontspec}\n\\end{lstlisting}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng(`\\begin{minted}{latex}\n\\setmainfont{Arial}\n\\end{minted}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng(`\\begin{comment}\n\\usepackage{fontspec}\n\\end{comment}${after}`, 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\verb|\\usepackage{fontspec}| und \\verb*!\\directlua{}!', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\lstinline[language=TeX]{\\usepackage{fontspec}} \\lstinline|\\usepackage{xeCJK}|', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\mintinline{latex}{\\usepackage{fontspec}}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\iffalse\n\\usepackage{fontspec}\n\\fi', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\iffalse\n\\ifx\\a\\b \\usepackage{fontspec}\\fi\n\\usepackage{fontspec}\n\\fi', 'pdflatex'), 'pdflatex'); // verschachtelt
  assert.strictEqual(eng('\\iffalse\n\\iftoggle{a}{x}{y}\n\\ifthenelse{1=1}{x}{y}\n\\fi\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex'); // keine echten \if
  assert.strictEqual(eng('\\newif\\ifentwurf\n\\let\\ifalt\\iftrue\n\\iffalse\n\\fi\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\iffalse\n\\usepackage{amsmath}\n\\else\n\\usepackage{fontspec}\n\\fi', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\iftrue\n\\usepackage{amsmath}\n\\else\n\\usepackage{fontspec}\n\\fi', 'pdflatex'), 'pdflatex');
  // Was danach kommt, zählt wieder; % im verbatim ist kein Kommentar.
  assert.strictEqual(eng('\\begin{verbatim}\n50% \\end{verbatim}\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\iffalse x \\fi\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  // Auskommentiertes \begin{verbatim} versteckt nichts; \\% ist ein Kommentar, \% nicht.
  assert.strictEqual(eng('% \\begin{verbatim}\n\\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('Zeile\\\\% \\usepackage{fontspec}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('50\\% \\usepackage{fontspec}', 'pdflatex'), 'xelatex');
  // babel-Option nur im Fließtext/Code-Beispiel ist keine Option
  assert.strictEqual(eng('\\usepackage{babel}\nMit \\texttt{bidi=basic} oder \\texttt{onchar=ids}.', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\ifx\\directlua\\undefined Kein LuaTeX.\\fi', 'pdflatex'), 'pdflatex');
});

test('#122 \\usepackage über mehrere Zeilen, ] in geschweiften Klammern, \\RequirePackage', () => {
  assert.strictEqual(eng('\\usepackage[\n  ngerman,\n]{%\n  amsmath, % Mathe\n  fontspec\n}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\usepackage\n  [Scale=MatchLowercase]\n  {fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\usepackage[Path={./fonts/[alt]/}]{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\usepackage[ngerman, foo={a]b}, bidi=basic]{babel}', 'xelatex'), 'lualatex');
  assert.strictEqual(eng('\\RequirePackage{fontspec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\RequirePackage[no-math]{fontspec}[2020/02/01]', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\usepackage{FontSpec}', 'pdflatex'), 'xelatex');
  assert.strictEqual(why('\\usepackage{xeCJK}', 'pdflatex'), 'xeCJK');
});

test('#122 Magic Comment: Position, Groß-/Kleinschreibung, ungültiger Wert', () => {
  const lua = (head) => eng(`${head}\n\\usepackage{fontspec}`, 'pdflatex');
  assert.strictEqual(lua('% Arbeit von X\n%\n% !TEX program = lualatex'), 'lualatex'); // nicht erste Zeile
  assert.strictEqual(lua('\\documentclass{article}\n  % !TEX program = lualatex'), 'lualatex'); // nach \documentclass
  assert.strictEqual(lua('% !tex ts-program = LuaLaTeX'), 'lualatex');
  assert.strictEqual(lua('%!TeX Program=XELATEX'), 'xelatex');
  assert.strictEqual(lua('% !TEX TS-program = lualatexmk'), 'lualatex'); // TeXShop-Engine
  assert.strictEqual(lua('% !TEX program = lualatex\n% !TEX program = pdflatex'), 'lualatex'); // der erste gilt
  // Ungültiger Wert: ignoriert, Erkennung läuft weiter, Hinweis fürs Log.
  const ctx = detectEngine('% !TEX program = context\n\\usepackage{fontspec}', 'pdflatex');
  assert.deepStrictEqual([ctx.engine, ctx.reason], ['xelatex', 'fontspec']);
  assert.match(ctx.warning, /context.*ignoriert/);
  assert.strictEqual(eng('% !TEX program = platex\n\\documentclass{article}', 'lualatex'), 'lualatex');
  assert.strictEqual(detectEngine('% !TEX program = xelatex', 'pdflatex').warning, null);
  // Zählt nicht: nach \begin{document}, hinter Code, in verbatim, als TEX root/spellcheck.
  assert.strictEqual(eng('\\begin{document}\n% !TEX program = lualatex\n\\end{document}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\documentclass{article} % !TEX program = lualatex', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\begin{verbatim}\n% !TEX program = lualatex\n\\end{verbatim}', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('% !TEX root = main.tex\n% !TEX spellcheck = de_DE', 'xelatex'), 'xelatex');
});

test('#122 iftex-Weichen: nur der Zweig des eingestellten Compilers zählt', () => {
  const weiche = '\\usepackage{iftex}\n\\ifPDFTeX\n  \\usepackage[T1]{fontenc}\n\\else\n  \\usepackage{fontspec}\n\\fi\n';
  assert.strictEqual(eng(weiche, 'pdflatex'), 'pdflatex'); // läuft mit pdflatex, bleibt
  assert.strictEqual(eng(weiche, 'xelatex'), 'xelatex');
  assert.strictEqual(eng(weiche, 'lualatex'), 'lualatex');
  assert.strictEqual(eng('\\iftutex\\usepackage{fontspec}\\else\\usepackage[T1]{fontenc}\\fi', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\ifxetex\\usepackage{fontspec}\\fi\n\\ifluatex\\usepackage{luacode}\\fi', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\unless\\ifPDFTeX\\usepackage{fontspec}\\fi', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\ifdefined\\directlua\\directlua{tex.print("x")}\\fi', 'pdflatex'), 'pdflatex');
  assert.strictEqual(eng('\\ifx\\directlua\\undefined\\else\\directlua{tex.print("x")}\\fi', 'xelatex'), 'xelatex');
  assert.strictEqual(eng('\\ifcsname XeTeXrevision\\endcsname\\usepackage{xeCJK}\\fi', 'pdflatex'), 'pdflatex');
  // Der Zweig des eingestellten Compilers braucht etwas anderes -> umschalten.
  assert.strictEqual(eng('\\ifPDFTeX\\usepackage{fontspec}\\fi', 'pdflatex'), 'xelatex');
  assert.strictEqual(eng('\\ifPDFTeX\\usepackage[T1]{fontenc}\\else\\usepackage{xeCJK}\\fi', 'lualatex'), 'xelatex');
  assert.strictEqual(eng('\\ifx\\directlua\\undefined\\usepackage{fontspec}\\fi', 'pdflatex'), 'xelatex');
  // Unbekannte Bedingung: beide Zweige zählen (wie bisher).
  assert.strictEqual(eng('\\newif\\ifentwurf\n\\ifentwurf\\else\\usepackage{fontspec}\\fi', 'pdflatex'), 'xelatex');
});

test('#122 Projekteinstellung xelatex + bidi=basic -> lualatex (scheitert, solange #119 offen ist)', () => {
  assert.strictEqual(eng('\\usepackage[bidi=basic]{babel}', 'xelatex'), 'lualatex');
  assert.strictEqual(eng('\\PassOptionsToPackage{bidi=basic-r}{babel}\n\\usepackage[arabic]{babel}', 'xelatex'), 'lualatex');
  assert.strictEqual(why('\\usepackage[bidi=basic]{babel}', 'xelatex'), 'babel bidi=basic');
  assert.strictEqual(eng('\\usepackage[bidi=bidi-r]{babel}', 'xelatex'), 'xelatex'); // XeTeX-Variante bleibt
});

test('#122 detectProjectEngine: liest nur Dateien im Projekt, wie TeX sie findet', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-engine-'));
  test.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'projekt');
  fs.mkdirSync(path.join(root, 'thesis'), { recursive: true });
  const write = (rel, text) => fs.writeFileSync(path.join(outer, rel), text);
  const main = (text) => write('projekt/thesis/main.tex', text);
  const run = () => detectProjectEngine(root, 'thesis/main.tex', 'pdflatex');

  // Ordner der Hauptdatei zuerst, dann die Projektwurzel.
  main('\\input{praeambel}');
  write('projekt/praeambel.tex', '\\usepackage{fontspec}');
  assert.deepStrictEqual([run().engine, run().reason], ['xelatex', 'fontspec in praeambel.tex']);
  write('projekt/thesis/praeambel.tex', '\\usepackage{amsmath}');
  assert.strictEqual(run().engine, 'pdflatex');
  // ../ und absolute Pfade aus dem Projekt heraus werden nicht gelesen.
  write('geheim.tex', '\\usepackage{fontspec}');
  main('\\input{../../geheim}');
  assert.strictEqual(run().engine, 'pdflatex');
  main(`\\input{${path.join(outer, 'geheim.tex').split(path.sep).join('/')}}`);
  assert.strictEqual(run().engine, 'pdflatex');
  // Große Dateien nur bis 1 MiB.
  write('projekt/gross.tex', `${'%'.repeat(1024 * 1024)}\n\\usepackage{fontspec}`);
  main('\\input{gross}');
  assert.strictEqual(run().engine, 'pdflatex');
  write('projekt/gross.tex', `\\usepackage{fontspec}\n${'%'.repeat(1024 * 1024)}`);
  assert.strictEqual(run().engine, 'xelatex');
  // Fehlende Hauptdatei oder fehlendes Projekt: Einstellung bleibt.
  assert.strictEqual(detectProjectEngine(root, 'fehlt.tex', 'xelatex').engine, 'xelatex');
  assert.strictEqual(detectProjectEngine(path.join(outer, 'fehlt'), 'main.tex', 'pdflatex').engine, 'pdflatex');

  if (process.platform !== 'win32') {
    // Symlink aus dem Projekt heraus: nicht lesen. FIFO: nicht lesen (würde den Server blockieren).
    fs.symlinkSync(path.join(outer, 'geheim.tex'), path.join(root, 'link.tex'));
    main('\\input{link}');
    assert.strictEqual(run().engine, 'pdflatex');
    assert.strictEqual(spawnSync('mkfifo', [path.join(root, 'pipe.tex')]).status, 0);
    main('\\input{pipe}');
    assert.strictEqual(run().engine, 'pdflatex');
  }
});

// Ende-zu-Ende mit TeX: compile() schaltet anhand der eingebundenen Präambel um.
const hasTex = spawnSync('latexmk', ['-v'], { windowsHide: true }).status === 0;

test('#122 Kompilieren: Präambel per \\input -> xelatex, iftex-Weiche bleibt bei pdflatex', { skip: !hasTex && 'latexmk fehlt', timeout: 240000 }, async () => {
  const { compile } = require('../server/lib/compile');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-engine-tex-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = '\\begin{document}\nHallo\n\\end{document}\n';

  fs.writeFileSync(path.join(root, 'praeambel.tex'), '\\usepackage{fontspec}\n');
  fs.writeFileSync(path.join(root, 'main.tex'), `% !TEX program = context\n\\documentclass{article}\n\\input{praeambel}\n${body}`);
  let r = await compile(root, 'main.tex', { compiler: 'pdflatex' }, '.latex-ide-out', 120000);
  const lines = r.log.split('\n');
  assert.strictEqual(lines[0], '[LaTeX-IDE] Compiler automatisch: xelatex (erkannt: fontspec in praeambel.tex)');
  assert.match(lines[1], /^\[LaTeX-IDE\] "% !TEX program = context" wird ignoriert/);
  assert.ok(r.pdfPath && /xdvipdfmx|XeTeX/i.test(r.log), r.log.slice(-2000));

  fs.writeFileSync(path.join(root, 'weiche.tex'), `\\documentclass{article}\n\\usepackage{iftex}\n\\ifPDFTeX\n\\usepackage[utf8]{inputenc}\n\\else\n\\usepackage{fontspec}\n\\fi\n${body}`);
  r = await compile(root, 'weiche.tex', { compiler: 'pdflatex' }, '.latex-ide-out', 120000);
  assert.ok(!r.log.startsWith('[LaTeX-IDE]'), r.log.slice(0, 300));
  assert.ok(r.success && /pdfTeX/.test(r.log), r.log.slice(-2000));
});
