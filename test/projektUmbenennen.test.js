// Issue #42: owner renames a project while a member is typing in it. Pending edits land in the
// renamed folder, the member is sent away (4410), the old folder never comes back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { startServer, adminAndUser } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal y-websocket peer: syncs, then `type(text)` appends to the shared text.
function yClient(base, cookie, projectId, rel) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(`${base.replace('http', 'ws')}/yjs/${encodeURIComponent(projectId)}/${encodeURIComponent(rel)}`, { headers: { Cookie: cookie } });
  ws.binaryType = 'arraybuffer';
  const send = (enc) => ws.readyState === 1 && ws.send(encoding.toUint8Array(enc));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const synced = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, ydoc);
      send(enc);
    });
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const t = syncProtocol.readSyncMessage(dec, enc, ydoc, 'server');
      if (encoding.length(enc) > 1) send(enc);
      if (t === 1) resolve();
    });
  });
  ydoc.on('update', (u, origin) => {
    if (origin === 'server') return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    send(enc);
  });
  const ytext = ydoc.getText('content');
  return { synced, closed, type: (s) => ytext.insert(ytext.length, s), ws };
}

test('Umbenennen während ein Mitglied tippt: kein Geisterordner, Änderung im neuen Ordner, 4410', async () => {
  const { admin, user } = await adminAndUser(srv);
  const root = (await admin.call('POST', '/api/projects/create', { name: 'Thesis' })).body.root;
  await admin.call('POST', '/api/projects/open', { root });
  assert.strictEqual((await admin.call('POST', '/api/share', { login: 'bob' })).status, 200);
  const other = (await admin.call('POST', '/api/projects/create', { name: 'Anderes' })).body.root;
  await admin.call('POST', '/api/projects/open', { root: other });

  const opened = await user.call('POST', '/api/projects/open', { root });
  assert.strictEqual(opened.status, 200);
  const projectId = opened.body.projectId;
  assert.ok(projectId, 'open liefert projectId');
  const cookie = Object.entries(user.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const bob = yClient(srv.base, cookie, projectId, 'main.tex');
  await bob.synced;

  bob.type('\nBOBS-ABSATZ');
  await sleep(50); // reached the server, persist still pending
  const ren = await admin.call('POST', '/api/projects/rename', { oldName: 'Thesis', newName: 'Thesis-final' });
  assert.strictEqual(ren.status, 200);
  const newRoot = ren.body.root;

  assert.strictEqual(await Promise.race([bob.closed, sleep(2000).then(() => 'offen')]), 4410);
  bob.type('\nNACH-DEM-UMBENENNEN'); // a late keystroke must go nowhere
  await sleep(900);
  assert.ok(!fs.existsSync(root), 'alter Ordner wurde neu angelegt');
  assert.match(fs.readFileSync(path.join(newRoot, 'main.tex'), 'utf8'), /BOBS-ABSATZ/);

  // Bob's active project followed the rename, so he can keep working there.
  const list = (await user.call('GET', '/api/projects/list')).body;
  assert.deepStrictEqual(list.sharedProjects.map((p) => path.resolve(p.root)), [path.resolve(newRoot)]);
  assert.strictEqual((await user.call('GET', '/api/tree')).status, 200);
});
