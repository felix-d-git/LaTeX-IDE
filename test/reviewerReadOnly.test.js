// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Rolle „Nur kommentieren“ (#52): lokale Änderungen kommen nicht ins Dokument
// (Toolbar/Menü/Kontextmenü/Vorschlag annehmen laufen über view.dispatch), und der
// Server weist Text-Updates eines Kommentierenden hörbar ab (4403 statt still verwerfen).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { register } = require('node:module');
const { EventEmitter } = require('events');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const collab = require('../server/lib/collab');

// package.json sagt "commonjs", der Client-Code ist aber ESM.
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function load(url, c, next) {
      if (url.includes('/client/src/')) return next(url, { ...c, format: 'module' });
      return next(url, c);
    }`)
);
const loadCommands = () => import(pathToFileURL(path.join(__dirname, '../client/src/editorCommands.js')).href);

// Minimale "View": nur state + dispatch, wie die Helfer sie brauchen.
async function viewWith(doc, readOnly) {
  const { EditorState } = await import('@codemirror/state');
  const { reviewerReadOnly } = await loadCommands();
  const v = {
    state: EditorState.create({ doc, selection: { anchor: 0, head: 5 }, extensions: readOnly ? reviewerReadOnly : [] }),
    dispatch(spec) { v.state = v.state.update(spec).state; },
    focus() {},
  };
  return v;
}

test('Formatier-Helfer ändern bei Nur-Lesen nichts, sonst schon', async () => {
  const { wrapSelection, insertAtCursor, insertAtLineStart } = await loadCommands();
  const ro = await viewWith('Hallo Welt', true);
  wrapSelection(ro, '\\textbf{', '}');
  insertAtCursor(ro, 'x');
  insertAtLineStart(ro, '\\section{}');
  assert.equal(ro.state.doc.toString(), 'Hallo Welt');
  const rw = await viewWith('Hallo Welt', false);
  wrapSelection(rw, '\\textbf{', '}');
  assert.equal(rw.state.doc.toString(), '\\textbf{Hallo} Welt');
});

test('Nur-Lesen: direkter dispatch (Vorschlag annehmen, Ausschneiden) wird verworfen, ySync-Änderung kommt durch', async () => {
  const { ySyncAnnotation } = await import('y-codemirror.next');
  const v = await viewWith('Hallo Welt', true);
  v.dispatch({ changes: { from: 0, to: 5, insert: 'Servus' } });
  assert.equal(v.state.doc.toString(), 'Hallo Welt');
  v.dispatch({ changes: { from: 10, insert: '!' }, annotations: [ySyncAnnotation.of({})] });
  assert.equal(v.state.doc.toString(), 'Hallo Welt!');
});

const syncMsg = (write) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  write(enc);
  return encoding.toUint8Array(enc);
};

// Fake y-websocket client (wie textIntegrity.test.js), hier als Kommentierender (readOnly).
function connectReviewer(root, rel, doc) {
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
  collab.handleConnection(ws, root, rel, collab.getEpoch(root, rel), true);
  if (ws.readyState === 1) ws.emit('message', syncMsg((e) => syncProtocol.writeSyncStep1(e, doc)));
  return ws;
}

test('Server: Text-Update eines Kommentierenden → Verbindung 4403, Anker-Update geht durch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-rev-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.tex'), 'Hallo Welt');
  const doc = new Y.Doc();
  const ws = connectReviewer(root, 'a.tex', doc);
  assert.equal(doc.getText('content').toString(), 'Hallo Welt');

  // Kommentar-Anker (eigene Map) darf ein Kommentierender schreiben.
  doc.getMap('anchors').set('c1', 1);
  assert.equal(ws.closeCode, null);

  // Text nicht: abgewiesen und getrennt, damit der Client seinen Cache verwirft.
  doc.getText('content').insert(0, '\textbf{}');
  assert.equal(ws.closeCode, 4403);
  collab.flushAll();
  assert.equal(fs.readFileSync(path.join(root, 'a.tex'), 'utf8'), 'Hallo Welt');
  doc.destroy();
});
