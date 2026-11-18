// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Paket P11 (#55): VAULT_DIR inside DATA_DIR mirrored its own entries endlessly,
// and an unwritable VAULT_DIR left all data only in the volatile DATA_DIR.
// vault.start() must refuse both at startup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VAULT = path.join(__dirname, '..', 'server', 'lib', 'vault.js');
const KEY = 'a'.repeat(64);

// Starts the vault in a child process, mirrors for 1.5 s, then flushes and exits 0.
// `deny`: every write into this dir fails with EACCES (like a root-owned bind mount).
function run(dataDir, vaultDir, deny) {
  const code = `
    const fs = require('fs');
    const deny = process.env.DENY;
    if (deny) {
      const orig = fs.writeFileSync;
      fs.writeFileSync = function (f, ...a) {
        if (String(f).startsWith(deny)) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
        return orig.call(this, f, ...a);
      };
    }
    const v = require(${JSON.stringify(VAULT)});
    v.start();
    setTimeout(async () => { await v.flush(); process.exit(0); }, 1500);
  `;
  return spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, DATA_KEY: KEY, DATA_DIR: dataDir, VAULT_DIR: vaultDir, DENY: deny || '' },
    encoding: 'utf8', timeout: 20000,
  });
}

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-vault-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('Vault: getrennte Ordner -> Start, Datei wird genau einmal gespiegelt', () => {
  const root = tmp();
  const data = path.join(root, 'data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'a.tex'), 'x');
  const r = run(data, vault);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readdirSync(vault).filter((n) => /^[0-9a-f]{64}$/.test(n)).length, 1); // + .manifest
});

test('Vault: VAULT_DIR in DATA_DIR -> Start bricht ab, nichts gespiegelt (#55)', () => {
  const data = tmp();
  const vault = path.join(data, 'vault');
  fs.writeFileSync(path.join(data, 'a.tex'), 'x');
  const r = run(data, vault);
  assert.strictEqual(r.status, 1, `Start muss abbrechen, Ausgabe: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /VAULT_DIR .* darf nicht in DATA_DIR/);
  assert.ok(!fs.existsSync(vault) || fs.readdirSync(vault).length === 0);
});

test('Vault: DATA_DIR in VAULT_DIR -> Start bricht ab (#55)', () => {
  const vault = tmp();
  const r = run(path.join(vault, 'data'), vault);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /darf nicht in DATA_DIR/);
});

test('Vault: VAULT_DIR nicht beschreibbar -> Start bricht ab (#55)', () => {
  const root = tmp();
  const data = path.join(root, 'data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(data);
  fs.mkdirSync(vault);
  const r = run(data, vault, vault);
  assert.strictEqual(r.status, 1, `Start muss abbrechen, Ausgabe: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /nicht beschreibbar/);
});

// #162: Name als AAD, signiertes Manifest, Migration.
const { makeVault, restore } = require(VAULT);
const crypto = require('crypto');

function setup(files) {
  const root = tmp();
  const data = path.join(root, 'data');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(data); fs.mkdirSync(vault);
  const v = makeVault(KEY, vault);
  for (const [r, c] of Object.entries(files)) v.put(r, Buffer.from(c));
  return { root, data, vault, v: makeVault(KEY, vault), name: (r) => v.nameOf(r) };
}

test('Vault #162: Roundtrip mit Manifest', () => {
  const s = setup({ 'a.tex': 'A', 'b/c.tex': 'C' });
  const { n } = restore(s.v, s.vault, s.data);
  assert.strictEqual(n, 2);
  assert.strictEqual(fs.readFileSync(path.join(s.data, 'b/c.tex'), 'utf8'), 'C');
  assert.ok(fs.existsSync(path.join(s.vault, '.manifest')));
});

test('Vault #162: vertauschte Dateinamen werden abgelehnt', () => {
  const s = setup({ 'a.tex': 'A', 'b.tex': 'B' });
  const fa = path.join(s.vault, s.name('a.tex')), fb = path.join(s.vault, s.name('b.tex'));
  const ba = fs.readFileSync(fa);
  fs.writeFileSync(fa, fs.readFileSync(fb)); fs.writeFileSync(fb, ba);
  assert.throws(() => restore(s.v, s.vault, s.data), /Manifest abgelehnt/);
  fs.rmSync(path.join(s.vault, '.manifest')); // ohne Manifest: AAD bzw. Namensbindung greift trotzdem
  assert.throws(() => restore(makeVault(KEY, s.vault), s.vault, s.data), /nicht entschluesselbar|passt nicht/);
});

test('Vault #162: Kopie unter fremdem Namen / zurueckgespielter Eintrag -> Abbruch', () => {
  const s = setup({ 'a.tex': 'A' });
  const f = path.join(s.vault, s.name('a.tex'));
  fs.copyFileSync(f, path.join(s.vault, 'f'.repeat(64)));
  assert.throws(() => restore(s.v, s.vault, s.data), /fehlt im Manifest/);
  fs.rmSync(path.join(s.vault, 'f'.repeat(64)));
  const old = fs.readFileSync(f);
  s.v.put('a.tex', Buffer.from('neu'));
  fs.writeFileSync(f, old);
  assert.throws(() => restore(makeVault(KEY, s.vault), s.vault, s.data), /weicht ab/);
});

test('Vault #162: manipuliertes Manifest / zurueckgerollte Generation / geloeschter Eintrag -> Abbruch', () => {
  const s = setup({ 'a.tex': 'A', 'b.tex': 'B' });
  const mf = path.join(s.vault, '.manifest');
  const good = fs.readFileSync(mf, 'utf8');
  const m = JSON.parse(good);
  fs.writeFileSync(mf, JSON.stringify({ ...m, gen: m.gen - 1 }));
  assert.throws(() => restore(makeVault(KEY, s.vault), s.vault, s.data), /Signatur ungueltig/);
  fs.writeFileSync(mf, good);
  fs.unlinkSync(path.join(s.vault, s.name('b.tex')));
  assert.throws(() => restore(makeVault(KEY, s.vault), s.vault, s.data), /geloescht/);
});

test('Vault #162: Alt-Vault ohne AAD/Manifest wird migriert, danach strikt', () => {
  const root = tmp();
  const data = path.join(root, 'data'), vault = path.join(root, 'vault');
  fs.mkdirSync(data); fs.mkdirSync(vault);
  const v = makeVault(KEY, vault);
  // Alt-Format nachbauen: ohne AAD.
  const master = Buffer.from(KEY, 'hex');
  const d = (i) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), i, 32));
  const rel = 'alt.tex', p = Buffer.from(rel), len = Buffer.alloc(4); len.writeUInt32BE(p.length);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', d('latex-vault-aes'), iv);
  const ct = Buffer.concat([c.update(Buffer.concat([len, p, Buffer.from('ALT')])), c.final()]);
  fs.writeFileSync(path.join(vault, v.nameOf(rel)), Buffer.concat([iv, c.getAuthTag(), ct]));
  assert.strictEqual(restore(v, vault, data).n, 1);
  assert.strictEqual(fs.readFileSync(path.join(data, rel), 'utf8'), 'ALT');
  assert.ok(fs.existsSync(path.join(vault, '.manifest')));
  const v2 = makeVault(KEY, vault);
  fs.rmSync(data, { recursive: true }); fs.mkdirSync(data);
  assert.strictEqual(restore(v2, vault, data).n, 1); // strikt mit AAD
  assert.strictEqual(v2.decrypt(fs.readFileSync(path.join(vault, v.nameOf(rel))), v.nameOf(rel)).rel, rel);
  assert.throws(() => v2.decrypt(fs.readFileSync(path.join(vault, v.nameOf(rel))), null));
});
