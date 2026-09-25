// Desktop app: serves the same web client on localhost, forwards everything
// to the shared server (REMOTE_URL) with the user's desktop token, and
// compiles locally against a mirror of the project - the Pi can't compile
// for everyone. Offline, cached GETs keep the UI usable, Yjs keeps editing
// alive in the browser's IndexedDB, and compiles use the last mirror plus the
// open editor texts the client sends along.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const { compile, OUT_DIR } = require('./lib/compile');
const synctex = require('./lib/synctex');
const wordcount = require('./lib/wordcount');

const PORT = Number(process.env.PORT) || 3178;
const REMOTE = (process.env.REMOTE_URL || 'https://latex.example.org').replace(/\/+$/, '');
const DATA = process.env.LATEX_IDE_DATA || path.join(__dirname, '..', 'desktop-data');
const CONFIG_PATH = path.join(DATA, 'config.json');
const CACHE_DIR = path.join(DATA, 'cache');
const MIRROR_DIR = path.join(DATA, 'mirror');
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

async function remote(pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
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
    throw new Offline(e.message);
  }
  // Funnel down / Pi off: Tailscale answers with 502/503/504 instead of a refused connection.
  if ([502, 503, 504].includes(res.status)) throw new Offline(`HTTP ${res.status}`);
  if (res.status === 401) setToken(null); // revoked or expired - log in again
  return res;
}

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
  res.redirect(`http://localhost:${PORT}/`);
});

app.get('/api/desktop/info', (req, res) => {
  res.json({ desktop: true, connected: !!config.token, remote: REMOTE });
});

// Only forgets the token locally - the server-side entry can be revoked in
// the web UI (Einstellungen → Account → Verbundene Desktop-Apps).
app.post('/api/auth/logout', (req, res) => {
  setToken(null);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!config.token) return res.status(401).json({ error: 'Desktop-App nicht angemeldet.', desktopLogin: true });
  next();
});

// --- local compile ---

let current = readJson(path.join(MIRROR_DIR, 'current.json'), null); // { projectId, dir, mainFile, settings }
const wordCounts = new Map();

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
    const index = readJson(path.join(proj.dir, '.mirror.json'), {});
    for (const [rel, text] of Object.entries((req.body && req.body.overrides) || {})) {
      const abs = inside(proj.dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(text));
      index[rel] = 'local'; // forces a re-download on the next online sync
    }
    writeJson(path.join(proj.dir, '.mirror.json'), index);
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

// --- everything else: forward to the server, cache GETs for offline use ---

// ponytail: cache key is the URL only - the server's "active project" is
// per user, so offline you see the last project's tree/comments; fine as
// long as offline work stays within one project.
const cacheFile = (url) => path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
const FORWARD_REQ = ['content-type', 'accept'];
const FORWARD_RES = ['content-type', 'content-disposition', 'cache-control'];

app.use('/api', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
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
    res.status(r.status).end(buf);
  } catch (e) {
    if (!(e instanceof Offline)) return res.status(500).json({ error: e.message });
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
proxy.on('error', (err, req, socket) => {
  if (socket && socket.destroy) socket.destroy(); // client reconnects on its own
});

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (!config.token || !LOCAL_ORIGINS.has(req.headers.origin) || !(p === '/ws' || p.startsWith('/yjs/'))) {
    return socket.destroy();
  }
  delete req.headers.cookie;
  proxy.ws(req, socket, head, { headers: { authorization: `Bearer ${config.token}`, origin: new URL(REMOTE).origin } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LaTeX IDE Desktop: http://localhost:${PORT}  (Server: ${REMOTE}, Daten: ${DATA})`);
});
