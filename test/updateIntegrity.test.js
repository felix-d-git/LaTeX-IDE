// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Desktop-Pakete nur mit passender SHA-256 aus der Release-API, Server-Adresse nur https (#147).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createDesktopAssets, checkUrl } = require('../server/lib/desktopAssets');

const PAYLOAD = Buffer.from('echtes Setup');
const sha = (b) => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

function withFetch(digest, served, fn) {
  return async () => {
    const orig = global.fetch;
    global.fetch = async (url) => /releases\/tags/.test(url)
      ? new Response(JSON.stringify({ assets: [{ name: 'LatexIDE-Setup.exe', url: 'https://example.invalid/a', digest }] }))
      : new Response(served);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-upd-'));
    try {
      await fn(createDesktopAssets({ dataDir, repo: 'x/y', version: '9.9.9' }), dataDir);
    } finally {
      global.fetch = orig;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test('manipuliertes Paket wird abgelehnt und nicht gespeichert', withFetch(sha(PAYLOAD), Buffer.from('boeses Setup'), async (assets, dataDir) => {
  await assert.rejects(assets.assetFile('windows'), /Prüfsumme/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'desktop', '9.9.9')), []);
}));

test('Paket ohne Prüfsumme wird abgelehnt', withFetch(undefined, PAYLOAD, async (assets) => {
  await assert.rejects(assets.assetFile('windows'), /SHA-256/);
}));

test('Paket mit passender Prüfsumme wird gespeichert', withFetch(sha(PAYLOAD), PAYLOAD, async (assets) => {
  assert.deepStrictEqual(fs.readFileSync(await assets.assetFile('windows')), PAYLOAD);
}));

test('Server-Adresse: https oder nur lokal http', () => {
  for (const ok of ['https://latex.example.org', 'http://localhost:3077', 'http://127.0.0.1:3099/x']) checkUrl(ok);
  for (const bad of ['http://rechner:3077', 'http://192.168.1.5', 'http://localhost.evil.org', 'ftp://x']) assert.throws(() => checkUrl(bad), /Ungültige/);
});
