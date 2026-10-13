// P12-C Feinschliff: Server-Kern (Konten, Collab, Vault, MCP-Pfade, Sync).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-fsC-'));
process.env.DATA_DIR = DATA;
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
const SERVER = path.join(__dirname, '..', 'server');
const auth = require('../server/lib/auth');
const authMw = require('../server/lib/authMiddleware');
const collab = require('../server/lib/collab');
const treeOps = require('../server/lib/treeOps');
const { conflictName } = require('../server/lib/localSync');
const Y = require('yjs');

test('validatePassword: zu kurz / kein String wirft', () => {
  assert.throws(() => auth.validatePassword('kurz'));
  assert.throws(() => auth.validatePassword(12345678));
  auth.validatePassword('langgenug1');
});

test('kaputte auth-data.json: Start bricht ab statt leerer Kontenliste, Kopie bleibt', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-fsC-auth-'));
  fs.writeFileSync(path.join(d, 'auth-data.json'), '{kaputt');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(SERVER, 'lib', 'auth.js'))})`], { env: { ...process.env, DATA_DIR: d }, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /nicht lesbar/);
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('auth-data.json.corrupt-')));
  assert.strictEqual(fs.readFileSync(path.join(d, 'auth-data.json'), 'utf8'), '{kaputt');
  fs.rmSync(d, { recursive: true, force: true });
});

test('MCP-Token: Projektrechte folgen Umbenennen, fallen bei Papierkorb weg', () => {
  const tok = auth.createMcpToken('u1', { name: 'x', projects: { alt: ['read'], bleibt: ['read'] } });
  auth.moveMcpProject('alt', 'neu');
  let p = auth.findMcpToken; // token lookup needs a real user, inspect via list
  p = auth.listMcpTokens('u1')[0].projects;
  assert.deepStrictEqual(p, { bleibt: ['read'], neu: ['read'] });
  auth.moveMcpProject('neu', null);
  assert.deepStrictEqual(auth.listMcpTokens('u1')[0].projects, { bleibt: ['read'] });
  assert.ok(tok.startsWith('lmcp_'));
});

test('Login-Limiter: erfolgreiche Anfragen geben den Platz zurueck', () => {
  const mw = authMw.rateLimit('t-skip', 2, 60000, () => 'k', { countIf: (res) => res.statusCode >= 400 });
  const call = (status) => {
    let code = 0;
    const handlers = {};
    const res = { statusCode: status, set() {}, status(c) { code = c; return this; }, json() {}, on: (e, f) => (handlers[e] = f) };
    mw({}, res, () => {});
    if (!code) handlers.finish();
    return code;
  };
  for (let i = 0; i < 10; i++) assert.strictEqual(call(200), 0);
  assert.strictEqual(call(401), 0);
  assert.strictEqual(call(401), 0);
  assert.strictEqual(call(401), 429);
});

test('applyText: Surrogatpaare werden nicht zerteilt', () => {
  for (const [a, b] of [['x 𝔸 y', 'x 𝔹 y'], ['😀', '😁'], ['a😀b\nz', 'a😁b\nz']]) {
    const doc = new Y.Doc();
    const t = doc.getText('c');
    t.insert(0, a);
    collab.applyText(t, b, 'test');
    assert.strictEqual(t.toString(), b);
    assert.ok(!t.toString().includes('�'));
  }
});

test('deletePath: Projektwurzel wird abgelehnt', () => {
  const root = fs.mkdtempSync(path.join(DATA, 'p-'));
  fs.writeFileSync(path.join(root, 'a.tex'), 'x');
  assert.throws(() => treeOps.deletePath(root, '.'), /Projektwurzel/);
  assert.ok(fs.existsSync(path.join(root, 'a.tex')));
});

test('Konflikt-Kopie: zweiter Konflikt bekommt neuen Namen', () => {
  assert.strictEqual(conflictName('a.tex'), 'a.offline-konflikt.tex');
  assert.strictEqual(conflictName('a.tex', 2), 'a.offline-konflikt-2.tex');
});

test('Vault: letzter Schreibvorgang vor flush, leere Ordner und mtime ueberleben Neustart', () => {
  const root = fs.mkdtempSync(path.join(DATA, 'v-'));
  const data = path.join(root, 'data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(data);
  const VAULT = path.join(SERVER, 'lib', 'vault.js');
  const env = { ...process.env, DATA_KEY: 'b'.repeat(64), DATA_DIR: data, VAULT_DIR: vault };
  const run = (code) => spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 20000 });
  // Lauf 1: Dateien erst unmittelbar vor flush() schreiben (Watcher meldet sie nicht mehr rechtzeitig).
  const r1 = run(`
    const fs = require('fs'), path = require('path');
    const v = require(${JSON.stringify(VAULT)});
    v.start();
    setTimeout(async () => {
      fs.mkdirSync(path.join(${JSON.stringify(data)}, 'leer'));
      const f = path.join(${JSON.stringify(data)}, 'spaet.tex');
      fs.writeFileSync(f, 'inhalt');
      fs.utimesSync(f, new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
      await v.flush(); process.exit(0);
    }, 1500);`);
  assert.strictEqual(r1.status, 0, r1.stderr);
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data);
  const r2 = run(`require(${JSON.stringify(VAULT)}).start(); setTimeout(() => process.exit(0), 300);`);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(fs.readFileSync(path.join(data, 'spaet.tex'), 'utf8'), 'inhalt');
  assert.ok(fs.statSync(path.join(data, 'leer')).isDirectory());
  assert.strictEqual(Math.round(fs.statSync(path.join(data, 'spaet.tex')).mtimeMs / 1000), Date.parse('2020-01-02T03:04:05Z') / 1000);
});
