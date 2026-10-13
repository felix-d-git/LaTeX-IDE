// Issue #61 (stage 2 of #41): the project is per window. Two windows of one account work in
// different projects at the same time; ws events follow the window's subscription.
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

const wsOpen = async (c) => {
  const cookie = Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie } });
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
  await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
  return ws;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('zwei Fenster, zwei Projekte: Anfragen und Events bleiben im eigenen Projekt', async () => {
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
  const hB = { 'X-Project-Id': idB };

  // Window 1 still addresses A although "last opened" is B.
  await w1.call('POST', '/api/tree/file', { path: 'nurA.tex' }, hA);
  assert.ok(fs.existsSync(path.join(a, 'nurA.tex')));
  assert.ok(!fs.existsSync(path.join(b, 'nurA.tex')), 'Datei landete in B');
  assert.strictEqual((await w1.call('DELETE', '/api/tree?path=main.tex', undefined, hA)).status, 200);
  assert.ok(fs.existsSync(path.join(b, 'main.tex')), 'B/main.tex wurde gelöscht');
  assert.strictEqual((await w1.call('GET', `/api/raw?path=nurA.tex&pid=${encodeURIComponent(idA)}`)).status, 200);

  // Events: each socket only gets its subscribed project.
  const ws1 = await wsOpen(w1);
  const ws2 = await wsOpen(w2);
  ws1.send(JSON.stringify({ type: 'subscribe', projectId: idA }));
  ws2.send(JSON.stringify({ type: 'subscribe', projectId: idB }));
  await wait(300);
  await w2.call('POST', '/api/tree/file', { path: 'nurB.tex' }, hB);
  await w2.call('POST', '/api/main-file', { path: 'nurB.tex' }, hB);
  await wait(1500);
  assert.ok(ws2.msgs.some((m) => m.projectId === idB), 'B-Fenster bekam kein Event');
  assert.ok(!ws1.msgs.some((m) => m.projectId === idB), 'A-Fenster bekam B-Events');

  // Project moved away: window gets projectGone, requests answer 404 + projectGone.
  // (last opened is B, so A may be archived; the window showing A is kicked.)
  assert.strictEqual((await w2.call('POST', '/api/projects/archive', { name: path.basename(a) })).status, 200);
  await wait(500);
  assert.ok(ws1.msgs.some((m) => m.type === 'projectGone' && m.projectId === idA), 'kein projectGone');
  const r = await w1.call('GET', '/api/tree', undefined, hA);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.projectGone, true);
  ws1.close();
  ws2.close();
});
