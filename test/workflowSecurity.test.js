// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Workflows mit Minimalrechten (#173): statische Textpruefung, kein YAML-Parser noetig.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');

test('Workflows vorhanden', () => assert.ok(files.length >= 7));

for (const f of files) {
  test(`${f}: permissions: {} auf oberster Ebene`, () => {
    assert.match(read(f), /^permissions: \{\}\s*$/m);
  });

  test(`${f}: checkout ohne gespeichertes Token`, () => {
    const y = read(f);
    const parts = y.split(/^\s*- uses: actions\/checkout@/m).slice(1);
    for (const p of parts) {
      // Step-Block: bis zum naechsten "- " auf gleicher Einrueckung
      const block = p.split(/^\s*- /m)[0];
      assert.match(block, /persist-credentials: false/, `${f}: checkout ohne persist-credentials: false`);
    }
  });

  test(`${f}: npm ci nur mit --ignore-scripts`, () => {
    for (const l of read(f).split('\n')) {
      if (/^\s*#/.test(l)) continue;
      if (/npm (ci|install)\b/.test(l)) assert.match(l, /--ignore-scripts/, l);
    }
  });
}

test('release.yml: Build und Upload getrennt, Schreibrechte nur im Upload', () => {
  const y = read('release.yml');
  const jobs = y.slice(y.indexOf('\njobs:')).split(/^  (?=[a-z-]+:\s*$)/m);
  const job = (n) => jobs.find((j) => j.startsWith(`${n}:`));
  const build = job('build');
  const upload = job('upload');
  assert.ok(build && upload, 'Jobs build und upload fehlen');
  assert.match(upload, /needs: \[[^\]]*build/);
  assert.doesNotMatch(build, /contents: write|packages: write/);
  assert.match(build, /upload-artifact/);
  assert.match(upload, /download-artifact/);
  assert.match(upload, /contents: write/);
  assert.doesNotMatch(upload, /packages: write/);
  assert.doesNotMatch(y, /environment:/);
  assert.match(y, /package\.json/);
  assert.match(y, /--draft/);
  assert.match(y, /schon veroeffentlicht/);
});
