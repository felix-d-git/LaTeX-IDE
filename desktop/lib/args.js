// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Datei-Argument beim Start ("Öffnen mit", Doppelklick auf .tex): erstes Argument ohne "-" mit Endung .tex.
const path = require('path');

const TEX = /\.tex$/i;

function fileArg(argv, cwd = process.cwd()) {
  for (const a of argv || []) {
    const s = String(a);
    if (s.startsWith('-') || !TEX.test(s)) continue;
    return path.resolve(cwd, s.replace(/^"(.*)"$/, '$1'));
  }
  return null;
}

module.exports = { fileArg };
