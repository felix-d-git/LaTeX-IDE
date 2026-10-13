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

// --- #31: external change while unloaded is not duplicated ---------------------

for (const [name, before, after] of [
  ['Einfügung', '@a{x}\n', '@a{x}\n@b{NEU}\n'],
  ['Ersetzung', 'foo und foo\n', 'bar und foo\n'],
]) {
  test(`external change before load, opened twice: no duplicate (${name}, #31)`, () => {
    const root = tmp();
    const file = path.join(root, 'refs.bib');
    fs.writeFileSync(file, before);
    let { cache } = openOnce(root, 'refs.bib', null);
    fs.writeFileSync(file, after); // doc not loaded: DOI import, desktop upload, external editor
    for (let n = 0; n < 2; n++) {
      const r = openOnce(root, 'refs.bib', cache);
      assert.strictEqual(r.text, after);
      cache = r.cache;
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), after);
  });
}

// --- #27: CRLF ---------------------------------------------------------------

test('CRLF file: typing at the end of line 3 lands there on disk and for others (#27)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.tex'), 'Zeile1\r\nZeile2\r\nZeile3\r\n');
  const first = openOnce(root, 'a.tex', null, (yt) => {
    assert.strictEqual(yt.toString(), 'Zeile1\nZeile2\nZeile3\n');
    yt.insert(yt.toString().indexOf('Zeile3') + 6, 'X');
  });
  assert.strictEqual(first.text, 'Zeile1\nZeile2\nZeile3X\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.tex'), 'utf8'), first.text);
  assert.strictEqual(openOnce(root, 'a.tex', null).text, first.text);
});

test('CRLF file replaced externally while open: folded in as LF (#27)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'b.tex'), 'eins\n');
  const epoch = collab.getEpoch(root, 'b.tex');
  const doc = new Y.Doc();
  const close = connect(root, 'b.tex', doc, epoch);
  fs.writeFileSync(path.join(root, 'b.tex'), 'eins\r\nzwei\r\n');
  collab.applyExternalText(root, 'b.tex', 'eins\r\nzwei\r\n');
  assert.strictEqual(doc.getText('content').toString(), 'eins\nzwei\n');
  close();
  // A 'disk' change that only differs in EOL is not written back.
  assert.strictEqual(fs.readFileSync(path.join(root, 'b.tex'), 'utf8'), 'eins\r\nzwei\r\n');
});

test('old .ystate with CRLF: CRs are removed, cached client and anchors stay intact (#27)', () => {
  const root = tmp();
  const text = 'Zeile1\r\nZeile2 Anker\r\nZeile3\r\n';
  fs.writeFileSync(path.join(root, 'c.tex'), text);
  // State as an old server wrote it: Y.Text holds the CRs.
  const old = new Y.Doc();
  old.getMap('meta').set('epoch', 'e1');
  old.getText('content').insert(0, text);
  fs.mkdirSync(path.join(root, collab.STATE_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, collab.STATE_DIR, 'c.tex.ystate'), Buffer.from(Y.encodeStateAsUpdate(old)));

  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(old)); // cached copy of the same epoch
  const yt = client.getText('content');
  const i = text.indexOf('Anker');
  const a = Y.createRelativePositionFromTypeIndex(yt, i);
  const b = Y.createRelativePositionFromTypeIndex(yt, i + 5);
  assert.strictEqual(collab.getEpoch(root, 'c.tex'), 'e1');
  const close = connect(root, 'c.tex', client, 'e1');
  close();
  assert.strictEqual(yt.toString(), 'Zeile1\nZeile2 Anker\nZeile3\n');
  const from = Y.createAbsolutePositionFromRelativePosition(a, client).index;
  const to = Y.createAbsolutePositionFromRelativePosition(b, client).index;
  assert.strictEqual(yt.toString().slice(from, to), 'Anker');
});

test('MCP editText normalizes CRLF (#27)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'd.tex'), 'a\n');
  collab.editText(root, 'd.tex', () => 'a\r\nb\r\n');
  collab.flushAll();
  assert.strictEqual(collab.readText(root, 'd.tex'), 'a\nb\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'd.tex'), 'utf8'), 'a\nb\n');
});

// --- #43: Latin-1 --------------------------------------------------------------

const LATIN1 = Buffer.from('\\usepackage[latin1]{inputenc}\nGr\xf6\xdfe und \xdcbung\n', 'latin1');

test('Latin-1 file: no live doc, the socket is closed with 4415, disk untouched (#43)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'l.tex'), LATIN1);
  assert.throws(() => collab.getEpoch(root, 'l.tex'), (e) => e.notUtf8 === true);
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = (code) => (ws.closeCode = code);
  collab.handleConnection(ws, root, 'l.tex', null);
  assert.strictEqual(ws.closeCode, 4415);
  assert.throws(() => collab.editText(root, 'l.tex', (t) => t + 'x'), /nicht UTF-8/);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'l.tex')), LATIN1);
});

test('live doc replaced by a Latin-1 file: clients dropped, pending edit not written over it (#43)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'm.tex'), 'Größe\n');
  const epoch = collab.getEpoch(root, 'm.tex');
  const doc = new Y.Doc();
  const ws = connect(root, 'm.tex', doc, epoch);
  doc.getText('content').insert(0, 'neu '); // pending save (500 ms timer)
  fs.writeFileSync(path.join(root, 'm.tex'), LATIN1);
  collab.applyExternalText(root, 'm.tex', null);
  collab.flushAll();
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'm.tex')), LATIN1);
  ws();
});

test('UTF-8 helpers: decodeText, conversion with inputenc (#43)', () => {
  const { decodeText, toUtf8Text } = require('../server/lib/fsTree');
  assert.strictEqual(decodeText(LATIN1), null);
  assert.strictEqual(decodeText(Buffer.from('\uFEFFäb', 'utf8')), 'äb');
  assert.strictEqual(toUtf8Text(LATIN1), '\\usepackage[utf8]{inputenc}\nGröße und Übung\n');
  assert.strictEqual(toUtf8Text(Buffer.from('\\usepackage[ansinew]{inputenc} \x80', 'latin1')), '\\usepackage[utf8]{inputenc} €');
});

test('replaceInProject skips files that are not UTF-8 (#43)', () => {
  const { replaceInProject } = require('../server/lib/search');
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.tex'), 'und\n');
  fs.writeFileSync(path.join(root, 'b.tex'), LATIN1);
  const r = replaceInProject(root, 'und', 'and', {});
  assert.deepStrictEqual(r.changedFiles, [{ file: 'a.tex', count: 1 }]);
  assert.deepStrictEqual(r.skippedFiles, ['b.tex']);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, 'b.tex')), LATIN1);
});

test('history: Latin-1 byte change makes a snapshot, snapshot bytes kept (#43)', () => {
  const history = require('../server/lib/history');
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.tex'), LATIN1);
  const s1 = history.snapshot(root, { trigger: 'compile' });
  fs.writeFileSync(path.join(root, 'a.tex'), Buffer.from('Gr\xe4\xdfe\n', 'latin1'));
  const s2 = history.snapshot(root, { trigger: 'compile' });
  assert.ok(s2, 'changed Latin-1 bytes must give a new snapshot');
  assert.deepStrictEqual(history.readSnapshotBuffer(root, s1.id, 'a.tex'), LATIN1);
});
