// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const { detectEngine } = require('../server/lib/detectEngine');

const eng = (src, sel) => detectEngine(src, sel).engine;

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
