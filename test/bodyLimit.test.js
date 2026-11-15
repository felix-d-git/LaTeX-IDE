// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #150: no 50-MB JSON parsing before session/CSRF/auth (pre-auth DoS). Small global limit,
// big bodies only on the routes that need them and only after login / MCP token check.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, client, adminAndUser } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

const big = (n) => JSON.stringify({ login: 'x', password: 'y', pad: 'a'.repeat(n) });
const post = (url, body, headers = {}) =>
  fetch(srv.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

test('#150: großer JSON-Body ohne Anmeldung wird abgelehnt, ohne ihn zu parsen', async () => {
  // Public route: 1 MB JSON is over the small global limit -> 413.
  assert.strictEqual((await post('/api/auth/login', big(1024 * 1024))).status, 413);
  assert.strictEqual((await post('/irgendwo', big(1024 * 1024))).status, 413);
  // Big-limit routes: without login / token the body is never parsed -> 401/403 instead.
  assert.ok([401, 403].includes((await post('/api/tree/upload', big(1024 * 1024))).status));
  const mcp = await post('/mcp', big(1024 * 1024), { Authorization: 'Bearer lmcp_falsch' });
  assert.strictEqual(mcp.status, 401);
});

test('#150: angemeldet funktionieren große Uploads weiter', async () => {
  const { admin } = await adminAndUser(srv, 'gross');
  const { root } = (await admin.call('POST', '/api/projects/create', { name: 'Gross' })).body;
  const projectId = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
  const content = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  const r = await admin.call('POST', '/api/tree/upload', { dir: '', name: 'gross.bin', content }, { 'X-Project-Id': projectId });
  assert.strictEqual(r.status, 200, r.text);
  // Normal small requests still parse.
  assert.strictEqual((await admin.call('POST', '/api/dictionary', { words: ['Wort'] })).status, 200);
});
