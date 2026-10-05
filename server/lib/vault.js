// At-rest-Verschluesselung: DATA_DIR (fluechtig, z. B. tmpfs) wird in VAULT_DIR (Platte)
// verschluesselt gespiegelt. Aktiv nur mit DATA_KEY + VAULT_DIR, sonst No-op.
// Eintrag: Dateiname = HMAC(relPfad) hex, Inhalt = iv(12) | tag(16) | AES-256-GCM({len,relPfad,Daten}).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 500;
const NAME_RE = /^[0-9a-f]{64}$/;

function parseKey(s) {
  const v = String(s || '').trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (buf.length !== 32) throw new Error('DATA_KEY muss 32 Byte sein (64 Hex-Zeichen oder Base64). Neuen erzeugen: node server/lib/vault.js keygen');
  return buf;
}

function makeVault(dataKey, vaultDir) {
  const master = parseKey(dataKey);
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  const macKey = derive('latex-vault-hmac');
  const aesKey = derive('latex-vault-aes');
  const nameOf = (rel) => crypto.createHmac('sha256', macKey).update(rel).digest('hex');

  function encrypt(rel, data) {
    const p = Buffer.from(rel, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(p.length);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ct = Buffer.concat([c.update(Buffer.concat([len, p, data])), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  function decrypt(blob) {
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    const pt = Buffer.concat([d.update(blob.subarray(28)), d.final()]);
    const n = pt.readUInt32BE(0);
    return { rel: pt.subarray(4, 4 + n).toString('utf8'), data: pt.subarray(4 + n) };
  }

  function put(rel, data) {
    const f = path.join(vaultDir, nameOf(rel));
    fs.writeFileSync(f + '.tmp', encrypt(rel, data));
    fs.renameSync(f + '.tmp', f);
  }

  function del(rel) {
    try { fs.unlinkSync(path.join(vaultDir, nameOf(rel))); } catch { /* war nie gespiegelt */ }
  }

  // Nicht spiegeln: Build-Ausgaben, Release-Downloads, TeX Live, Temp-/Lock-Dateien.
  function excluded(rel) {
    const parts = rel.split('/');
    return parts.includes('.latex-ide-out') || parts[0] === 'desktop' || parts[0] === 'texlive'
      || /\.(tmp|lock|swp)$/.test(parts[parts.length - 1]);
  }

  return { put, del, decrypt, excluded };
}

// Vault -> Klartextordner. Jeder defekte Eintrag bricht ab (sonst Datenverlust beim spaeteren Spiegeln).
function restore(v, vaultDir, dataDir) {
  fs.mkdirSync(vaultDir, { recursive: true });
  const seen = new Map();
  let n = 0;
  for (const name of fs.readdirSync(vaultDir)) {
    if (!NAME_RE.test(name)) {
      if (name.endsWith('.tmp')) fs.rmSync(path.join(vaultDir, name), { force: true });
      continue;
    }
    let e;
    try { e = v.decrypt(fs.readFileSync(path.join(vaultDir, name))); }
    catch (err) { throw new Error(`Vault-Eintrag ${name} nicht entschluesselbar (falscher DATA_KEY oder defekt): ${err.message}`); }
    const abs = path.resolve(dataDir, e.rel);
    if (!abs.startsWith(path.resolve(dataDir) + path.sep)) throw new Error(`Vault-Eintrag ${name}: unzulaessiger Pfad`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
    seen.set(e.rel, fs.statSync(abs).mtimeMs);
    n++;
  }
  return { n, seen };
}

let active = null;

function start() {
  const { DATA_KEY, VAULT_DIR } = process.env;
  if (!DATA_KEY || !VAULT_DIR) return false;
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..'));
  const vaultDir = path.resolve(VAULT_DIR);
  let v, seen;
  try {
    v = makeVault(DATA_KEY, vaultDir);
    fs.mkdirSync(dataDir, { recursive: true });
    ({ seen } = restore(v, vaultDir, dataDir));
  } catch (e) {
    console.error(`[vault] Start abgebrochen: ${e.message}`);
    process.exit(1);
  }
  console.log(`[vault] ${seen.size} Eintraege nach ${dataDir} entschluesselt`);

  const timers = new Map();
  const rel = (abs) => path.relative(dataDir, abs).split(path.sep).join('/');
  const sync = (r) => {
    timers.delete(r);
    const abs = path.join(dataDir, r);
    let st;
    try { st = fs.statSync(abs); } catch { return v.del(r); }
    if (!st.isFile()) return;
    if (seen.get(r) === st.mtimeMs) { seen.delete(r); return; } // gerade erst wiederhergestellt
    seen.delete(r);
    try { v.put(r, fs.readFileSync(abs)); } catch (e) { console.error(`[vault] Spiegeln von ${r} fehlgeschlagen: ${e.message}`); }
  };
  const queue = (abs) => {
    const r = rel(abs);
    if (!r || r.startsWith('..') || v.excluded(r)) return;
    clearTimeout(timers.get(r));
    timers.set(r, setTimeout(() => sync(r), DEBOUNCE_MS));
  };
  const watcher = require('chokidar').watch(dataDir, {
    ignoreInitial: false,
    ignored: (p) => { const r = rel(p); return !!r && !r.startsWith('..') && v.excluded(r); },
  });
  watcher.on('add', queue).on('change', queue).on('unlink', queue)
    .on('error', (e) => console.error('[vault] Watcher-Fehler:', e.message));

  active = {
    flush() {
      for (const [r, t] of [...timers]) { clearTimeout(t); sync(r); }
      return watcher.close();
    },
  };
  return true;
}

// Fuer den Graceful Shutdown: ausstehende Schreibvorgaenge sofort erledigen.
function flush() {
  return active ? active.flush() : undefined;
}

// Einmal-Migration: Klartextordner -> VAULT_DIR (ohne Ausnahmen, Klartext bleibt).
function encryptDir(src) {
  const vaultDir = path.resolve(process.env.VAULT_DIR || '');
  if (!process.env.VAULT_DIR || !process.env.DATA_KEY) throw new Error('DATA_KEY und VAULT_DIR muessen gesetzt sein');
  const v = makeVault(process.env.DATA_KEY, vaultDir);
  fs.mkdirSync(vaultDir, { recursive: true });
  let n = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      const r = path.relative(src, abs).split(path.sep).join('/');
      if (v.excluded(r) || abs === vaultDir) continue;
      if (d.isDirectory()) walk(abs);
      else if (d.isFile()) { v.put(r, fs.readFileSync(abs)); n++; }
    }
  };
  walk(path.resolve(src));
  return n;
}

module.exports = { start, flush, makeVault, restore };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'keygen') console.log(crypto.randomBytes(32).toString('hex'));
    else if (cmd === 'encrypt' && arg) console.log(`${encryptDir(arg)} Dateien verschluesselt nach ${process.env.VAULT_DIR}`);
    else { console.error('Aufruf: node server/lib/vault.js keygen | encrypt <klartextDir>  (Env: DATA_KEY, VAULT_DIR)'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
