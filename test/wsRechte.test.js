// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Issue #149: an open Yjs socket keeps the rights of its upgrade. Demotion, removal and a
// password change must take effect on the socket that is already open.
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

let n = 0;
async function sharedSession() {
  const name = `bob${++n}`;
  const { admin, user, userId } = await adminAndUser(srv, name);
  const root = (await admin.call('POST', '/api/projects/create', { name: `Rechte${n}` })).body.root;
  await admin.call('POST', '/api/projects/open', { root });
  assert.strictEqual((await admin.call('POST', '/api/share', { login: name })).status, 200);
  const projectId = (await user.call('POST', '/api/projects/open', { root })).body.projectId;
  const cookie = Object.entries(user.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const bob = yClient(srv.base, cookie, projectId, 'main.tex');
  await bob.synced;
  return { admin, user, userId, root, bob };
}

const closedWithin = (c, ms) => Promise.race([c.closed, sleep(ms).then(() => 'offen')]);

test('Herabstufung zum Kommentierenden greift auf der offenen Verbindung', async () => {
  const { admin, userId, root, bob } = await sharedSession();
  assert.strictEqual((await admin.call('POST', '/api/share/role', { userId, role: 'reviewer' })).status, 200);
  bob.type('\nNACH-HERABSTUFUNG');
  assert.strictEqual(await closedWithin(bob, 2000), 4403);
  await sleep(900);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), /NACH-HERABSTUFUNG/);
});

test('Entfernen aus der Freigabe schließt die Yjs-Verbindung', async () => {
  const { admin, userId, root, bob } = await sharedSession();
  assert.strictEqual((await admin.call('DELETE', `/api/share/${userId}`)).status, 200);
  assert.strictEqual(await closedWithin(bob, 2000), 1008);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'main.tex'), 'utf8'), /NACH/);
});

test('Passwortwechsel schließt offene Yjs-Verbindungen', async () => {
  const { user, bob } = await sharedSession();
  const r = await user.call('POST', '/api/auth/change-password', { currentPassword: 'geheim-passwort-123', newPassword: 'neues-passwort-456' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await closedWithin(bob, 2000), 1008);
});
