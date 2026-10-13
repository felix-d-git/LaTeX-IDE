// #53: Strg+Z im Review-Modus muss den Review-Eintrag mit zurücknehmen, sonst
// bleibt die Löschung sichtbar und "Reject" fügt den Text ein zweites Mal ein.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { register } = require('node:module');

register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function load(url, c, next) {
      if (url.includes('/client/src/')) return next(url, { ...c, format: 'module' });
      return next(url, c);
    }`)
);

// collab.js hängt beim Laden den Offline-Banner ins DOM: ein Proxy, der alles schluckt.
const any = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => any, set: () => true });
globalThis.document = globalThis.window = globalThis.localStorage = any;

test('Undo nimmt Text und Review-Eintrag gemeinsam zurück, Redo beides wieder her', async () => {
  const { createUndoManager } = await import(pathToFileURL(path.join(__dirname, '../client/src/collab.js')).href);
  const Y = await import('yjs'); // dieselbe (ESM-)Instanz wie im Client-Code
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');
  ytext.insert(0, 'Hallo schöne Welt');
  const um = createUndoManager(ydoc);
  um.stopCapturing();

  // Wie im Editor: ySync löscht, direkt danach schreibt trackChanges.record() den Eintrag.
  ytext.delete(6, 7);
  ydoc.getMap('review').set('r1', { type: 'delete', text: 'schöne ' });

  um.undo();
  assert.equal(ytext.toString(), 'Hallo schöne Welt');
  assert.equal(ydoc.getMap('review').size, 0);
  um.redo();
  assert.equal(ytext.toString(), 'Hallo Welt');
  assert.deepEqual([...ydoc.getMap('review').keys()], ['r1']);
  um.destroy();
});
