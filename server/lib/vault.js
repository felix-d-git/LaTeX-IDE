// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
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

  // Optional mtime: high bit of len set -> 8 more bytes (ms since epoch) follow the path. Old entries have none.
  const HAS_MTIME = 0x80000000;
  function encrypt(rel, data, mtimeMs) {
    const p = Buffer.from(rel, 'utf8');
    const len = Buffer.alloc(4);
    const mt = Buffer.alloc(mtimeMs ? 8 : 0);
    len.writeUInt32BE((p.length | (mtimeMs ? HAS_MTIME : 0)) >>> 0);
    if (mtimeMs) mt.writeDoubleBE(mtimeMs);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ct = Buffer.concat([c.update(Buffer.concat([len, p, mt, data])), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  function decrypt(blob) {
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    const pt = Buffer.concat([d.update(blob.subarray(28)), d.final()]);
    const raw = pt.readUInt32BE(0);
    const n = raw & ~HAS_MTIME;
    const off = 4 + n + (raw & HAS_MTIME ? 8 : 0);
    return {
      rel: pt.subarray(4, 4 + n).toString('utf8'),
      mtimeMs: raw & HAS_MTIME ? pt.readDoubleBE(4 + n) : null,
      data: pt.subarray(off),
    };
  }

  function put(rel, data, mtimeMs) {
    const f = path.join(vaultDir, nameOf(rel));
    fs.writeFileSync(f + '.tmp', encrypt(rel, data, mtimeMs));
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
    if (e.rel.endsWith('/')) { fs.mkdirSync(abs, { recursive: true }); n++; continue; } // leerer Ordner
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
    if (e.mtimeMs) fs.utimesSync(abs, new Date(e.mtimeMs), new Date(e.mtimeMs));
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
    // Vault im gespiegelten Ordner (oder umgekehrt) spiegelt seine eigenen Eintraege endlos.
    const within = (a, b) => { const r = path.relative(b, a); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (within(vaultDir, dataDir) || within(dataDir, vaultDir)) {
      throw new Error(`VAULT_DIR (${vaultDir}) darf nicht in DATA_DIR (${dataDir}) liegen und umgekehrt - DATA_DIR explizit auf einen eigenen Ordner setzen`);
    }
    v = makeVault(DATA_KEY, vaultDir);
    fs.mkdirSync(vaultDir, { recursive: true });
    // Ohne Schreibrecht laege alles nur im (fluechtigen) DATA_DIR. .tmp raeumt restore() auf.
    const probe = path.join(vaultDir, '.schreibtest.tmp');
    try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); }
    catch (e) { throw new Error(`VAULT_DIR ${vaultDir} nicht beschreibbar: ${e.message}`); }
    fs.mkdirSync(dataDir, { recursive: true });
    ({ seen } = restore(v, vaultDir, dataDir));
  } catch (e) {
    console.error(`[vault] Start abgebrochen: ${e.message}`);
    process.exit(1);
  }
  console.log(`[vault] ${seen.size} Eintraege nach ${dataDir} entschluesselt`);

  const timers = new Map();
  const rel = (abs) => path.relative(dataDir, abs).split(path.sep).join('/');
  // seen: rel -> mtimeMs der zuletzt gespiegelten (bzw. wiederhergestellten) Fassung; bleibt dauerhaft
  // stehen, damit flush() beim Herunterfahren alles nachholen kann, was der Watcher noch nicht gemeldet hat.
  const sync = (r) => {
    timers.delete(r);
    const abs = path.join(dataDir, r);
    let st;
    try { st = fs.statSync(abs); } catch { seen.delete(r); v.del(r); return v.del(r + '/'); }
    if (st.isDirectory()) { // nur leere Ordner brauchen einen eigenen Eintrag
      if (!fs.readdirSync(abs).length) v.put(r + '/', Buffer.alloc(0));
      else v.del(r + '/');
      return;
    }
    if (!st.isFile() || seen.get(r) === st.mtimeMs) return;
    try { v.put(r, fs.readFileSync(abs), st.mtimeMs); seen.set(r, st.mtimeMs); } catch (e) { console.error(`[vault] Spiegeln von ${r} fehlgeschlagen: ${e.message}`); }
  };
  const queue = (abs) => {
    const r = rel(abs);
    if (!r || r.startsWith('..') || v.excluded(r)) return;
    clearTimeout(timers.get(r));
    timers.set(r, setTimeout(() => sync(r), DEBOUNCE_MS));
    // Ordner wird (nicht mehr) leer: Eltern neu bewerten.
    const parent = path.posix.dirname(r);
    if (parent !== '.') queue(path.join(dataDir, parent));
  };
  // Alles nachholen, was der Watcher noch nicht gemeldet hat (Schreibvorgaenge direkt vor dem Beenden).
  const sweep = () => {
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const d of entries) {
        const abs = path.join(dir, d.name);
        const r = rel(abs);
        if (v.excluded(r)) continue;
        if (d.isDirectory()) walk(abs);
        else if (d.isFile()) sync(r);
      }
      const r = rel(dir);
      if (r && !entries.length) sync(r);
    };
    walk(dataDir);
    for (const r of [...seen.keys()]) if (!fs.existsSync(path.join(dataDir, r))) sync(r);
  };
  const watcher = require('chokidar').watch(dataDir, {
    ignoreInitial: false,
    ignored: (p) => { const r = rel(p); return !!r && !r.startsWith('..') && v.excluded(r); },
  });
  watcher.on('add', queue).on('change', queue).on('unlink', queue).on('addDir', queue).on('unlinkDir', queue)
    .on('error', (e) => console.error('[vault] Watcher-Fehler:', e.message));

  active = {
    flush() {
      for (const [r, t] of [...timers]) { clearTimeout(t); sync(r); }
      try { sweep(); } catch (e) { console.error('[vault] Abschluss-Sync fehlgeschlagen:', e.message); }
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
