const { execFile } = require('child_process');

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
        const parsed = parseBlocks(stdout);
        if (!parsed.Input || !parsed.Line) return reject(new Error('Keine passende Code-Stelle gefunden.'));
        resolve({ inputAbs: parsed.Input, line: Number(parsed.Line) });
      }
    );
  });
}

module.exports = { forward, inverse };
