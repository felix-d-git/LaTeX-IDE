// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Yjs-Filter für Kommentierende (#157): Allow-List (nur eigene Einträge der Map "anchors"),
// keine pending structs, Rate-Limit pro Verbindung.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const collab = require('../server/lib/collab');

const syncMsg = (write) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  write(e);
  return encoding.toUint8Array(e);
};

function setup(ownsAnchor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-rf-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.tex'), 'Hallo Welt');
  const doc = new Y.Doc();
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.closeCode = null;
  ws.send = (msg, cb) => {
    const dec = decoding.createDecoder(new Uint8Array(msg));
    if (decoding.readVarUint(dec) === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, doc, 'server');
      if (encoding.length(enc) > 1) ws.emit('message', encoding.toUint8Array(enc));
    }
    if (cb) cb();
  };
  ws.close = (code) => {
    if (ws.readyState !== 1) return;
    ws.readyState = 3;
    ws.closeCode = code;
    ws.emit('close');
  };
  doc.on('update', (u, origin) => origin !== 'server' && ws.readyState === 1 && ws.emit('message', syncMsg((e) => syncProtocol.writeUpdate(e, u))));
  collab.handleConnection(ws, root, 'a.tex', collab.getEpoch(root, 'a.tex'), true, ownsAnchor);
  ws.emit('message', syncMsg((e) => syncProtocol.writeSyncStep1(e, doc)));
  return { root, doc, ws };
}

const own = (id) => id.startsWith('mine');

test('eigener Anchor: erlaubt, fremder Anchor: abgewiesen', () => {
  const { doc, ws } = setup(own);
  doc.getMap('anchors').set('mine1', 1);
  assert.equal(ws.closeCode, null);
  doc.getMap('anchors').set('fremd1', 1);
  assert.equal(ws.closeCode, 4403);
  doc.destroy();
});

test('meta.epoch und neue Root-Typen: abgewiesen', () => {
  const a = setup(() => true);
  a.doc.getMap('meta').set('epoch', 'x');
  assert.equal(a.ws.closeCode, 4403);
  const b = setup(() => true);
  b.doc.getMap('x').set('k', 'v');
  assert.equal(b.ws.closeCode, 4403);
  const c = setup(() => true);
  c.doc.getText('content').insert(0, 'x');
  assert.equal(c.ws.closeCode, 4403);
});

test('Update mit pending struct: abgewiesen', () => {
  const ydoc = new Y.Doc();
  ydoc.getText('content').insert(0, 'abc');
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
  let u2;
  other.on('update', (u) => (u2 = u));
  other.getMap('anchors').set('mine1', 1);
  const first = u2;
  other.getMap('anchors').set('mine2', 2); // depends on clock of 'mine1' (same client)
  const second = u2;
  assert.notEqual(first, second);
  assert.equal(collab.reviewerMayApply(ydoc, second, own), false);
  assert.equal(collab.reviewerMayApply(ydoc, first, own), true);
});

test('Rate-Limit: Flut von Updates schliesst die Verbindung', () => {
  const { doc, ws } = setup(() => true);
  for (let i = 0; i < 60 && ws.closeCode === null; i++) doc.getMap('anchors').set('mine' + i, i);
  assert.equal(ws.closeCode, 1008);
  doc.destroy();
});

test('Zu grosse Nachricht eines Kommentierenden: 1009', () => {
  const { doc, ws } = setup(() => true);
  doc.getMap('anchors').set('mine1', 'x'.repeat(collab.REVIEWER_MAX_PAYLOAD + 10));
  assert.equal(ws.closeCode, 1009);
  doc.destroy();
});
