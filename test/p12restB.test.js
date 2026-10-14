// P12-Rest B (#64): Funktionen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, client } = require('./_server');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('/api/auth/me meldet features.pandoc als boolean; tote Endpunkte sind weg', async () => {
  const srv = await startServer();
  try {
    const c = client(srv.base);
    await c.login('admin', 'bitte-sofort-aendern');
    const me = await c.call('GET', '/api/auth/me');
    assert.strictEqual(typeof me.body.features.pandoc, 'boolean');
    assert.strictEqual((await c.call('PUT', '/api/file', { path: 'a.tex', content: 'x' })).status, 404);
    assert.strictEqual((await c.call('POST', '/api/replace', { query: 'a', replacement: 'b' })).status, 404);
  } finally {
    await srv.stop();
  }
});

test('compileStatus enthält errors/warnings, Client wertet sie aus', () => {
  assert.match(read('server/index.js'), /type: 'compileStatus', status, log: result\.log, errors: .*warnings:/);
  const main = read('client/src/main.js');
  assert.match(main, /compileStatus: \(msg\) => \{[\s\S]*?errorPanel\.setLog\(msg\)/);
});

test('MCP delete_file nutzt den Papierkorb', () => {
  const m = read('server/lib/mcp.js');
  const body = m.slice(m.indexOf("tool('delete_file'"), m.indexOf("tool(\n      'move_file'"));
  assert.match(body, /treeOps\.trashPath/);
  assert.doesNotMatch(body, /deletePath/);
});

test('Pandoc-Menü wird ohne Pandoc deaktiviert; Ersetzen-API entfernt', () => {
  assert.match(read('client/src/menuBar.js'), /exportAs\('docx'\), \.\.\.noPandoc\(\)/);
  assert.doesNotMatch(read('client/src/api.js'), /api\/replace/);
});
