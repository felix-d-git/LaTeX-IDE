// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Paket P7 (#35): an endless loop in a document must not block the global
// compile queue - compile() returns after the time limit and kills the whole
// TeX process tree (latexmk -> perl -> pdflatex).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { compile } = require('../server/lib/compile');

const hasTex = spawnSync('latexmk', ['-v'], { windowsHide: true }).status === 0;

// Command lines of all running processes that mention `needle`.
function processesWith(needle) {
  const out = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter((l) => l.includes(needle) && !/Get-CimInstance|ps -eo/.test(l));
}

test('Kompilieren: Endlosschleife -> Zeitlimit, ganzer Prozessbaum beendet (#35)', { skip: !hasTex && 'latexmk fehlt', timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-timeout-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = `loop-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(path.join(root, `${name}.tex`), '\\documentclass{article}\n\\def\\foo{\\foo}\n\\begin{document}\n\\foo\n\\end{document}\n');
  const t0 = Date.now();
  const r = await compile(root, `${name}.tex`, {}, '.latex-ide-out', 4000);
  assert.ok(Date.now() - t0 < 15000, 'compile() muss nach dem Zeitlimit zurückkehren');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.pdfPath, null);
  assert.match(r.errors[0].message, /Zeitlimit von 4 s/);
  // taskkill/SIGKILL act asynchronously - give the OS a moment.
  let left = [];
  for (let i = 0; i < 20; i++) {
    left = processesWith(name);
    if (!left.length) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  assert.deepStrictEqual(left, [], 'pdflatex/latexmk laufen noch');
});
