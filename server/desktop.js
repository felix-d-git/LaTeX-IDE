// Desktop app: serves the same web client on localhost, forwards everything
// to the shared server (REMOTE_URL) with the user's desktop token, and
// compiles locally against a mirror of the project - the Pi can't compile
// for everyone. Projects the user owns are kept as a real copy in LOCAL_DIR
// (default Documents\LatexIDE), synced both ways while online; offline, tree,
// files and compile come from that copy. Other GETs fall back to a cache, Yjs
// keeps editing alive in the browser's IndexedDB.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const { compile, findMainCandidate, OUT_DIR } = require('./lib/compile');
const synctex = require('./lib/synctex');
const wordcount = require('./lib/wordcount');
const { buildTree, pickStartFile, isTextFile } = require('./lib/fsTree');
const { syncFolder, moveDir } = require('./lib/localSync');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3178;
const DATA = process.env.LATEX_IDE_DATA || path.join(__dirname, '..', 'desktop-data');
const CONFIG_PATH = path.join(DATA, 'config.json');
const CACHE_DIR = path.join(DATA, 'cache');
const MIRROR_DIR = path.join(DATA, 'mirror');
const SYNC_DIR = path.join(DATA, 'sync');
const APP_VERSION = require('../package.json').version;
const LOCAL_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const CSRF_COOKIE = 'csrfToken';

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(MIRROR_DIR, { recursive: true });

// --- small helpers ---

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let config = readJson(CONFIG_PATH, {});
// Written by the installer (dir page "lokale Kopie") / build-release.ps1 (update source).
const readInstallJson = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
};
const install = readInstallJson('install.json');
// Server address: built into the installer by the server it was downloaded from
// (server.json, written by LatexIDE.iss / shipped in the macOS zip).
const REMOTE = String(process.env.REMOTE_URL || readInstallJson('server.json').remoteUrl || '').replace(/\/+$/, '');
if (!REMOTE) {
  console.error('Keine Server-Adresse: REMOTE_URL setzen oder die App über die Weboberfläche des Servers neu herunterladen.');
  process.exit(1);
}
// The setting in the app (config) beats the installer's default; the env var beats both.
let LOCAL_DIR = path.resolve(process.env.LATEX_IDE_LOCAL || config.localDir || install.localDir || path.join(os.homedir(), 'Documents', 'LatexIDE'));
fs.mkdirSync(LOCAL_DIR, { recursive: true });
function setToken(token) {
  config = { ...config, token: token || undefined };
  writeJson(CONFIG_PATH, config);
}

// Resolve a server-supplied relative path strictly inside dir.
function inside(dir, rel) {
  const abs = path.resolve(dir, String(rel || ''));
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error('Ungültiger Pfad.');
  return abs;
}

function cookieValue(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

class Offline extends Error {}

// Circuit breaker: once offline, requests fail at once (no timeout per request);
// pingRemote() below flips the state back as soon as the server answers again.
async function remote(pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
  if (!online) throw new Offline('offline');
  let res;
  try {
    res = await fetch(REMOTE + pathAndQuery, {
      method,
      headers: { ...headers, Authorization: `Bearer ${config.token}` },
      body,
      signal: AbortSignal.timeout(method === 'GET' ? 15000 : 120000),
      redirect: 'manual',
    });
  } catch (e) {
    setOnline(false);
    throw new Offline(e.message);
  }
  // Funnel down / Pi off: Tailscale answers with 502/503/504 instead of a refused connection.
  if ([502, 503, 504].includes(res.status)) {
    setOnline(false);
    throw new Offline(`HTTP ${res.status}`);
  }
  if (res.status === 401) setToken(null); // revoked or expired - log in again
  return res;
}
let online = true;
const wsSockets = new Set(); // proxied browser sockets - dropped when we go offline so the client notices at once

function setOnline(v) {
  if (v === online) return;
  online = v;
  if (v) {
    setImmediate(syncAll); // back online: merge the offline copy
    setImmediate(reopenOnServer);
  }
  else for (const s of wsSockets) s.destroy();
}

// Active health check: any HTTP answer except the tunnel's 502-504 = server reachable.
// Every 2 s with a 2 s limit -> offline shows within ~4 s, recovery within ~2 s.
let pinging = false;
async function pingRemote() {
  if (pinging) return;
  pinging = true;
  try {
    const r = await fetch(REMOTE + '/', { method: 'HEAD', signal: AbortSignal.timeout(2000), redirect: 'manual' });
    setOnline(![502, 503, 504].includes(r.status));
  } catch {
    setOnline(false);
  } finally {
    pinging = false;
  }
}
setInterval(pingRemote, 2000).unref();

async function remoteJson(pathAndQuery) {
  const res = await remote(pathAndQuery);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// --- app ---

const app = express();

// DNS rebinding / other local sites: only our own origin may talk to us.
app.use((req, res, next) => {
  if (!LOCAL_HOSTS.has(req.headers.host)) return res.status(421).end('Falscher Host.');
  if (!cookieValue(req, CSRF_COOKIE)) {
    res.append('Set-Cookie', `${CSRF_COOKIE}=${crypto.randomBytes(24).toString('hex')}; Path=/; SameSite=Strict`);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path.startsWith('/api/')) {
    const c = cookieValue(req, CSRF_COOKIE);
    if (!c || req.get('X-CSRF-Token') !== c) {
      return res.status(403).json({ error: 'CSRF-Prüfung fehlgeschlagen. Bitte Seite neu laden.' });
    }
  }
  next();
});

// --- login via the server's web UI ---

const pendingStates = new Set();

app.get('/desktop/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  res.redirect(`${REMOTE}/?desktop=${PORT}&state=${state}`);
});

app.get('/desktop-callback', (req, res) => {
  const { token, state } = req.query;
  if (!state || !pendingStates.delete(String(state)) || !/^lide_[\w-]+$/.test(String(token || ''))) {
    return res.status(400).send('Ungültige oder abgelaufene Anmeldung. Bitte die Desktop-App neu starten.');
  }
  setToken(String(token));
  setImmediate(syncAll);
  res.redirect(`http://localhost:${PORT}/`);
});

app.get('/api/desktop/info', (req, res) => {
  res.json({ desktop: true, connected: !!config.token, remote: REMOTE, online, localDir: LOCAL_DIR, version: APP_VERSION });
});

// --- local copy folder (settings) ---
// Moves all owned project folders to a new location: copy, verify count + size, only then
// delete the old ones. Sync is paused meanwhile.
app.post('/api/desktop/local-dir', express.json(), async (req, res) => {
  const dir = String((req.body && req.body.dir) || '').trim();
  if (process.env.LATEX_IDE_LOCAL) return res.status(409).json({ error: 'Ordner ist per Umgebungsvariable LATEX_IDE_LOCAL festgelegt.' });
  if (!dir || !path.isAbsolute(dir)) return res.status(400).json({ error: 'Bitte einen absoluten Pfad angeben.' });
  const target = path.resolve(dir);
  if (target === LOCAL_DIR) return res.json({ ok: true, localDir: LOCAL_DIR, moved: 0 });
  const rel = (a, b) => b === a || b.startsWith(a + path.sep);
  if (rel(LOCAL_DIR, target) || rel(target, LOCAL_DIR)) return res.status(400).json({ error: 'Alter und neuer Ordner dürfen sich nicht überschneiden.' });
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    return res.status(400).json({ error: 'Der Zielordner muss leer oder neu sein.' });
  }
  if (moving) return res.status(409).json({ error: 'Verschieben läuft bereits.' });
  moving = true;
  try {
    await syncing; // let a running sync finish, then wait for queued per-project syncs
    await syncLock;
    const names = owned.map((p) => path.basename(localDirOf(p)));
    const moved = moveDir(LOCAL_DIR, target, names);
    const old = LOCAL_DIR;
    LOCAL_DIR = target;
    config = { ...config, localDir: target };
    writeJson(CONFIG_PATH, config);
    if (current && current.owned && current.dir.startsWith(old + path.sep)) {
      current = { ...current, dir: path.join(target, path.relative(old, current.dir)) };
      writeJson(path.join(MIRROR_DIR, 'current.json'), current);
    }
    res.json({ ok: true, localDir: target, moved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    moving = false;
  }
});

// --- auto-update from the server ---
// The server offers the desktop build of its own version (fetched from GitHub,
// see server/lib/desktopAssets.js), so app and server always match.

// '0.2.0' > '0.1.9'; ignores a leading v.
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

const UPDATE_OS = { win32: 'windows', darwin: 'macos' }[process.platform];

let latest = null; // version offered by the server
app.get('/api/desktop/update', async (req, res) => {
  try {
    if (!config.token) throw new Error('nicht angemeldet');
    const rel = await remoteJson('/api/desktop/release');
    latest = UPDATE_OS && rel[UPDATE_OS] ? rel.version : null;
    res.json({ available: !!latest && newer(latest, APP_VERSION), version: rel.version, current: APP_VERSION });
  } catch (e) {
    res.json({ available: false, current: APP_VERSION, error: e.message }); // offline / no release yet: stay quiet
  }
});

// Windows: downloads the setup to Temp, starts it silently (keeps the chosen dirs, restarts the app)
// and exits, so the installer can replace node.exe and the server files.
// macOS: unpacks the ZIP over ~/Applications/LatexIDE/app (node/ and install.json stay) and
// restarts via the LatexIDE.command starter that install.command created one level up.
app.post('/api/desktop/update/install', async (req, res) => {
  if (!latest) return res.status(400).json({ error: 'Kein Update bekannt.' });
  try {
    const r = await fetch(`${REMOTE}/api/desktop/download/${UPDATE_OS}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(900000),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (process.platform === 'darwin') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latexide-update-'));
      const zip = path.join(tmp, 'update.zip');
      fs.writeFileSync(zip, buf);
      execFileSync('ditto', ['-x', '-k', zip, path.join(tmp, 'x')]);
      const appDir = path.join(__dirname, '..');
      for (const name of fs.readdirSync(path.join(tmp, 'x'))) {
        if (name === 'install.command') continue;
        fs.rmSync(path.join(appDir, name), { recursive: true, force: true });
        fs.cpSync(path.join(tmp, 'x', name), path.join(appDir, name), { recursive: true });
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      const starter = path.join(appDir, '..', 'LatexIDE.command');
      spawn('/bin/bash', ['-c', 'sleep 2; exec /bin/bash "$0"', starter], { detached: true, stdio: 'ignore' }).unref();
      res.json({ ok: true });
      return setTimeout(() => process.exit(0), 500);
    }
    const exe = path.join(os.tmpdir(), `LatexIDE-Setup-${latest}.exe`);
    fs.writeFileSync(exe, buf);
    spawn(exe, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Only forgets the token locally - the server-side entry can be revoked in
// the web UI (Profil → Verbundene Desktop-Apps).
app.post('/api/auth/logout', (req, res) => {
  setToken(null);
  res.json({ ok: true });
});

// Lokaler LanguageTool (nur Loopback): der Proxy umgeht CORS/Mixed Content des Browsers.
app.post('/api/languagetool-local', express.json({ limit: '2mb' }), async (req, res) => {
  let u;
  try { u = new URL(String(req.body.url)); } catch { return res.status(400).json({ error: 'Ungültige Adresse.' }); }
  if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    return res.status(400).json({ error: 'Nur lokale Adressen (localhost) erlaubt.' });
  }
  const language = /^[a-z]{2}(-[A-Z]{2})?$/.test(req.body.language) ? req.body.language : 'auto';
  try {
    const r = await fetch(u.origin + u.pathname.replace(/\/+$/, '') + '/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: String(req.body.data || ''), language }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`LanguageTool antwortet mit ${r.status}.`);
    res.json({ matches: (await r.json()).matches || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use('/api', (req, res, next) => {
  if (!config.token) return res.status(401).json({ error: 'Desktop-App nicht angemeldet.', desktopLogin: true });
  next();
});

// --- local compile ---

let current = readJson(path.join(MIRROR_DIR, 'current.json'), null); // { projectId, dir, mainFile, settings, owned }
const wordCounts = new Map();

// --- offline copy of owned projects ---

let owned = readJson(path.join(SYNC_DIR, 'owned.json'), []); // [{ name, projectId }]
const syncKey = (id) => String(id).replace(/[^\w-]/g, '_');
const ownedEntry = (projectId) => owned.find((p) => p.projectId === projectId);
const localDirOf = (p) => path.join(LOCAL_DIR, p.name.replace(/[<>:"/\\|?*]/g, '_'));

// One sync at a time: the periodic run and a compile must not touch a folder together.
let syncLock = Promise.resolve();
function syncOwned(p) {
  const run = syncLock.then(() => syncOwnedNow(p));
  syncLock = run.catch(() => {});
  return run;
}

async function syncOwnedNow(p) {
  const q = `project=${encodeURIComponent(p.projectId)}`;
  const need = async (res, what) => {
    if (!res.ok) throw new Error(`${what} fehlgeschlagen (HTTP ${res.status})`);
    return res;
  };
  const dir = localDirOf(p);
  fs.mkdirSync(dir, { recursive: true });
  const r = await syncFolder(dir, path.join(SYNC_DIR, syncKey(p.projectId) + '.json'), {
    manifest: () => remoteJson(`/api/collab/manifest?${q}`),
    download: async (rel) => Buffer.from(await (await need(await remote(`/api/raw?${q}&path=${encodeURIComponent(rel)}`), rel)).arrayBuffer()),
    upload: async (rel, buf) =>
      need(await remote(`/api/collab/raw?${q}&path=${encodeURIComponent(rel)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf }), rel),
    remove: async (rel) => need(await remote(`/api/collab/raw?${q}&path=${encodeURIComponent(rel)}`, { method: 'DELETE' }), rel),
  });
  if (r.conflicts.length) console.log(`Offline-Konflikte in ${p.name}: ${r.conflicts.join(', ')} (lokale Fassung als *.offline-konflikt.* abgelegt)`);
  return { ...r, dir };
}

async function refreshOwned() {
  owned = (await remoteJson('/api/collab/owned')).projects;
  writeJson(path.join(SYNC_DIR, 'owned.json'), owned);
}

let syncing = null;
let moving = false; // folder move in progress: no sync
function syncAll() {
  if (syncing || moving || !config.token) return syncing;
  syncing = (async () => {
    try {
      await refreshOwned();
      for (const p of owned) {
        try {
          await syncOwned(p);
        } catch (e) {
          if (e instanceof Offline) throw e;
          console.error(`Sync ${p.name}: ${e.message}`);
        }
      }
    } catch (e) {
      if (!(e instanceof Offline)) console.error('Sync:', e.message);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}
// Editor/server traffic on /ws and /yjs (own typing, other users, web) = something changed:
// pull the open owned project into the local copy 2 s after the first message (throttle, not
// debounce: steady typing/cursor traffic would otherwise postpone the sync forever).
let syncTimer = null;
function scheduleSync() {
  const own = online && !moving && current && current.owned && ownedEntry(current.projectId);
  if (!own || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncOwned(own).catch((e) => {
      if (!(e instanceof Offline)) console.error(`Sync ${own.name}: ${e.message}`);
    });
  }, 2000);
}
fs.mkdirSync(SYNC_DIR, { recursive: true });
setInterval(syncAll, 60 * 1000);
setTimeout(syncAll, 2000);

// Bring the mirror of the active project up to date: fetch changed files,
// drop removed ones. Offline: keep using the last mirror.
async function syncMirror() {
  let man;
  try {
    man = await remoteJson('/api/collab/manifest');
  } catch (e) {
    if (e instanceof Offline && current) return current;
    throw e;
  }
  // Own project: compile straight in the offline copy (after a two-way sync).
  if (!ownedEntry(man.projectId)) await refreshOwned(); // new project or first run after login
  const own = ownedEntry(man.projectId);
  if (own) {
    const r = await syncOwned(own);
    current = { projectId: man.projectId, dir: r.dir, mainFile: r.mainFile, settings: r.settings, owned: true };
    writeJson(path.join(MIRROR_DIR, 'current.json'), current);
    return current;
  }
  const dir = path.join(MIRROR_DIR, String(man.projectId).replace(/[^\w-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, '.mirror.json');
  const index = readJson(indexPath, {}); // rel -> sha1 of what we wrote
  const wanted = new Set();
  const todo = [];
  for (const f of man.files) {
    const abs = inside(dir, f.path);
    wanted.add(f.path);
    if (index[f.path] !== f.sha1 || !fs.existsSync(abs)) todo.push(f);
  }
  // ponytail: 6 parallel downloads, whole files - chunked/rsync-like transfer if projects get huge
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(
      todo.slice(i, i + 6).map(async (f) => {
        const res = await remote(`/api/raw?path=${encodeURIComponent(f.path)}`);
        if (!res.ok) throw new Error(`Download fehlgeschlagen: ${f.path} (HTTP ${res.status})`);
        const abs = inside(dir, f.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(await res.arrayBuffer()));
        index[f.path] = f.sha1;
      })
    );
  }
  for (const rel of Object.keys(index)) {
    if (wanted.has(rel)) continue;
    fs.rmSync(inside(dir, rel), { force: true });
    delete index[rel];
  }
  writeJson(indexPath, index);
  current = { projectId: man.projectId, dir, mainFile: man.mainFile, settings: man.settings || {} };
  writeJson(path.join(MIRROR_DIR, 'current.json'), current);
  return current;
}

let compileChain = Promise.resolve();

app.post('/api/compile', express.json({ limit: '50mb' }), (req, res) => {
  const run = compileChain.then(async () => {
    const proj = await syncMirror();
    if (!proj.mainFile) return { status: 400, body: { error: 'Keine .tex-Hauptdatei gefunden.' } };
    // Open editor texts are newer than the server copy (or the server is unreachable).
    // They reach the server through Yjs, so the next sync takes the server's version.
    const indexPath = proj.owned ? path.join(SYNC_DIR, syncKey(proj.projectId) + '.json') : path.join(proj.dir, '.mirror.json');
    const index = readJson(indexPath, {});
    for (const [rel, text] of Object.entries((req.body && req.body.overrides) || {})) {
      const abs = inside(proj.dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(text));
      index[rel] = proj.owned ? 'ide' : 'local'; // forces a re-download on the next online sync
    }
    writeJson(indexPath, index);
    const result = await compile(proj.dir, proj.mainFile, proj.settings);
    if (result.pdfPath) {
      try {
        wordCounts.set(proj.dir, wordcount.countWords(proj.dir, proj.mainFile));
      } catch {}
    }
    return { status: 200, body: result };
  });
  compileChain = run.catch(() => {});
  run.then(
    ({ status, body }) => res.status(status).json(body),
    (e) => res.status(e.status || 500).json({ error: e.message })
  );
});

function requireCurrent(res) {
  if (!current) {
    res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
    return null;
  }
  return current;
}

app.post('/api/compile/clear-cache', (req, res) => {
  const proj = requireCurrent(res);
  if (!proj) return;
  fs.rmSync(path.join(proj.dir, OUT_DIR), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/pdf', (req, res) => {
  const proj = requireCurrent(res);
  if (!proj) return;
  try {
    const abs = inside(proj.dir, req.query.path);
    if (!fs.existsSync(abs)) throw new Error('Datei nicht gefunden.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/wordcount', (req, res) => {
  const stats = current && wordCounts.get(current.dir);
  if (!stats) return res.status(404).json({ error: 'File not found or not readable.' });
  res.json(stats);
});

function mainPdf(proj) {
  const abs = path.join(proj.dir, OUT_DIR, proj.mainFile.replace(/\.tex$/i, '.pdf'));
  return fs.existsSync(abs) ? abs : null;
}

app.get('/api/synctex/forward', async (req, res) => {
  const proj = requireCurrent(res);
  if (!proj) return;
  const { file, line } = req.query;
  const pdf = mainPdf(proj);
  if (!file || !line) return res.status(400).json({ error: 'file und line sind erforderlich.' });
  if (!pdf) return res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
  try {
    res.json(await synctex.forward(pdf, inside(proj.dir, file), line, proj.dir));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/synctex/inverse', async (req, res) => {
  const proj = requireCurrent(res);
  if (!proj) return;
  const { page, x, y } = req.query;
  const pdf = mainPdf(proj);
  if (!page || x === undefined || y === undefined) return res.status(400).json({ error: 'page, x und y sind erforderlich.' });
  if (!pdf) return res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
  try {
    const { inputAbs, line } = await synctex.inverse(pdf, page, x, y, proj.dir);
    const abs = path.resolve(inputAbs.replace(/\//g, path.sep));
    res.json({ file: path.relative(proj.dir, abs).split(path.sep).join('/'), line });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- offline: tree/files of the own project straight from the local copy ---

// Project opened from the offline copy: after reconnecting the server must switch to it too,
// or the client would load the project that was active before.
let offlineOpened = null;
async function reopenOnServer() {
  const name = offlineOpened;
  offlineOpened = null;
  const cached = name && readJson(cacheFile('/api/projects/list'), null);
  const root = cached && (JSON.parse(cached.body).localProjects || []).find((p) => p.name === name)?.root;
  if (root) await remote('/api/projects/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }) }).catch(() => {});
}

// Offline dashboard: all owned projects from the local copy (shared ones stay as cached, but can't be opened).
function serveOfflineProjects(req, res) {
  const route = req.baseUrl + req.path;
  if (online || !owned.length || !['/api/projects/list', '/api/projects/open'].includes(route)) return false;
  const have = owned.filter((p) => fs.existsSync(localDirOf(p)));
  res.setHeader('X-Offline', '1');
  if (req.method === 'GET' && route === '/api/projects/list') {
    const cached = readJson(cacheFile(req.originalUrl), null);
    const base = cached ? JSON.parse(cached.body) : { labels: { labels: [], assign: {} }, labelColors: [] };
    res.json({
      ...base,
      activeRoot: current && current.owned ? current.dir : null,
      localProjects: have.map((p) => ({ name: p.name, root: localDirOf(p), lastModified: fs.statSync(localDirOf(p)).mtimeMs })),
    });
    return true;
  }
  if (req.method !== 'POST' || route !== '/api/projects/open') return false;
  let root = '';
  try {
    root = path.resolve(JSON.parse(req.body.toString('utf8')).root);
  } catch {}
  const p = have.find((x) => path.resolve(localDirOf(x)) === root);
  if (!p) {
    res.status(503).json({ error: 'Offline: Geteilte Projekte lassen sich nur mit Verbindung zum Server öffnen.', offline: true });
    return true;
  }
  const dir = localDirOf(p);
  const mainFile = findMainCandidate(dir);
  current = { projectId: p.projectId, dir, mainFile, settings: {}, owned: true };
  writeJson(path.join(MIRROR_DIR, 'current.json'), current);
  offlineOpened = p.name;
  res.json({ activeRoot: dir, mainFile, startFile: pickStartFile(dir), projectId: p.projectId, role: 'owner' });
  return true;
}

function offlineCopy() {
  return !online && current && current.owned && fs.existsSync(current.dir) ? current : null;
}

const LOCAL_GETS = new Set(['/api/tree', '/api/file', '/api/raw']);

// Answers from the offline copy; false = not applicable (other route/project).
function serveLocal(req, res) {
  if (serveOfflineProjects(req, res)) return true;
  const c = offlineCopy();
  if (!c || req.method !== 'GET' || !LOCAL_GETS.has(req.baseUrl + req.path)) return false;
  res.setHeader('X-Offline', '1');
  if (req.baseUrl + req.path === '/api/tree') {
    res.json({ tree: buildTree(c.dir), mainFile: c.mainFile, projectId: c.projectId });
    return true;
  }
  try {
    const abs = inside(c.dir, req.query.path);
    if (req.baseUrl + req.path === '/api/raw') {
      res.sendFile(abs, { headers: { 'Cache-Control': 'no-store' } });
      return true;
    }
    const buf = fs.readFileSync(abs);
    const text = isTextFile(req.query.path);
    res.json({ path: req.query.path, content: text ? buf.toString('utf8') : buf.toString('base64'), binary: !text });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
  return true;
}

// --- everything else: forward to the server, cache GETs for offline use ---

// ponytail: cache key is the URL only - the server's "active project" is
// per user, so offline you see the last project's tree/comments; fine as
// long as offline work stays within one project.
const cacheFile = (url) => path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
const checkedOwn = new Set();
const FORWARD_REQ = ['content-type', 'accept'];
const FORWARD_RES = ['content-type', 'content-disposition', 'cache-control'];

app.use('/api', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  if (serveLocal(req, res)) return; // known offline: don't wait for the remote timeout
  const url = req.originalUrl;
  const headers = {};
  for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
  try {
    const r = await remote(url, { method: req.method, headers, body: hasBody ? req.body : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status === 401) return res.status(401).json({ error: 'Desktop-Anmeldung abgelaufen.', desktopLogin: true });
    for (const h of FORWARD_RES) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    if (req.method === 'GET' && r.ok && (r.headers.get('content-type') || '').includes('application/json')) {
      writeJson(cacheFile(url), { contentType: r.headers.get('content-type'), body: buf.toString('utf8') });
    }
    // Remember which own project is open, so offline the tree comes from its copy.
    if (req.method === 'GET' && r.ok && req.path === '/tree') {
      try {
        const { projectId, mainFile } = JSON.parse(buf.toString('utf8'));
        // first time we see this project: the owned list may predate it (first start, new project)
        if (!ownedEntry(projectId) && !checkedOwn.has(projectId)) {
          checkedOwn.add(projectId);
          await refreshOwned().catch(() => {});
        }
        const own = ownedEntry(projectId);
        if (own && (!current || current.projectId !== projectId)) {
          current = { projectId, dir: localDirOf(own), mainFile, settings: {}, owned: true };
          writeJson(path.join(MIRROR_DIR, 'current.json'), current);
        }
      } catch {}
    }
    res.status(r.status).end(buf);
  } catch (e) {
    if (!(e instanceof Offline)) return res.status(500).json({ error: e.message });
    if (serveLocal(req, res)) return;
    const cached = req.method === 'GET' && readJson(cacheFile(url), null);
    if (!cached) return res.status(503).json({ error: 'Server nicht erreichbar (offline).', offline: true });
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('X-Offline', '1');
    res.end(cached.body);
  }
});

// --- static client ---

app.get('/', (req, res, next) => (config.token ? next() : res.redirect('/desktop/login')));
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/dist', express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use('/katex', express.static(path.join(__dirname, '..', 'node_modules', 'katex', 'dist')));

// --- websockets (/ws, /yjs) ---

const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({ target: REMOTE, changeOrigin: true, ws: true, secure: true });
proxy.on('open', (proxySocket) => proxySocket.on('data', scheduleSync));
proxy.on('error', (err, req, socket) => {
  if (socket && socket.destroy) socket.destroy(); // client reconnects on its own
});

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (!config.token || !LOCAL_ORIGINS.has(req.headers.origin) || !(p === '/ws' || p.startsWith('/yjs/'))) {
    return socket.destroy();
  }
  if (!online) return socket.destroy(); // offline: fail fast, the client retries
  wsSockets.add(socket);
  socket.on('close', () => wsSockets.delete(socket));
  delete req.headers.cookie;
  proxy.ws(req, socket, head, { headers: { authorization: `Bearer ${config.token}`, origin: new URL(REMOTE).origin } });
  socket.on('data', scheduleSync);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LaTeX IDE Desktop: http://localhost:${PORT}  (Server: ${REMOTE}, Daten: ${DATA})`);
});
