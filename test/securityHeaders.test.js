// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #115: CSP, X-Frame-Options, nosniff and Referrer-Policy on HTML and API answers of the
// server and the desktop app; CSP_REPORT_ONLY=1 for the staged rollout; violation reports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
// ADMIN_PASSWORD: the throwaway servers' admin login once #116 is merged, until then the old fallback.
const { startServer, client, ADMIN_PASSWORD = 'bitte-sofort-aendern' } = require('./_server');
const { contentSecurityPolicy, parseSources, cspReportHandler, MAX_LOGGED, LOG_WINDOW_MS } = require('../server/lib/securityHeaders');

const REPO = path.join(__dirname, '..');

// Directive name -> sources, e.g. csp["script-src"] = ["'self'", "'wasm-unsafe-eval'"].
function parseCsp(header) {
  assert.ok(header, 'CSP-Header fehlt');
  return Object.fromEntries(
    header.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...src]) => [name, src])
  );
}

function assertHeaders(res, what, { framed = false, reportOnly = false } = {}) {
  const h = res.headers;
  assert.strictEqual(h.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
  assert.strictEqual(h.get('x-frame-options'), framed ? 'SAMEORIGIN' : 'DENY', `${what}: X-Frame-Options`);
  assert.strictEqual(h.get('referrer-policy'), 'same-origin', `${what}: Referrer-Policy`);
  const enforced = h.get('content-security-policy');
  const reported = h.get('content-security-policy-report-only');
  assert.strictEqual(!!enforced, !reportOnly, `${what}: Content-Security-Policy ${reportOnly ? 'nicht ' : ''}gesetzt`);
  assert.strictEqual(!!reported, reportOnly, `${what}: Content-Security-Policy-Report-Only ${reportOnly ? '' : 'nicht '}gesetzt`);
  const csp = parseCsp(enforced || reported);
  assert.deepStrictEqual(csp['default-src'], ["'self'"], what);
  // No inline scripts, no eval: the XSS defence line. Only WebAssembly may be compiled (pdf.js).
  assert.deepStrictEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'"], `${what}: script-src`);
  assert.deepStrictEqual(csp['object-src'], ["'none'"], what);
  assert.deepStrictEqual(csp['base-uri'], ["'self'"], what);
  assert.deepStrictEqual(csp['form-action'], ["'self'"], what);
  assert.deepStrictEqual(csp['frame-ancestors'], [framed ? "'self'" : "'none'"], `${what}: frame-ancestors`);
  assert.ok(csp['connect-src'].includes('wss:') && csp['connect-src'].includes('ws:'), `${what}: WebSockets (Yjs)`);
  assert.ok(csp['worker-src'].includes("'self'"), `${what}: pdf.js-Worker`);
  assert.deepStrictEqual(csp['report-uri'], ['/csp-report'], what);
  return csp;
}

// The test server only gets server/ (see _server.js); the page is copied in so GET / answers with the real HTML.
function copyClientPage(srv) {
  const dir = path.join(path.dirname(srv.dataDir), 'client');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['index.html', 'theme-init.js']) fs.copyFileSync(path.join(REPO, 'client', f), path.join(dir, f));
}

test('#115: Policy - zusätzliche connect-src-Quellen nur als reine Host-/Schema-Quellen', () => {
  assert.deepStrictEqual(parseSources(' https://lt.example.com:8081  http://192.168.1.5:8010 '), ['https://lt.example.com:8081', 'http://192.168.1.5:8010']);
  // Keywords, ; (neue Direktive), , (zweite Policy) und Anführungszeichen werden verworfen.
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(parseSources("'unsafe-eval' https://a.example;script-src 'none' https://b.example x,y \"z\""), ['https://b.example']);
  } finally {
    console.warn = warn;
  }
  const csp = parseCsp(contentSecurityPolicy({ connectSrc: ['https://lt.example.com'] }));
  assert.ok(csp['connect-src'].includes('https://lt.example.com'));
  assert.ok(csp['connect-src'].includes('http://localhost:*'), 'eigener LanguageTool auf localhost');
  assert.deepStrictEqual(csp['style-src'], ["'self'", "'unsafe-inline'"]);
});

test('#115: Server setzt die Security-Header auf HTML-, Datei- und API-Antworten', async () => {
  const srv = await startServer({ CSP_CONNECT_SRC: 'https://lt.example.com' });
  try {
    copyClientPage(srv);
    const page = await fetch(srv.base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const csp = assertHeaders(page, 'GET /');
    assert.ok(csp['connect-src'].includes('https://lt.example.com'), 'CSP_CONNECT_SRC wirkt');
    // script-src 'self' trägt nur, wenn die Seite selbst kein Inline-Skript und keine on*-Handler hat.
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 2);
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="\/[^"]+"/, 'Skript nur per src');
      assert.strictEqual(body.trim(), '', 'kein Inline-Skript');
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'keine Inline-Event-Handler');
    assert.doesNotMatch(html, /javascript:/i);
    assertHeaders(await fetch(srv.base + '/theme-init.js'), 'GET /theme-init.js');

    const c = client(srv.base);
    assertHeaders(await fetch(srv.base + '/api/auth/me'), 'GET /api/auth/me (ohne Login)');
    assertHeaders(await fetch(srv.base + '/healthz'), 'GET /healthz');
    await c.login('admin', ADMIN_PASSWORD);
    const me = await fetch(srv.base + '/api/auth/me', { headers: { Cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.strictEqual(me.status, 200);
    assertHeaders(me, 'GET /api/auth/me (angemeldet)');
    const post = await fetch(srv.base + '/api/projects/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(post.status, 403, 'CSRF-Fehler');
    assertHeaders(post, 'POST ohne CSRF-Token');
    // 404 from Express' finalhandler: replaces the CSP with its own, stricter default-src 'none'.
    const missing = await fetch(srv.base + '/gibt-es-nicht');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(missing.headers.get('referrer-policy'), 'same-origin');
    assert.strictEqual(missing.headers.get('content-security-policy'), "default-src 'none'");
    // The IDE frames these itself (PDF viewer "Browser", PDF file preview): same origin only.
    assertHeaders(await fetch(srv.base + '/api/pdf?path=x.pdf'), 'GET /api/pdf', { framed: true });
    assertHeaders(await fetch(srv.base + '/api/raw?path=x.pdf'), 'GET /api/raw', { framed: true });
  } finally {
    await srv.stop();
  }
});

test('#115: CSP-Berichte fluten das Log nicht dauerhaft (Grenze je Stunde)', () => {
  const lines = [];
  let t = 0;
  const handle = cspReportHandler((l) => lines.push(l), { now: () => t })[1];
  const res = { status: () => ({ end() {} }) };
  const report = (blocked) => handle({ body: { 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': blocked, 'document-uri': 'https://ide.example/' } } }, res);
  for (let i = 0; i < MAX_LOGGED + 50; i++) report(`https://spam.example/${i}`);
  report('https://spam.example/0'); // repeated line: never logged twice
  assert.strictEqual(lines.length, MAX_LOGGED + 1, 'Grenze plus ein Hinweis');
  assert.match(lines.at(-1), /weitere unterdrückt/);
  report('https://echt.example/x.png');
  assert.strictEqual(lines.length, MAX_LOGGED + 1, 'innerhalb der Stunde unterdrückt');
  t += LOG_WINDOW_MS;
  report('https://echt.example/x.png');
  assert.match(lines.at(-1), /^\[csp\] blockiert: img-src https:\/\/echt\.example\/x\.png/, 'nach einer Stunde wieder im Log');
});

test('#115: CSP_REPORT_ONLY=1 meldet nur, Clickjacking-Schutz bleibt; Berichte landen einmal im Log', async () => {
  const srv = await startServer({ CSP_REPORT_ONLY: '1' });
  try {
    copyClientPage(srv);
    assertHeaders(await fetch(srv.base + '/'), 'GET / (Report-Only)', { reportOnly: true });
    assertHeaders(await fetch(srv.base + '/api/auth/me'), 'GET /api/auth/me (Report-Only)', { reportOnly: true });

    // Like a browser: no session, no CSRF token; query strings (tokens, ?pid=) never reach the log.
    const report = JSON.stringify({
      'csp-report': {
        'document-uri': `${srv.base}/?reset=geheim-123`,
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'inline',
        disposition: 'report',
        'source-file': `${srv.base}/dist/bundle.js?v=geheim-456`,
        'line-number': 42,
      },
    });
    const send = () => fetch(srv.base + '/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: report });
    const r = await send();
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers.get('set-cookie'), null, 'keine Sitzung für Berichte');
    assert.strictEqual((await send()).status, 204);
    // Reporting API format (application/reports+json) as well.
    const batch = [{ type: 'csp-violation', body: { documentURL: `${srv.base}/`, effectiveDirective: 'img-src', blockedURL: 'https://evil.example/x.png', disposition: 'enforce' } }];
    assert.strictEqual((await fetch(srv.base + '/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/reports+json' }, body: JSON.stringify(batch) })).status, 204);
    assert.strictEqual((await fetch(srv.base + '/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: '{kaputt' })).status, 400);
    await new Promise((res) => setTimeout(res, 200));
    const lines = srv.log().split('\n').filter((l) => l.startsWith('[csp]'));
    assert.deepStrictEqual(lines, [
      `[csp] gemeldet: script-src-elem inline (Seite ${srv.base}/ in ${srv.base}/dist/bundle.js:42)`,
      `[csp] blockiert: img-src https://evil.example/x.png (Seite ${srv.base}/)`,
    ]);
    assert.doesNotMatch(srv.log(), /geheim/);
  } finally {
    await srv.stop();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('#115: Desktop-App setzt eigene Header, auch auf weitergeleitete Server-Antworten', async () => {
  // Fake server with deliberately different headers: the desktop app must not pass them on.
  const remote = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': req.url.startsWith('/api/raw') ? 'application/pdf' : 'application/json',
      'x-latex-ide': '1',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'SAMEORIGIN',
    });
    res.end(req.url.startsWith('/api/raw') ? '%PDF-1.4' : '{"tree":[],"projectId":"P"}');
  });
  const rport = await freePort();
  await new Promise((r) => remote.listen(rport, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-desk-csp-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({ token: 'lide_test' }));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), LATEX_IDE_DATA: path.join(dir, 'data'), LATEX_IDE_LOCAL: path.join(dir, 'local'), REMOTE_URL: `http://127.0.0.1:${rport}` };
  delete env.CSP_REPORT_ONLY;
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'desktop.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw new Error('Desktop beendet:\n' + log);
      try {
        await fetch(base + '/api/desktop/info');
        break;
      } catch {
        if (i > 150) throw new Error('Desktop startet nicht:\n' + log);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const page = await fetch(base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assertHeaders(page, 'Desktop GET /');
    assertHeaders(await fetch(base + '/api/desktop/info'), 'Desktop GET /api/desktop/info');
    const proxied = await fetch(base + '/api/tree');
    assert.strictEqual(proxied.status, 200);
    assertHeaders(proxied, 'Desktop GET /api/tree (weitergeleitet)');
    assertHeaders(await fetch(base + '/api/raw?path=a.pdf'), 'Desktop GET /api/raw (weitergeleitet)', { framed: true });
    const r = await fetch(base + '/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: '{"csp-report":{"effective-directive":"img-src","blocked-uri":"data"}}' });
    assert.strictEqual(r.status, 204, 'Berichte ohne CSRF-Token');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await new Promise((r) => remote.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
