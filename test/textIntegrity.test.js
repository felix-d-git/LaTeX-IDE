// Paket P3 (#27, #31, #43, #44): text must reach disk and every client exactly as typed -
// no CRLF offset shift, no duplicated external edits, no U+FFFD for Latin-1, and
// comment/track-change anchors must survive external changes.
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

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-text-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const syncMsg = (write) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  write(enc);
  return encoding.toUint8Array(enc);
};

// A y-websocket client in-process: a fake socket wired to collab.handleConnection.
function connect(root, rel, doc, epoch) {
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
  const onUpdate = (u, origin) => origin !== 'server' && ws.readyState === 1 && ws.emit('message', syncMsg((e) => syncProtocol.writeUpdate(e, u)));
  doc.on('update', onUpdate);
  collab.handleConnection(ws, root, rel, epoch);
  if (ws.readyState === 1) ws.emit('message', syncMsg((e) => syncProtocol.writeSyncStep1(e, doc)));
  return () => {
    doc.off('update', onUpdate);
    ws.close();
    collab.flushAll();
  };
}

// Open with a cached client state (like IndexedDB), optionally edit, close; returns the new cache.
function openOnce(root, rel, cache, edit) {
  const epoch = collab.getEpoch(root, rel);
  const doc = new Y.Doc();
  if (cache) Y.applyUpdate(doc, cache);
  const close = connect(root, rel, doc, epoch);
  if (edit) edit(doc.getText('content'));
  close();
  const out = { text: doc.getText('content').toString(), cache: Y.encodeStateAsUpdate(doc) };
  doc.destroy();
  return out;
}

// --- #44: applyText with minimal edits keeps anchors -----------------------

function anchored(text, word) {
  const doc = new Y.Doc();
  const yt = doc.getText('content');
  yt.insert(0, text);
  const i = text.indexOf(word);
  const a = Y.createRelativePositionFromTypeIndex(yt, i);
  const b = Y.createRelativePositionFromTypeIndex(yt, i + word.length);
  const resolve = () => {
    const from = Y.createAbsolutePositionFromRelativePosition(a, doc).index;
    const to = Y.createAbsolutePositionFromRelativePosition(b, doc).index;
    return yt.toString().slice(from, to);
  };
  return { yt, resolve };
}

test('applyText: changes in line 1 and 10 keep an anchor in line 5 (#44)', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Zeile ${i + 1} mit Begriff`);
  lines[4] = 'Hier steht der Kommentar-Anker';
  const { yt, resolve } = anchored(lines.join('\n') + '\n', 'Kommentar-Anker');
  const next = yt.toString().replace('Zeile 1 mit Begriff', 'Zeile 1 mit Wort').replace('Zeile 10 mit Begriff', 'Zeile 10 mit Wort');
  assert.strictEqual(collab.applyText(yt, next, 'disk'), true);
  assert.strictEqual(yt.toString(), next);
  assert.strictEqual(resolve(), 'Kommentar-Anker');
});

test('applyText: change inside the anchored line keeps the anchor (#44)', () => {
  const { yt, resolve } = anchored('\\section{foo} und Anker hier\n', 'Anker');
  const next = '\\section{bar} und Anker hier, ergänzt\n';
  collab.applyText(yt, next, 'disk');
  assert.strictEqual(yt.toString(), next);
  assert.strictEqual(resolve(), 'Anker');
});

test('applyText: insertions, deletions and a full rewrite give the exact target (#44)', () => {
  const cases = [
    ['a\nb\nc\n', 'x\na\nc\nd\n'],
    ['', 'neu\n'],
    ['alles\nweg\n', ''],
    ['abc'.repeat(3000), 'xyz'.repeat(2500)],
    ['ohne Zeilenende', 'ohne Zeilenende\nmit'],
  ];
  for (const [cur, next] of cases) {
    const doc = new Y.Doc();
    const yt = doc.getText('content');
    yt.insert(0, cur);
    collab.applyText(yt, next, 'disk');
    assert.strictEqual(yt.toString(), next);
  }
});
