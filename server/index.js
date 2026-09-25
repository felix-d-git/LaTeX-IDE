require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const archiver = require('archiver');

const { buildTree, isTextFile, safeResolve, isIgnored } = require('./lib/fsTree');
const { compile, findMainCandidate, OUT_DIR } = require('./lib/compile');
const { searchProject, replaceInProject } = require('./lib/search');
const { startWatcher } = require('./lib/watcher');
const projects = require('./lib/projects');
const treeOps = require('./lib/treeOps');
const comments = require('./lib/comments');
const history = require('./lib/history');
const synctex = require('./lib/synctex');
const wordcount = require('./lib/wordcount');
const state = require('./state');
const auth = require('./lib/auth');
const mailer = require('./lib/mailer');
const authMw = require('./lib/authMiddleware');

const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function activeMainPdfAbs(root) {
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return null;
  return path.join(root, OUT_DIR, main.replace(/\.tex$/i, '.pdf'));
}

const PORT = process.env.PORT || 3077;
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(authMw.createSessionMiddleware());
app.use(authMw.ensureCsrfCookie);
app.use(authMw.checkCsrf);
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/dist', express.static(path.join(__dirname, '..', 'client', 'dist')));

let wss = null;
const lastAutocompileAt = new Map(); // root -> timestamp, throttles autocompile-on-save
const AUTOCOMPILE_THROTTLE_MS = 5000;
const wordCountByRoot = new Map(); // root -> { words, headers, mathInline, mathDisplay }, refreshed on each successful compile

function maybeAutocompile(root) {
  const settings = state.getProjectSettings(root);
  if (!settings.autocompile) return;
  const last = lastAutocompileAt.get(root) || 0;
  if (Date.now() - last < AUTOCOMPILE_THROTTLE_MS) return;
  lastAutocompileAt.set(root, Date.now());
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return;
  runCompile(root, main).catch(() => {});
}

// Multiple users can have different projects open at the same time, so
// broadcasts and file watchers must be scoped per project root instead of
// the single global watcher/broadcast-to-everyone the tool used as a
// single-user MVP. Each ws client only receives events for the root that is
// currently that connection's user's active project (looked up live, not
// cached, so switching projects takes effect immediately).
const watchersByRoot = new Map(); // root -> { watcher, refCount }

function broadcast(root, msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.userId && state.getActiveRoot(client.userId) === root) {
      client.send(data);
    }
  });
}

function requireRoot(req, res) {
  const root = state.getActiveRoot(req.user.id);
  if (!root || !fs.existsSync(root)) {
    res.status(400).json({ error: 'Kein aktives Projekt geoeffnet.' });
    return null;
  }
  return root;
}

function ensureWatcher(root) {
  const entry = watchersByRoot.get(root);
  if (entry) {
    entry.refCount += 1;
    return;
  }
  watchersByRoot.set(root, { watcher: startWatcher(root, (msg) => broadcast(root, msg)), refCount: 1 });
}

function releaseWatcher(root) {
  const entry = watchersByRoot.get(root);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.watcher.close();
    watchersByRoot.delete(root);
  }
}

// Admin keeps using the pre-existing top-level projects/ folder as-is (so the
// real Bachelorarbeit project doesn't need to move); every other, newly
// invited user gets their own isolated subfolder so accounts can't see each
// other's files.
function userProjectsDir(user) {
  if (user.isAdmin) return PROJECTS_DIR;
  const dir = path.join(PROJECTS_DIR, 'users', user.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Auth (public - no login required) ---

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

app.post('/api/auth/register', async (req, res) => {
  const { token, email, password } = req.body;
  const invite = auth.getValidInvite(token || '');
  if (!invite) return res.status(400).json({ error: 'Der Einladungslink ist ungültig, abgelaufen oder bereits verwendet.' });
  try {
    const user = await auth.createUser({ email, password, isAdmin: false });
    auth.consumeInvite(token, user.id);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
      req.session.userId = user.id;
      authMw.applyRememberMe(req, true);
      res.json({ user: auth.toPublicUser(user) });
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const user = auth.findUserByEmail(email || '');
  const ok = user && (await auth.verifyPassword(user, password));
  if (!ok) return res.status(401).json({ error: 'E-Mail oder Passwort falsch.' });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
    req.session.userId = user.id;
    authMw.applyRememberMe(req, !!rememberMe);
    res.json({ user: auth.toPublicUser(user) });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('latex_ide_sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = req.session && req.session.userId ? auth.findUserById(req.session.userId) : null;
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ user: auth.toPublicUser(user) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const user = auth.findUserByEmail(req.body.email || '');
  // Always answer the same way, whether or not the address is registered -
  // otherwise the endpoint would leak which e-mails have an account.
  if (user) {
    const token = auth.createResetToken(user.id);
    const link = `${baseUrl(req)}/?reset=${token}`;
    await mailer.sendMail({
      to: user.email,
      subject: 'LaTeX Web IDE - Passwort zurücksetzen',
      text: `Zum Zurücksetzen deines Passworts auf diesen Link klicken (gültig 1 Stunde):\n${link}`,
    });
  }
  res.json({ ok: true, message: 'Falls diese E-Mail-Adresse registriert ist, wurde ein Link zum Zurücksetzen verschickt.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  const user = auth.consumeResetToken(token || '');
  if (!user) return res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte erneut "Passwort vergessen" anfordern.' });
  try {
    await auth.setPassword(user, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Admin: invite links (self-registration is invite-gated, no open signup) ---

app.post('/api/admin/invites', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  const token = auth.createInvite(req.user.id);
  res.json({ token, url: `${baseUrl(req)}/?invite=${token}` });
});

app.get('/api/admin/invites', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  const invites = auth.listInvites().map((i) => ({
    token: i.token,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedByEmail: i.usedBy ? (auth.findUserById(i.usedBy) || {}).email || null : null,
    expired: !i.usedBy && new Date(i.expiresAt).getTime() < Date.now(),
  }));
  res.json({ invites, baseUrl: baseUrl(req) });
});

app.delete('/api/admin/invites/:token', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  auth.revokeInvite(req.params.token);
  res.json({ ok: true });
});

// --- Everything below requires a logged-in user ---
app.use('/api', authMw.requireAuth);

// --- Projects ---

app.get('/api/projects/list', (req, res) => {
  const projectsDir = userProjectsDir(req.user);
  res.json({
    activeRoot: state.getActiveRoot(req.user.id),
    recentRoots: state.getRecentRoots(req.user.id),
    localProjects: projects.listProjects(projectsDir),
    trashedProjects: projects.listTrash(projectsDir),
    archivedProjects: projects.listArchived(projectsDir),
  });
});

// name comes from the URL (dashboard row), so resolve it the same way
// safeResolve() guards file paths against escaping the project root.
function resolveProjectRoot(projectsDir, name) {
  const root = path.resolve(path.join(projectsDir, name || ''));
  const projectsDirResolved = path.resolve(projectsDir);
  if (root !== projectsDirResolved && !root.startsWith(projectsDirResolved + path.sep)) {
    throw new Error('Ungültiger Projektname.');
  }
  return root;
}

app.post('/api/projects/open', (req, res) => {
  const { root } = req.body;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return res.status(400).json({ error: 'Ordner nicht gefunden.' });
  }
  // Non-admin users may only ever activate a project inside their own
  // isolated folder - otherwise they could type any local path (e.g. the
  // admin's thesis folder) into the "open folder" dialog and read/edit it.
  if (!req.user.isAdmin) {
    const projectsDirResolved = path.resolve(userProjectsDir(req.user));
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot !== projectsDirResolved && !resolvedRoot.startsWith(projectsDirResolved + path.sep)) {
      return res.status(403).json({ error: 'Kein Zugriff auf diesen Ordner.' });
    }
  }
  const previousRoot = state.getActiveRoot(req.user.id);
  state.setActiveRoot(req.user.id, root);
  if (previousRoot && previousRoot !== root) releaseWatcher(previousRoot);
  if (previousRoot !== root) ensureWatcher(root);
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (main) state.setMainFile(root, main);
  res.json({ activeRoot: root, mainFile: main });
});

app.post('/api/projects/create', (req, res) => {
  try {
    const root = projects.createProject(userProjectsDir(req.user), req.body.name || '');
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/rename', (req, res) => {
  const { oldName, newName } = req.body;
  const projectsDir = userProjectsDir(req.user);
  const root = path.join(projectsDir, oldName || '');
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses umbenannt wird.' });
  }
  try {
    const newRoot = projects.renameProject(projectsDir, oldName, newName);
    res.json({ root: newRoot });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/copy', (req, res) => {
  try {
    const root = projects.copyProject(userProjectsDir(req.user), req.body.name, req.body.newName);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/archive', (req, res) => {
  const { name } = req.body;
  const projectsDir = userProjectsDir(req.user);
  const root = path.join(projectsDir, name || '');
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses archiviert wird.' });
  }
  try {
    projects.archiveProject(projectsDir, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/unarchive', (req, res) => {
  try {
    const root = projects.unarchiveProject(userProjectsDir(req.user), req.body.name);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/projects/:name/download/zip', (req, res) => {
  let root;
  try {
    root = resolveProjectRoot(userProjectsDir(req.user), req.params.name);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(root)) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(root, false, (entry) => {
    const parts = entry.name.split('/');
    return parts.some((p) => isIgnored(p)) ? false : entry;
  });
  archive.finalize();
});

app.get('/api/projects/:name/download/pdf', (req, res) => {
  let root;
  try {
    root = resolveProjectRoot(userProjectsDir(req.user), req.params.name);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(root)) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return res.status(404).json({ error: 'Keine .tex-Hauptdatei gefunden.' });
  const pdfAbs = path.join(root, OUT_DIR, main.replace(/\.tex$/i, '.pdf'));
  if (!fs.existsSync(pdfAbs)) return res.status(404).json({ error: 'Noch kein PDF für dieses Projekt kompiliert.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.pdf"`);
  fs.createReadStream(pdfAbs).pipe(res);
});

app.post('/api/projects/trash', (req, res) => {
  const { name } = req.body;
  const projectsDir = userProjectsDir(req.user);
  const root = path.join(projectsDir, name || '');
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses in den Papierkorb verschoben wird.' });
  }
  try {
    projects.trashProject(projectsDir, name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/restore', (req, res) => {
  try {
    const root = projects.restoreProject(userProjectsDir(req.user), req.body.name);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/projects/trash/:name', (req, res) => {
  try {
    projects.deleteProjectPermanently(userProjectsDir(req.user), req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- File tree / content ---

app.get('/api/tree', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ tree: buildTree(root), mainFile: state.getMainFile(root) });
});

app.get('/api/file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    if (isTextFile(req.query.path)) {
      res.json({ path: req.query.path, content: fs.readFileSync(abs, 'utf8'), binary: false });
    } else {
      const buf = fs.readFileSync(abs);
      res.json({ path: req.query.path, content: buf.toString('base64'), binary: true });
    }
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const { path: relPath, content } = req.body;
    const abs = safeResolve(root, relPath);
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    state.selfWrittenHashes.set(relPath, hash);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    history.snapshot(root, { trigger: 'autosave' });
    maybeAutocompile(root);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tree/folder', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const relPath = treeOps.createFolder(root, req.body.path);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tree/file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const relPath = treeOps.createFile(root, req.body.path);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tree/rename', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const relPath = treeOps.renamePath(root, req.body.path, req.body.newName);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Drag&drop move within the file tree (distinct from /api/tree/rename, which
// only renames in place). Responds 409 with conflict:true if the destination
// already has an entry with that name and overwrite wasn't set, so the
// client can ask "cancel or overwrite" and resubmit with overwrite:true.
app.post('/api/tree/move', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const relPath = treeOps.movePath(root, req.body.path, req.body.targetDir, !!req.body.overwrite);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    if (e.conflict) return res.status(409).json({ conflict: true, error: e.message });
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/tree', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    treeOps.deletePath(root, req.query.path);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Drag&drop upload from the OS file explorer into a folder in the tree -
// bytes arrive base64-encoded in the JSON body (client reads via FileReader).
app.post('/api/tree/upload', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const relPath = treeOps.uploadFile(root, req.body.dir, req.body.name, req.body.content);
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/main-file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  state.setMainFile(root, req.body.path);
  res.json({ ok: true });
});

// --- Compile ---

async function runCompile(root, main) {
  broadcast(root, { type: 'compileStatus', status: 'running' });
  const result = await compile(root, main, state.getProjectSettings(root));
  const status = result.success ? 'success' : result.pdfPath ? 'warning' : 'error';
  broadcast(root, { type: 'compileStatus', status, log: result.log });
  if (result.pdfPath) broadcast(root, { type: 'pdfChanged', path: result.pdfPath });
  history.snapshot(root, { trigger: 'compile' });
  if (result.pdfPath) {
    try {
      wordCountByRoot.set(root, wordcount.countWords(root, main));
    } catch (e) {
      // best-effort - word count just stays unavailable for this root
    }
  }
  return result;
}

app.post('/api/compile', async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return res.status(400).json({ error: 'Keine .tex-Hauptdatei gefunden.' });
  const result = await runCompile(root, main);
  res.json(result);
});

// --- Settings ---

app.get('/api/wordcount', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const stats = wordCountByRoot.get(root);
  if (!stats) return res.status(404).json({ error: 'File not found or not readable.' });
  res.json(stats);
});

app.get('/api/settings', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ settings: state.getProjectSettings(root) });
});

app.post('/api/settings', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { compiler, stopOnFirstError, autocompile } = req.body;
  const patch = {};
  if (compiler !== undefined) patch.compiler = compiler;
  if (stopOnFirstError !== undefined) patch.stopOnFirstError = !!stopOnFirstError;
  if (autocompile !== undefined) patch.autocompile = !!autocompile;
  res.json({ settings: state.setProjectSettings(root, patch) });
});

app.get('/api/pdf', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Raw byte stream for previewing arbitrary project files (images, reference
// PDFs) in a tab - unlike /api/file (base64 JSON), this is a direct stream
// so <img>/<iframe> can point straight at the URL.
app.get('/api/raw', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    const ext = path.extname(abs).toLowerCase();
    res.setHeader('Content-Type', RAW_MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Download the whole project as a .zip (File -> Download -> Source in the
// Overleaf-style menu bar), skipping the same generated/hidden dirs the file
// tree already hides (fsTree.isIgnored).
app.get('/api/download/zip', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const name = path.basename(root) || 'project';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(root, false, (entry) => {
    const parts = entry.name.split('/');
    return parts.some((p) => isIgnored(p)) ? false : entry;
  });
  archive.finalize();
});

// --- SyncTeX (code <-> PDF position) ---

app.get('/api/synctex/forward', async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { file, line } = req.query;
  if (!file || !line) return res.status(400).json({ error: 'file und line sind erforderlich.' });
  const pdfAbs = activeMainPdfAbs(root);
  if (!pdfAbs || !fs.existsSync(pdfAbs)) {
    return res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
  }
  try {
    const texAbs = safeResolve(root, file);
    const result = await synctex.forward(pdfAbs, texAbs, line, root);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/synctex/inverse', async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { page, x, y } = req.query;
  if (!page || x === undefined || y === undefined) {
    return res.status(400).json({ error: 'page, x und y sind erforderlich.' });
  }
  const pdfAbs = activeMainPdfAbs(root);
  if (!pdfAbs || !fs.existsSync(pdfAbs)) {
    return res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
  }
  try {
    const { inputAbs, line } = await synctex.inverse(pdfAbs, page, x, y, root);
    const abs = path.resolve(inputAbs.replace(/\//g, path.sep));
    const file = path.relative(root, abs).split(path.sep).join('/');
    res.json({ file, line });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Comments ---

app.get('/api/comments', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ comments: comments.listAll(root) });
});

app.post('/api/comments', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { path: relPath, from, to, anchorText, text } = req.body;
  if (!relPath || typeof from !== 'number' || typeof to !== 'number' || !text || !text.trim()) {
    return res.status(400).json({ error: 'path, from, to und text sind erforderlich.' });
  }
  const comment = comments.add(root, relPath, { from, to, anchorText, text: text.trim() });
  broadcast(root, { type: 'commentsChanged', path: relPath });
  res.json({ comment });
});

app.delete('/api/comments/:id', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path ist erforderlich.' });
  const ok = comments.remove(root, relPath, req.params.id);
  if (ok) broadcast(root, { type: 'commentsChanged', path: relPath });
  res.json({ ok });
});

// --- Verlauf / History ---

app.get('/api/history', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ entries: history.list(root) });
});

app.post('/api/history/label', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { id, name } = req.body;
  if (!id || !name || !name.trim()) return res.status(400).json({ error: 'id und name sind erforderlich.' });
  try {
    const entry = history.addLabel(root, id, name.trim());
    res.json({ entry });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/history/diff', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { id, to, file } = req.query;
  if (!id || !to || !file) return res.status(400).json({ error: 'id, to und file sind erforderlich.' });
  try {
    const parts = history.diffBetween(root, id, to, file);
    res.json({ parts });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Search / Replace ---

app.get('/api/search', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { q, regex, caseSensitive, wholeWord } = req.query;
  try {
    const results = searchProject(root, q, {
      regex: regex === 'true',
      caseSensitive: caseSensitive === 'true',
      wholeWord: wholeWord === 'true',
    });
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/replace', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { query, replacement, regex, caseSensitive, wholeWord } = req.body;
  try {
    const result = replaceInProject(root, query, replacement, { regex, caseSensitive, wholeWord });
    for (const f of result.changedFiles) {
      const content = fs.readFileSync(path.join(root, f.file), 'utf8');
      broadcast(root, { type: 'fileChanged', path: f.file, content, changedRanges: [], source: 'replace' });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const server = http.createServer(app);
wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const userId = await authMw.getUserIdFromUpgradeRequest(req);
  if (!userId) {
    ws.close();
    return;
  }
  ws.userId = userId;
});

// Creates the admin account on first boot (no users.json yet) from
// ADMIN_EMAIL/ADMIN_PASSWORD, and migrates the old single-user
// activeRoot/recentRoots from workspace.json onto that admin so they keep
// their previously open project instead of starting from an empty dashboard.
async function bootstrapAdmin() {
  if (auth.users.length > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn(
      '[auth] ADMIN_EMAIL/ADMIN_PASSWORD nicht gesetzt - lege Fallback-Admin admin@local.host / bitte-sofort-aendern an. ' +
        'UNBEDINGT direkt nach dem ersten Login das Passwort über "Passwort vergessen" ändern, oder die Umgebungsvariablen setzen und den Server neu starten.'
    );
  }
  const adminUser = await auth.createUser({
    email: email || 'admin@local.host',
    password: password || 'bitte-sofort-aendern',
    isAdmin: true,
  });
  state.migrateLegacyGlobalState(adminUser.id);
  console.log(`[auth] Admin-Konto angelegt: ${adminUser.email}`);
}

// Re-arm a watcher for every user's project that was still open before a
// restart (mirrors the old single-user startup behaviour, just per user).
function restoreWatchers() {
  for (const root of Object.values(state.workspace.activeRootByUser)) {
    if (root && fs.existsSync(root)) ensureWatcher(root);
  }
}

bootstrapAdmin()
  .then(() => {
    restoreWatchers();
    server.listen(PORT, () => {
      console.log(`LaTeX Web IDE laeuft auf http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Fehler beim Start (Admin-Bootstrap):', e);
    process.exit(1);
  });
