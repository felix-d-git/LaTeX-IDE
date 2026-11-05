// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Picks the TeX engine a document needs, so a fontspec/LuaTeX preamble does not
// fail just because the project still says pdflatex. Order:
// 1. "% !TEX program = …" magic comment always wins (explicit per-document choice).
// 2. LuaTeX-only features (\directlua, luacode, babel bidi=basic / onchar=) -> lualatex.
// 3. XeTeX-only packages (xeCJK) -> xelatex.
// 4. Unicode-font packages (fontspec, unicode-math, polyglossia, \babelfont, \setmainfont)
//    with pdflatex selected -> xelatex (pdflatex would abort anyway; xelatex, not
//    lualatex, because luaotfload fails under the openin_any=p sandbox in compile.js).
// Otherwise the project setting stays. A choice that would work is never overridden.
// ponytail: scans only the main file; a preamble moved into \input{praeambel} is not
// seen - follow \input there if that turns out to matter.
const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];

const LUA_PACKAGES = ['luacode', 'luaotfload', 'luacolor', 'lua-ul', 'luatexja', 'luamplib', 'lua-visual-debug'];
const XE_PACKAGES = ['xecjk', 'xeindex', 'xltxtra'];
const UNICODE_PACKAGES = ['fontspec', 'unicode-math', 'polyglossia', 'mathspec'];

function packagesOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) out.add(p.trim().toLowerCase());
  }
  return out;
}

function detectEngine(source, selected) {
  const sel = ENGINES.includes(selected) ? selected : 'pdflatex';
  const text = String(source || '');

  const magic = text.match(/^[ \t]*%[ \t]*!TEX[ \t]+(?:TS-)?program[ \t]*=[ \t]*(pdflatex|xelatex|lualatex)\b/im);
  if (magic) return { engine: magic[1].toLowerCase(), reason: '% !TEX program' };

  // Drop comments (an unescaped % to end of line) so commented-out packages don't count.
  const src = text.replace(/(^|[^\\])%.*$/gm, '$1');
  const pkgs = packagesOf(src);
  const hit = (list) => list.find((p) => pkgs.has(p));

  const lua = (/\\directlua\b|\\begin\s*\{luacode/.test(src) && 'Lua-Code')
    || (/\bbidi\s*=\s*basic/.test(src) && 'babel bidi=basic')
    || (/\bonchar\s*=/.test(src) && 'babel onchar=')
    || hit(LUA_PACKAGES);
  if (lua) return { engine: 'lualatex', reason: lua };

  const xe = hit(XE_PACKAGES);
  if (xe) return { engine: 'xelatex', reason: xe };

  if (sel === 'pdflatex') {
    const uni = hit(UNICODE_PACKAGES)
      || (/\\babelfont\b/.test(src) && '\\babelfont')
      || (/\\setmainfont\b/.test(src) && '\\setmainfont');
    if (uni) return { engine: 'xelatex', reason: uni };
  }

  return { engine: sel, reason: null };
}

module.exports = { detectEngine };
