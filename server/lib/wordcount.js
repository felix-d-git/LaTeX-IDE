const fs = require('fs');
const path = require('path');
const { safeResolve } = require('./fsTree');

function stripComments(text) {
  return text.replace(/(^|[^\\])%.*$/gm, '$1');
}

// Follows \input{...}/\include{...} one level deep so chapter files split out
// of main.tex (the common thesis layout) get counted too - not a full TeX
// expansion, just enough for the typical single-level chapter-per-file setup.
function expandInputs(root, text, depth = 0) {
  if (depth > 3) return text;
  return text.replace(/\\(?:input|include)\{([^}]+)\}/g, (match, file) => {
    let relPath = file.trim();
    if (!relPath.endsWith('.tex')) relPath += '.tex';
    try {
      // \input{../../other-user/x} must not read outside the project.
      const abs = safeResolve(root, relPath);
      if (!fs.existsSync(abs)) return '';
      return expandInputs(root, fs.readFileSync(abs, 'utf8'), depth + 1);
    } catch (e) {
      return '';
    }
  });
}

const HEADER_RE = /\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\{/g;
const MATH_DISPLAY_RE =
  /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(?:equation|align|gather|multline)\*?\}[\s\S]*?\\end\{(?:equation|align|gather|multline)\*?\}/g;
const MATH_INLINE_RE = /\$(?:[^$\\]|\\.)+\$|\\\((?:[^\\]|\\.)*?\\\)/g;

// Rough approximation of Overleaf's word count (LaTeX-aware but not a full
// parser): strips comments, expands one level of \input/\include, counts
// headers/math regions separately, then strips remaining commands/braces
// before counting words in what's left.
function countWords(root, mainRelPath) {
  const mainAbs = safeResolve(root, mainRelPath);
  let text = fs.readFileSync(mainAbs, 'utf8');
  text = stripComments(expandInputs(root, text));

  const headers = (text.match(HEADER_RE) || []).length;
  const mathDisplay = (text.match(MATH_DISPLAY_RE) || []).length;
  const withoutDisplay = text.replace(MATH_DISPLAY_RE, ' ');
  const mathInline = (withoutDisplay.match(MATH_INLINE_RE) || []).length;

  let prose = withoutDisplay.replace(MATH_INLINE_RE, ' ');
  prose = prose.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, ' ');
  prose = prose.replace(/[{}\\]/g, ' ');
  const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).length;

  return { words, headers, mathInline, mathDisplay };
}

module.exports = { countWords, expandInputs, stripComments };
