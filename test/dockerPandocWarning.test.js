// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Dockerfile warns at PANDOC=1 about the missing static-libs copyright notices (#200)', () => {
  const df = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(df, /apt-get install[^\n]*pandoc[^]*?WARNING: PANDOC=1[^]*?pandoc-copyright\.py[^]*?>&2; fi/);
});
