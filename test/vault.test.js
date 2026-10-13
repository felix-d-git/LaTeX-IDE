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
  assert.strictEqual(fs.readdirSync(vault).length, 1);
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
