// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Release-Provenienz (#174): Attestation, SHA256SUMS, cosign; Server gleicht Pakete mit SHA256SUMS ab.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createDesktopAssets } = require('../server/lib/desktopAssets');

const wf = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8').replace(/\r\n/g, '\n');

test('release.yml: Attestation und SHA256SUMS am Release', () => {
  const y = wf('release.yml');
  assert.match(y, /uses: actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(y, /attestations: write/);
  assert.match(y, /sha256sum LatexIDE-Setup\.exe LatexIDE-macOS\.zip > SHA256SUMS/);
  assert.match(y, /gh release upload [^\n]*assets\/SHA256SUMS/);
});

test('container-image.yml: keyless cosign-Signatur und SBOM', () => {
  const y = wf('container-image.yml');
  assert.match(y, /id-token: write/);
  assert.match(y, /cosign sign --yes/);
  assert.match(y, /cosign attest --yes --type spdxjson/);
  assert.match(y, /uses: anchore\/sbom-action@/);
});

const PAYLOAD = Buffer.from('echtes Setup');
const hex = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function run(sumsText) {
  return async () => {
    const orig = global.fetch;
    global.fetch = async (url) => {
      if (/releases\/tags/.test(url)) {
        return new Response(JSON.stringify({ assets: [
          { name: 'LatexIDE-Setup.exe', url: 'https://example.invalid/a', digest: 'sha256:' + hex },
          { name: 'SHA256SUMS', url: 'https://example.invalid/sums' },
        ] }));
      }
      return new Response(/sums$/.test(url) ? sumsText : PAYLOAD);
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sums-'));
    try {
      return await createDesktopAssets({ dataDir, repo: 'x/y', version: '9.9.9' }).assetFile('windows');
    } finally {
      global.fetch = orig;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test('SHA256SUMS mit falschem Hash: Paket abgelehnt', async () => {
  await assert.rejects(run(`${'0'.repeat(64)}  LatexIDE-Setup.exe\n`), /SHA256SUMS/);
});

test('SHA256SUMS ohne Eintrag: Paket abgelehnt', async () => {
  await assert.rejects(run(`${hex}  other.zip\n`), /SHA256SUMS/);
});

test('SHA256SUMS passend: Paket angenommen', async () => {
  await run(`${hex}  LatexIDE-Setup.exe\n`)();
});
