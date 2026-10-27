// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Der Watcher meldet PDFs im Ausgabeordner nicht mehr (#45): pdfChanged kommt nur aus
// doCompile, gefiltert auf den kompilierenden Nutzer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startWatcher } = require('../server/lib/watcher');

test('Ausgabeordner löst kein pdfChanged/fileDeleted aus (#45)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-watch-'));
  fs.mkdirSync(path.join(root, '.latex-ide-out'));
  fs.writeFileSync(path.join(root, '.latex-ide-out', 'main.pdf'), 'alt');
  fs.writeFileSync(path.join(root, '.latex-ide-out', 'main.aux'), 'alt');
  fs.writeFileSync(path.join(root, 'main.tex'), 'alt\n');
  const msgs = [];
  const watcher = startWatcher(root, (m) => msgs.push(m));
  try {
    await new Promise((r) => watcher.on('ready', r));
    fs.writeFileSync(path.join(root, '.latex-ide-out', 'main.pdf'), 'neu');
    fs.unlinkSync(path.join(root, '.latex-ide-out', 'main.aux'));
    fs.writeFileSync(path.join(root, 'main.tex'), 'neu\n');
    const t0 = Date.now();
    while (!msgs.some((m) => m.type === 'fileChanged') && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(msgs.some((m) => m.type === 'fileChanged' && m.path === 'main.tex'), 'Watcher läuft');
    assert.deepStrictEqual(msgs.filter((m) => String(m.path || '').startsWith('.latex-ide-out')), []);
  } finally {
    await watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
