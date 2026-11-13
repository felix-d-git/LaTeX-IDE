// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Picks the TeX engine a document needs, so a fontspec/LuaTeX preamble does not
// fail just because the project still says pdflatex. Order:
// 1. "% !TEX program = …" magic comment always wins (explicit per-document choice).
//    It counts as an own-line comment anywhere in the main file's preamble (before
//    \begin{document}), in any letter case. An unsupported value (context, platex …)
//    is ignored with a warning in the log, detection goes on.
// 2. LuaTeX-only features (\directlua, luacode, babel bidi=basic / onchar=, LuaTeX-ja
//    and jlreq) -> lualatex.
// 3. XeTeX-only packages (xeCJK, mathspec, bidi …) -> xelatex.
// 4. Unicode-font packages and classes (fontspec, unicode-math, polyglossia, ctex,
//    \setmainfont & Co.) with pdflatex selected -> xelatex (pdflatex would abort anyway;
//    xelatex, not lualatex, because luaotfload fails under the openin_any=p sandbox in compile.js).
// Otherwise the project setting stays. A choice that would work is never overridden.
//
// What counts: comments, verbatim-like environments (verbatim, lstlisting, minted,
// comment …) and \verb/\lstinline are dropped. \iffalse/\iftrue and the iftex switches
// (\ifPDFTeX, \ifXeTeX, \ifLuaTeX, \iftutex, \ifxetex, \ifpdf, \ifdefined\directlua …)
// are evaluated for the selected engine: only the branch that engine takes counts, so
// a document written for every engine keeps its setting. Other conditionals count
// with both branches.
// ponytail: scans only the main file; a preamble moved into \input{praeambel} is not
// seen - follow \input there if that turns out to matter.
const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];
// Bounds, so a huge or hostile document cannot stall the server (detection runs in its event loop).
const MAX_COMMANDS = 1000; // \usepackage/\input/… looked at per file
const MAX_ARG = 2048; // characters of one […] or {…} argument

const LUA_PACKAGES = ['luacode', 'luaotfload', 'luacolor', 'lua-ul', 'luatexja', 'luamplib', 'lua-visual-debug'];
const XE_PACKAGES = ['xecjk', 'xeindex', 'xltxtra', 'mathspec', 'bidi', 'xepersian', 'xunicode'];
const UNICODE_PACKAGES = ['fontspec', 'unicode-math', 'polyglossia', 'ctex'];
// LuaTeX-ja classes (ltjsarticle, ltjarticle, ltjsbook …) and jlreq: of the three engines only LuaTeX.
const isLuaPackage = (p) => LUA_PACKAGES.includes(p) || p.startsWith('luatexja');
const isLuaClass = (c) => c.startsWith('ltj') || c === 'jlreq';
const UNICODE_CLASSES = ['ctexart', 'ctexrep', 'ctexbook', 'ctexbeamer'];
const FONT_COMMAND = /\\(babelfont|setmainfont|setsansfont|setmonofont|setmathfont|newfontfamily)(?![A-Za-z@])/;
const LUA_CODE = /\\(?:directlua|latelua)\s*(?:\d+\s*)?\{|\\begin\s*\{luacode\*?\}/;

// Balanced […] or {…} starting at src[i]: { body, end } or null. A ] inside {} does not close […].
function group(src, i, close) {
  let depth = 0;
  for (let j = i + 1; j < Math.min(src.length, i + MAX_ARG); j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === close && depth === 0) return { body: src.slice(i + 1, j), end: j + 1 };
    else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return null;
  }
  return null;
}

// Next […] or {…} argument after optional whitespace (newlines included).
function arg(src, i, open) {
  while (/\s/.test(src[i] || '')) i++;
  return src[i] === open ? group(src, i, open === '[' ? ']' : '}') : null;
}

const VERBATIM_ENVS = 'verbatim|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|comment|tcblisting|luacode';
const SCAN = new RegExp(String.raw`\\\\|\\%|%[^\n]*|\\begin\s*\{(${VERBATIM_ENVS})(\*?)\}|\\(?:verb|Verb|lstinline|mintinline)(?![A-Za-z@])\*?|\\begin\s*\{document\}`, 'g');

// \verb|…|, \Verb[…]|…|, \lstinline[…]{…} or |…|, \mintinline[…]{lang}{…}: index after the
// argument. Inline verbatim ends with the line at the latest.
function skipInline(text, i, tok) {
  const win = text.slice(i, i + 256);
  const nl = win.indexOf('\n');
  const line = nl < 0 ? win : win.slice(0, nl);
  let k = 0;
  if (!tok.startsWith('\\verb') && line[k] === '[') k = group(line, k, ']')?.end ?? k;
  if (tok === '\\mintinline' && line[k] === '{') k = group(line, k, '}')?.end ?? k;
  const close = !tok.startsWith('\\verb') && line[k] === '{' ? '}' : line[k];
  if (!close) return i + k;
  const j = line.indexOf(close, k + 1);
  return i + (j < 0 ? line.length : j + 1);
}

// One pass over the raw text: drops % comments, verbatim-like environments and inline
// verbatim (a % inside verbatim is no comment, a commented-out \begin{verbatim} starts
// nothing). Own-line comments before \begin{document} are kept as magic comment candidates.
function strip(text) {
  const re = new RegExp(SCAN.source, 'g');
  const magic = [];
  let out = '';
  let last = 0;
  let body = false;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok === '\\\\' || tok === '\\%') continue; // escaped: plain text
    out += text.slice(last, m.index);
    let end = re.lastIndex;
    if (tok[0] === '%') {
      const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
      if (!body && !text.slice(lineStart, m.index).trim()) magic.push(tok);
    } else if (m[1]) {
      const close = new RegExp(String.raw`\\end\s*\{${m[1]}${m[2] ? '\\*' : ''}\}`, 'g');
      close.lastIndex = end;
      const c = close.exec(text);
      end = c ? close.lastIndex : text.length;
      if (m[1] === 'luacode') out += '\\begin{luacode}'; // the environment itself needs LuaTeX
    } else if (tok.startsWith('\\begin')) {
      body = true;
      out += tok;
    } else {
      end = skipInline(text, end, tok);
    }
    last = re.lastIndex = end;
  }
  return { text: out + text.slice(last), magic };
}

// Conditionals whose branch is known for a given engine (iftex, ifxetex, ifluatex, ifpdf).
const pdf = (e) => e === 'pdflatex';
const xe = (e) => e === 'xelatex';
const lua = (e) => e === 'lualatex';
const KNOWN_IFS = {
  iffalse: () => false,
  iftrue: () => true,
  ifPDFTeX: pdf,
  ifpdftex: pdf,
  ifXeTeX: xe,
  ifxetex: xe,
  ifLuaTeX: lua,
  ifluatex: lua,
  ifLuaHBTeX: lua,
  ifluahbtex: lua,
  ifTUTeX: (e) => !pdf(e),
  iftutex: (e) => !pdf(e),
  ifpdf: (e) => !xe(e), // PDF output mode: pdfTeX and LuaTeX, XeTeX writes xdv
};
// Engine primitives behind \ifdefined\X, \ifx\X\undefined and \ifcsname X\endcsname.
const PRIMITIVES = { directlua: 'lualatex', luatexversion: 'lualatex', XeTeXrevision: 'xelatex', XeTeXversion: 'xelatex' };
const PRIM = Object.keys(PRIMITIVES).join('|');
const PRIMITIVE_TESTS = {
  ifdefined: [new RegExp(String.raw`^\s*\\(${PRIM})(?![A-Za-z@])`), true],
  ifx: [new RegExp(String.raw`^\s*\\(${PRIM})\s*\\@?undefined(?![A-Za-z@])`), false],
  ifcsname: [new RegExp(String.raw`^\s*(${PRIM})\s*\\endcsname`), true],
};
// Macros named \if… that are no TeX conditionals (etoolbox, ifthen): no matching \fi.
const NOT_CONDITIONAL = /^if(?:thenelse|toggle|bool(?:expr|expe)?|(?:cs)?(?:un)?def(?!ined$)[a-z]*|cs(?:macro|param|prefix|protected|empty|void|equal|string|strequal|counter|length|dimen)|blank|str[a-z]+|num[a-z]+|dim[a-z]+|inlist(?:cs)?|rmnum|ltxcounter|patchable)$/;
// \newif\ifdraft, \let\ifA\iftrue, \def\ifB …: the \if… there is a name, not a conditional.
const DEFINED_IFS = [
  /(\\let\s*\\[A-Za-z@]+\s*=?\s*)\\(?=if)/g,
  /(\\(?:newif|let|[gex]?def|(?:re)?newcommand\*?|providecommand\*?|DeclareRobustCommand\*?)\s*\{?\s*)\\(?=if)/g,
];

// Drops the branches the given engine does not take. Unknown conditionals keep both.
function evalConditionals(src, engine) {
  for (const re of DEFINED_IFS) src = src.replace(re, '$1\\_');
  const re = /\\(unless\s*\\)?(if[A-Za-z@]*)|\\(else|fi)(?![A-Za-z@])/g;
  const stack = []; // { parent: live outside, truth: true | false | null (unknown), inElse }
  const live = () => {
    const f = stack[stack.length - 1];
    return !f || (f.parent && (f.truth === null || f.truth !== f.inElse));
  };
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const [, unless, name, word] = m;
    let end = re.lastIndex;
    let truth = null;
    if (name) {
      const rest = src.slice(end, end + 100);
      if (KNOWN_IFS[name]) truth = KNOWN_IFS[name](engine);
      else if (NOT_CONDITIONAL.test(name) || (!['if', 'ifx', 'ifcat'].includes(name) && /^\s*\{/.test(rest))) continue;
      else if (PRIMITIVE_TESTS[name]) {
        const [test, whenDefined] = PRIMITIVE_TESTS[name];
        const t = test.exec(rest);
        if (t) {
          truth = (PRIMITIVES[t[1]] === engine) === whenDefined;
          end += t[0].length;
        }
      }
      if (truth !== null && unless) truth = !truth;
    }
    if (live()) out += src.slice(last, m.index) + ' ';
    if (word === 'else') {
      if (stack.length) stack[stack.length - 1].inElse = true;
    } else if (word === 'fi') {
      stack.pop();
    } else {
      stack.push({ parent: live(), truth, inElse: false });
    }
    last = re.lastIndex = end;
  }
  if (live()) out += src.slice(last);
  return out;
}

const CMD = /\\(usepackage|RequirePackage(?:WithOptions)?|documentclass|LoadClass(?:WithOptions)?|PassOptionsToPackage|babelprovide)(?![A-Za-z@])/g;
const names = (list) => list.split(',').map((s) => s.trim()).filter(Boolean);

// Packages, classes and babel options of one (stripped) file.
function analyse(src) {
  const info = { packages: [], classes: [], babelOpts: [], provideOpts: [] };
  let count = 0;
  for (const m of src.matchAll(CMD)) {
    if (++count > MAX_COMMANDS) break;
    const cmd = m[1];
    const at = m.index + m[0].length;
    const opt = arg(src, at, '[');
    const a = arg(src, opt ? opt.end : at, '{');
    if (!a) continue;
    if (/^(?:usepackage|RequirePackage)/.test(cmd)) {
      const list = names(a.body);
      info.packages.push(...list);
      if (opt && list.some((p) => p.toLowerCase() === 'babel')) info.babelOpts.push(opt.body);
    } else if (/^(?:documentclass|LoadClass)/.test(cmd)) {
      info.classes.push(a.body.trim());
    } else if (cmd === 'PassOptionsToPackage') {
      const to = arg(src, a.end, '{');
      if (to && names(to.body).some((p) => p.toLowerCase() === 'babel')) info.babelOpts.push(a.body);
    } else if (opt) {
      info.provideOpts.push(opt.body); // \babelprovide
    }
  }
  const font = FONT_COMMAND.exec(src);
  info.luaCode = LUA_CODE.test(src);
  info.fontCommand = font && `\\${font[1]}`;
  return info;
}

// What a file asks for: { lua, xe, uni } reasons (or falsy).
function needs(info) {
  const pkg = (is) => info.packages.find((p) => is(p.toLowerCase()));
  const cls = (is) => info.classes.find((c) => is(c.toLowerCase()));
  return {
    lua: (info.luaCode && 'Lua-Code')
      || (info.babelOpts.some((o) => /\bbidi\s*=\s*basic/.test(o)) && 'babel bidi=basic')
      || (info.provideOpts.some((o) => /\bonchar\s*=/.test(o)) && 'babel onchar=')
      || pkg(isLuaPackage) || cls(isLuaClass),
    xe: pkg((p) => XE_PACKAGES.includes(p)),
    uni: pkg((p) => UNICODE_PACKAGES.includes(p)) || cls((c) => UNICODE_CLASSES.includes(c)) || info.fontCommand,
  };
}

function detectEngine(source, selected) {
  const sel = ENGINES.includes(selected) ? selected : 'pdflatex';
  const result = (engine, reason, warning = null) => ({ engine, reason, warning, changed: engine !== sel });
  const main = strip(String(source || ''));

  // The first "program" magic comment decides; an unsupported value is ignored.
  let warning = null;
  for (const c of main.magic) {
    const mc = /^%[ \t]*!TEX[ \t]+(?:TS-)?program[ \t]*=[ \t]*(\S*)/i.exec(c);
    if (!mc) continue;
    const v = /^(pdflatex|xelatex|lualatex)(?:mk)?$/i.exec(mc[1]); // TeXShop: pdflatexmk …
    if (v) return result(v[1].toLowerCase(), '% !TEX program');
    warning = `"% !TEX program = ${mc[1]}" wird ignoriert: unterstützt sind pdflatex, xelatex und lualatex.`;
    break;
  }

  const found = needs(analyse(evalConditionals(main.text, sel)));
  if (found.lua) return result('lualatex', found.lua, warning);
  if (found.xe) return result('xelatex', found.xe, warning);
  if (sel === 'pdflatex' && found.uni) return result('xelatex', found.uni, warning);
  return result(sel, null, warning);
}

module.exports = { detectEngine };
