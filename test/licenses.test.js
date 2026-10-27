// THIRD_PARTY_NOTICES.md leaves out the pdfjs-dist parts with their own licenses
// (STRIPPED in scripts/licenses.js) because the Docker build, the installer build
// and the image check delete or reject them. The three lists must stay in sync.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STRIPPED } = require('../scripts/licenses.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sorted = (a) => [...a].sort();
const want = sorted(STRIPPED['pdfjs-dist']);

test('Lizenzen: Dockerfile löscht genau die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /cd node_modules\/pdfjs-dist \\\n\s*&& rm -rf ([^\n]+)/.exec(read('Dockerfile'));
  assert.ok(m, 'rm -rf für pdfjs-dist fehlt im Dockerfile');
  assert.deepStrictEqual(sorted(m[1].trim().split(/\s+/)), want);
});

test('Lizenzen: Installer-Build löscht genau die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /\$PdfjsUnused = @\(([^)]*)\)/.exec(read('installer/build-release.ps1'));
  assert.ok(m, '$PdfjsUnused fehlt in build-release.ps1');
  const parts = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '').replace(/\\/g, '/'));
  assert.deepStrictEqual(sorted(parts), want);
});

test('Lizenzen: Container-Workflow prüft die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /for p in ([^;]+); do\n\s*! ls -d \/app\/node_modules\/pdfjs-dist\//.exec(read('.github/workflows/container-image.yml'));
  assert.ok(m, 'Prüfung der pdfjs-dist-Teile fehlt in container-image.yml');
  assert.deepStrictEqual(sorted(m[1].trim().split(/\s+/)), want);
});
