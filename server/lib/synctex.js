// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parses the "Key:value" line blocks the synctex CLI prints between
// "SyncTeX result begin"/"end". Several matches can appear for one query
// (one per text run on the source line); keep only the first block's
// fields since that's the point closest to the query.
function parseBlocks(output) {
  const result = {};
  // synctex.exe on Windows emits \r\n; JS regex `.` doesn't match \r, so a
  // trailing \r would stop `$` from ever matching - normalize line endings first.
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z]+):(.*)$/);
    if (m && !(m[1] in result)) result[m[1]] = m[2].trim();
  }
  return result;
}

function forward(pdfAbs, texAbs, line, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'synctex',
      ['view', '-i', `${line}:0:${texAbs}`, '-o', pdfAbs],
      { cwd },
      (err, stdout) => {
        if (err) return reject(err);
        const parsed = parseBlocks(stdout);
        if (!parsed.Page) return reject(new Error('Keine passende PDF-Position gefunden.'));
        const page = Number(parsed.Page);
        // Alle Treffer-Boxen der ersten Seite (je Textlauf eine), damit der
        // Client den ganzen Absatz hinterlegen kann.
        const boxes = stdout
          .split(/Output:/)
          .slice(1)
          .map(parseBlocks)
          .filter((b) => Number(b.Page) === page)
          .map((b) => ({ h: Number(b.h), v: Number(b.v), W: Number(b.W), H: Number(b.H) }));
        // synctex meldet dieselbe Box teils mehrfach (z. B. pro Eingabe-Tag).
        const unique = [...new Map(boxes.map((b) => [JSON.stringify(b), b])).values()];
        resolve({ page, h: Number(parsed.h), v: Number(parsed.v), boxes: unique });
      }
    );
  });
}

function inverse(pdfAbs, page, x, y, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'synctex',
      ['edit', '-o', `${page}:${x}:${y}:${pdfAbs}`],
      { cwd },
      (err, stdout) => {
        if (err) return reject(err);
        // Alle Treffer (je Block einer), der erste liegt am nächsten am Klick.
        const hits = stdout
          .split(/Output:/)
          .slice(1)
          .map(parseBlocks)
          .filter((b) => b.Input && b.Line)
          .map((b) => ({ input: b.Input, line: Math.max(1, Number(b.Line) || 1) }));
        if (!hits.length) return reject(new Error('Keine passende Code-Stelle gefunden.'));
        resolve({ inputAbs: hits[0].input, line: hits[0].line, hits });
      }
    );
  });
}

function isFileInside(root, rel) {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

// SyncTeX-Eingabepfad -> Projektpfad ("kap/eins.tex"), oder null, wenn er nicht im
// Projekt liegt (z. B. eine .cls aus TeX Live). pdfTeX schreibt "<cwd>/./<Datei>",
// wobei <cwd> der echte Pfad ist (Symlink/Junction aufgelöst, unter Windows ggf. andere
// Schreibweise/Kodierung) - deshalb zuerst den Teil nach "/./" nehmen, dann relativ
// zum Projekt bzw. zu seinem echten Pfad.
function toProjectPath(root, input) {
  const norm = String(input).replace(/\\/g, '/');
  const candidates = [];
  const dot = norm.indexOf('/./');
  if (dot >= 0) candidates.push(path.normalize(norm.slice(dot + 3)));
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {}
  for (const base of new Set([root, real])) {
    candidates.push(path.relative(base, path.resolve(base, norm)));
  }
  for (const rel of candidates) {
    if (isFileInside(root, rel)) return rel.split(path.sep).join('/');
  }
  return null;
}

// Erster Treffer, der im Projekt liegt.
function inverseInProject(root, pdfAbs, page, x, y, cwd = root) {
  return inverse(pdfAbs, page, x, y, cwd).then(({ hits }) => {
    for (const h of hits) {
      const file = toProjectPath(root, h.input);
      if (file) return { file, line: h.line };
    }
    throw new Error(`Die Stelle gehört zu keiner Projektdatei (${hits[0].input}).`);
  });
}

module.exports = { forward, inverse, inverseInProject, toProjectPath };
