// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Strg + Mausrad-Zoom (#210): ~10 % pro Raste, Grenzen 25-300 %.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../client/src/pdfZoom.js'), 'utf8');
const load = () => import('data:text/javascript,' + encodeURIComponent(src));

test('wheelScale: ~10 % pro Raste, Richtung nach deltaY', async () => {
  const { wheelScale } = await load();
  assert.ok(Math.abs(wheelScale(1, -100) - 1.1) < 1e-9);
  assert.ok(Math.abs(wheelScale(1, 100) - 1 / 1.1) < 1e-9);
  assert.strictEqual(wheelScale(1.5, 0), 1.5);
});

test('wheelScale: Grenzen 25-300 %', async () => {
  const { wheelScale } = await load();
  assert.strictEqual(wheelScale(2.95, -100), 3);
  assert.strictEqual(wheelScale(0.26, 100), 0.25);
});
