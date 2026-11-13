// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #113: project files come from the app's origin. An uploaded SVG with <script>, opened directly
// (/api/raw link, new tab), must not run there: sandbox CSP + nosniff. Images and PDFs stay viewable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// ADMIN_PASSWORD: the throwaway servers' admin login once #116 is merged, until then the old fallback.
const { startServer, client, adminAndUser, ADMIN_PASSWORD = 'bitte-sofort-aendern' } = require('./_server');

const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>
fetch('/api/admin/invites',{method:'POST',headers:{'X-CSRF-Token':document.cookie.match(/csrfToken=([^;]+)/)[1],'Content-Type':'application/json'},body:'{}'})
</script><rect width="40" height="40" fill="red"/></svg>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

const cookieOf = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function get(srv, c, url) {
  const res = await fetch(srv.base + url, { headers: { Cookie: cookieOf(c) } });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}
function assertSandboxed(r, what) {
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /(^|;)\s*sandbox\s*(;|$)/, `${what}: CSP ohne sandbox (${csp})`);
  assert.match(csp, /default-src 'none'/, `${what}: CSP ohne default-src 'none'`);
  assert.doesNotMatch(csp, /allow-scripts|script-src/, `${what}: CSP erlaubt Skripte`);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff fehlt`);
}

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

test('#113: SVG eines Mitwirkenden kommt über /api/raw nur in der Sandbox, Bilder und PDF bleiben abrufbar', async () => {
  const { admin, user } = await adminAndUser(srv, 'mitwirkender');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Abbildungen' })).body;
  const projectId = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
  assert.strictEqual((await admin.call('POST', '/api/share', { login: 'mitwirkender', role: 'editor' }, { 'X-Project-Id': projectId })).status, 200);

  // The editor uploads the files (drag & drop into the tree).
  const pid = { 'X-Project-Id': projectId };
  const up = (name, buf) => user.call('POST', '/api/tree/upload', { dir: '', name, content: buf.toString('base64') }, pid);
  for (const [name, buf] of [['abb.svg', Buffer.from(EVIL_SVG)], ['bild.png', PNG], ['quelle.pdf', PDF], ['seite.html', Buffer.from('<script>alert(1)</script>')]]) {
    const r = await up(name, buf);
    assert.strictEqual(r.status, 200, `${name}: ${r.text}`);
  }

  const raw = (p) => get(srv, admin, `/api/raw?path=${encodeURIComponent(p)}&pid=${encodeURIComponent(projectId)}`);

  const svg = await raw('abb.svg');
  assert.strictEqual(svg.status, 200);
  assert.strictEqual(svg.headers.get('content-type'), 'image/svg+xml');
  assertSandboxed(svg, 'abb.svg');
  assert.strictEqual(svg.body.toString(), EVIL_SVG, 'Bild selbst bleibt unverändert (Vorschau per <img>)');
  assert.strictEqual(svg.headers.get('cache-control'), 'no-store');

  const png = await raw('bild.png');
  assert.strictEqual(png.status, 200);
  assert.strictEqual(png.headers.get('content-type'), 'image/png');
  assertSandboxed(png, 'bild.png');
  assert.ok(png.body.equals(PNG));

  // PDF: nosniff, but no sandbox - it would block the browser's PDF viewer in the preview iframe.
  const pdf = await raw('quelle.pdf');
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(pdf.headers.get('x-content-type-options'), 'nosniff');
  assert.doesNotMatch(pdf.headers.get('content-security-policy') || '', /sandbox/);
  assert.ok(pdf.body.equals(PDF));

  // Unknown types stay a download, also sandboxed.
  const html = await raw('seite.html');
  assert.strictEqual(html.status, 200);
  assert.strictEqual(html.headers.get('content-type'), 'application/octet-stream');
  assertSandboxed(html, 'seite.html');

  // Missing file: still a plain 404 JSON answer.
  const missing = await raw('fehlt.svg');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);

  // /api/pdf serves any project file as PDF: nosniff keeps the SVG from being rendered as such.
  const asPdf = await get(srv, admin, `/api/pdf?path=abb.svg&pid=${encodeURIComponent(projectId)}`);
  assert.strictEqual(asPdf.status, 200);
  assert.strictEqual(asPdf.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(asPdf.headers.get('x-content-type-options'), 'nosniff');
});

test('#113: Downloads (Zip, Projekt-PDF) tragen nosniff und Sandbox', async () => {
  const { admin, userId } = await adminAndUser(srv, 'downloader');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Downloads' })).body;
  const projectId = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
  const me = (await admin.call('GET', '/api/auth/me')).body.user;
  assert.ok(me && me.id && me.id !== userId);
  // Compiled PDF of main.tex (individual compile mode: per-user output folder).
  const out = path.join(root, '.latex-ide-out', `u-${me.id}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'main.pdf'), PDF);

  const q = `pid=${encodeURIComponent(projectId)}`;
  for (const url of [`/api/download/zip?${q}`, `/api/projects/download/zip?items=${encodeURIComponent(JSON.stringify(['Downloads']))}`, '/api/projects/Downloads/download/zip']) {
    const r = await get(srv, admin, url);
    assert.strictEqual(r.status, 200, url);
    assert.match(r.headers.get('content-disposition') || '', /^attachment/, url);
    assertSandboxed(r, url);
  }
  const pdf = await get(srv, admin, '/api/projects/Downloads/download/pdf');
  assert.strictEqual(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition') || '', /^attachment/);
  assert.strictEqual(pdf.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(pdf.body.equals(PDF));
});

// Fake pandoc (shebang script): LaTeX -> empty AST, then an HTML page with a script.
test('#113: HTML-Export kommt als Download mit Sandbox', { skip: process.platform === 'win32' && 'Pandoc-Attrappe braucht ein Shebang-Skript' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-pandoc-'));
  const fake = path.join(dir, 'pandoc');
  fs.writeFileSync(
    fake,
    `#!${process.execPath}
const a = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(a[a.indexOf('-t') + 1] === 'json' ? '{"pandoc-api-version":[1,23,1],"meta":{},"blocks":[]}' : '<!DOCTYPE html><script>alert(document.cookie)</script>'));
`,
    { mode: 0o755 }
  );
  const own = await startServer({ PANDOC: fake });
  try {
    const admin = client(own.base);
    await admin.login('admin', ADMIN_PASSWORD);
    const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Export' })).body;
    const projectId = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
    const r = await get(own, admin, `/api/export?format=html&pid=${encodeURIComponent(projectId)}`);
    assert.strictEqual(r.status, 200, r.body.toString());
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.match(r.headers.get('content-disposition') || '', /^attachment/);
    assertSandboxed(r, 'HTML-Export');
    assert.match(r.body.toString(), /<script>/);
  } finally {
    await own.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
