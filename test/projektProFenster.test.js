// Issue #41 (stage 1): the active project is per user; a window still showing project A after
// another window opened B must get 409 projectSwitched instead of acting on B.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { startServer, client } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

test('Fenster 1 (A) nach Wechsel in Fenster 2 (B): 409 statt Zugriff auf B, Broadcasts tragen projectId', async () => {
  const w1 = client(srv.base);
  await w1.login('admin', 'bitte-sofort-aendern');
  const w2 = client(srv.base);
  await w2.login('admin', 'bitte-sofort-aendern');
  const a = (await w1.call('POST', '/api/projects/create', { name: 'ProjektA' })).body.root;
  const b = (await w1.call('POST', '/api/projects/create', { name: 'ProjektB' })).body.root;
  const idA = (await w1.call('POST', '/api/projects/open', { root: a })).body.projectId;
  const idB = (await w2.call('POST', '/api/projects/open', { root: b })).body.projectId;
  assert.ok(idA && idB && idA !== idB);
  const hA = { 'X-Project-Id': idA };

  const del = await w1.call('DELETE', '/api/tree?path=main.tex', undefined, hA);
  assert.strictEqual(del.status, 409);
  assert.strictEqual(del.body.projectSwitched, true);
  assert.ok(fs.existsSync(path.join(b, 'main.tex')), 'B/main.tex wurde gelöscht');
  assert.strictEqual((await w1.call('GET', '/api/tree', undefined, hA)).status, 409);
  assert.strictEqual((await w1.call('GET', `/api/raw?path=main.tex&pid=${encodeURIComponent(idA)}`)).status, 409);
  // Reviewer gate route (write) and a matching id still work.
  assert.strictEqual((await w1.call('POST', '/api/main-file', { path: 'main.tex' }, hA)).status, 409);
  assert.strictEqual((await w2.call('GET', '/api/tree', undefined, { 'X-Project-Id': idB })).status, 200);

  // Window 1's event socket gets B's events, tagged with B's id so the client can drop them.
  const cookie = Object.entries(w1.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie } });
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
  const got = new Promise((r) => ws.on('message', (d) => r(JSON.parse(d))));
  await w2.call('POST', '/api/tree/file', { path: 'neu.tex' }, { 'X-Project-Id': idB });
  await w2.call('POST', '/api/main-file', { path: 'neu.tex' }, { 'X-Project-Id': idB });
  const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 4000))]);
  ws.close();
  assert.ok(msg, 'kein Broadcast empfangen');
  assert.strictEqual(msg.projectId, idB);
});
