// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
// Relative DATA_DIR (.env.example: ./data) against the repo root, before any module reads it:
// otherwise project roots are relative here and absolute elsewhere (Yjs, sync) and never match.
if (process.env.DATA_DIR) process.env.DATA_DIR = require('path').resolve(__dirname, '..', process.env.DATA_DIR);
// Verschluesselter Datenspeicher: muss vor allen Modulen laufen, die DATA_DIR lesen.
const vault = require('./lib/vault');
vault.start();
{
  const dataErr = require('./lib/fsTree').dataDirError(process.env.DATA_DIR || require('path').join(__dirname, '..'));
  if (dataErr) {
    console.error(`[start] ${dataErr}`);
    process.exit(1);
  }
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const { ZipArchive } = require('archiver');

const { canonRel, buildTree, findByName, pickStartFile, isTextFile, safeResolve, isIgnored, decodeText, toUtf8Text, NOT_UTF8_MSG } = require('./lib/fsTree');
const { compile, findMainCandidate, OUT_DIR, BACKEND, pdfNameFor } = require('./lib/compile');
// tectonic has no openin_any=p: a document could \input other users' projects or auth-data.json.
if (BACKEND !== 'latexmk') throw new Error('TEX_BACKEND=tectonic ist nur für die Desktop-App erlaubt (liest Dateien außerhalb des Projekts).');
const { searchProject, collectRefs } = require('./lib/search');
const { startWatcher } = require('./lib/watcher');
const projects = require('./lib/projects');
const treeOps = require('./lib/treeOps');
const comments = require('./lib/comments');
const history = require('./lib/history');
const synctex = require('./lib/synctex');
const wordcount = require('./lib/wordcount');
const exporter = require('./lib/export');
const { fetchUrl } = require('./lib/fetchUrl');
const { createDesktopAssets } = require('./lib/desktopAssets');
const state = require('./state');
const auth = require('./lib/auth');
const mailer = require('./lib/mailer');
const authMw = require('./lib/authMiddleware');
const collab = require('./lib/collab');
const { createMcp } = require('./lib/mcp');
const legal = require('./lib/legal');

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

// compileMode 'individual' (default): every user compiles into their own
// subfolder and only sees their own PDF; 'group': one shared output for all.
function outRelFor(root, userId) {
  return state.getProjectSettings(root).compileMode === 'group' ? OUT_DIR : path.join(OUT_DIR, `u-${userId}`);
}

// Saved main file, repaired if it was renamed/moved/deleted meanwhile: falls back to the auto-detected one (and saves it).
function mainFileOf(root) {
  const saved = state.getMainFile(root);
  if (saved) {
    try {
      if (fs.statSync(safeResolve(root, saved)).isFile()) return saved;
    } catch {}
  }
  let found = null;
  try {
    found = findMainCandidate(root) || null;
  } catch {}
  if (found !== saved) state.setMainFile(root, found);
  return found;
}

function activeMainPdfAbs(root, userId) {
  const main = mainFileOf(root);
  if (!main) return null;
  return path.join(root, outRelFor(root, userId), pdfNameFor(main));
}

const PORT = process.env.PORT || 3077;
const PROJECTS_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..'), 'projects');

const app = express();
// Express 4 ignores rejected promises of async handlers (Node then kills the process) -> pass them on to the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Behind Tailscale Funnel/serve: real client IP (rate limits) + https for baseUrl.
app.set('trust proxy', 'loopback, uniquelocal');
// Marks every answer as coming from the app itself: the desktop app treats 502-504 only without it
// (= tunnel/proxy, server unreachable) as offline, not e.g. a LanguageTool failure.
app.use((req, res, next) => {
  res.setHeader('X-Latex-IDE', '1');
  next();
});
// Container-Healthcheck: vor der Session-Middleware, damit die Probe keine Sitzungen anlegt.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
// Lokal ohne Login: nur Anfragen an localhost annehmen (sonst könnte eine Webseite per DNS-Rebinding mitlesen).
if (authMw.LOCAL_MODE) {
  app.use((req, res, next) => (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '') ? next() : res.status(403).end()));
}
app.use(express.json({ limit: '50mb' }));
// Express 5 leaves req.body undefined without a body; the routes destructure it.
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use(cookieParser());
app.use(authMw.createSessionMiddleware());
app.use(authMw.ensureCsrfCookie);
app.use(authMw.checkCsrf);
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/dist', express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use('/katex', express.static(path.join(__dirname, '..', 'node_modules', 'katex', 'dist')));
// Lizenzhinweise (MIT/BSD-Pflicht auch für das an den Browser gelieferte Bundle) und Quellcode (AGPL §13), ohne Login.
app.get('/licenses', (req, res) => {
  res.type('text/plain; charset=utf-8').send(legal.licensesText());
});
app.get('/source', (req, res) => res.redirect(legal.SOURCE_LINK));

// Fehlende/gesperrte Datei beim Streamen: 404 statt unbehandeltem Stream-Fehler (Server-Absturz).
function streamFile(res, abs) {
  fs.createReadStream(abs)
    .on('error', () => {
      if (res.headersSent) return res.destroy();
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(404).json({ error: 'Datei nicht gefunden.' });
    })
    .pipe(res);
}

let wss = null;
const lastAutocompileAt = new Map(); // root -> timestamp, throttles autocompile-on-save
const AUTOCOMPILE_THROTTLE_MS = 5000;
const wordCountByOut = new Map(); // abs output dir -> { words, headers, mathInline, mathDisplay }, refreshed on each successful compile

// userId = who saved; null (collab persist) = everyone who has the project open.
// Throttled calls are not dropped: the last one is replayed once the window is over.
const autocompileTimers = new Map(); // root -> timer of the pending trailing run
function maybeAutocompile(root, userId) {
  const settings = state.getProjectSettings(root);
  if (!settings.autocompile) return;
  const wait = AUTOCOMPILE_THROTTLE_MS - (Date.now() - (lastAutocompileAt.get(root) || 0));
  if (wait > 0) {
    if (!autocompileTimers.has(root)) {
      const t = setTimeout(() => {
        autocompileTimers.delete(root);
        maybeAutocompile(root, null);
      }, wait);
      t.unref();
      autocompileTimers.set(root, t);
    }
    return;
  }
  lastAutocompileAt.set(root, Date.now());
  const main = mainFileOf(root);
  if (!main) return;
  const users = userId ? [userId] : [...new Set([...(wss ? wss.clients : [])].filter((c) => c.userId && wsRoot(c) === root).map((c) => c.userId))];
  if (settings.compileMode === 'group') users.splice(1);
  for (const u of users) runCompile(root, main, u, undefined, { auto: true }).catch(() => {});
}

// Multiple users can have different projects open at the same time, so
// broadcasts and file watchers must be scoped per project root instead of
// the single global watcher/broadcast-to-everyone the tool used as a
// single-user MVP. Each ws client only receives events for the root that is
// project the window subscribed to ({type:'subscribe', projectId}), so several
// windows of one account can work in different projects at the same time.
const watchersByRoot = new Map(); // root -> { watcher, refCount }

// ws.root: undefined = never subscribed (old client: follows the user's last opened project),
// null = subscribed to nothing (project gone), else the subscribed root.
const wsRoot = (c) => (c.root === undefined ? state.getActiveRoot(c.userId) : c.root);

function wsSubscribe(ws, root) {
  if (wsRoot(ws) === root && ws.root !== undefined) return;
  if (ws.root) releaseWatcher(ws.root);
  ws.root = root;
  if (root) ensureWatcher(root);
}

// The project is gone for the windows showing it (moved, archived, deleted, share revoked):
// tell them and stop their events. userId = only that user's windows.
function kickRoot(root, userId) {
  if (!wss) return;
  const data = JSON.stringify({ type: 'projectGone', projectId: projectIdOf(root) });
  wss.clients.forEach((c) => {
    if (c.root !== root || (userId && c.userId !== userId)) return;
    if (c.readyState === 1) c.send(data);
    wsSubscribe(c, null);
  });
}

// onlyUserId: restrict to one user's connections (per-user compile events).
function broadcast(root, msg, onlyUserId) {
  if (!wss) return;
  // projectId: a window still showing another project (active project switched elsewhere) ignores it.
  const data = JSON.stringify({ ...msg, projectId: projectIdOf(root) });
  wss.clients.forEach((client) => {
    if (onlyUserId && client.userId !== onlyUserId) return;
    if (client.readyState === 1 && client.userId && wsRoot(client) === root) {
      client.send(data);
    }
  });
}

// A file/folder in the project was renamed/moved (newRel) or deleted (newRel = null) by the app:
// open editors and the comments follow it. Not for watcher events (external edits, desktop
// delete+put renames) - their comments stay and get re-attached by comments.listAll.
function pathMoved(root, oldRel, newRel) {
  collab.onPathMoved(root, oldRel, newRel);
  state.movePathInMainFile(root, oldRel, newRel);
  if (comments.movePath(root, oldRel, newRel)) broadcast(root, { type: 'commentsChanged', path: newRel || oldRel });
}

// The window's project: X-Project-Id / ?pid= (path below projects/), else the user's last opened one.
// ponytail: opening a project (POST /api/projects/open) only moves "last opened"; windows keep their pid.
function windowRoot(req) {
  const user = req.user;
  const pid = req.get('X-Project-Id') || req.query.pid;
  const gone = (status, error) => ({ status, body: { error, projectGone: true } });
  if (!pid) {
    const root = state.getActiveRoot(user.id);
    if (!root || !fs.existsSync(root)) return { status: 400, body: { error: 'Kein aktives Projekt geoeffnet.' } };
    if (!canAccessRoot(user, root)) return gone(403, 'Kein Zugriff mehr auf dieses Projekt.');
    return { root };
  }
  const active = state.getActiveRoot(user.id);
  // The last opened project may lie outside projects/ (admin opened an arbitrary folder).
  let root = active && String(pid) === projectIdOf(active) ? active : path.resolve(PROJECTS_DIR, String(pid));
  if (root !== active && (!isInside(PROJECTS_DIR, root) || root === path.resolve(PROJECTS_DIR))) return gone(404, 'Projekt nicht gefunden.');
  if (!fs.existsSync(root) || isParked(root)) return gone(404, 'Dieses Projekt ist nicht mehr verfügbar.');
  // Access can be revoked (share removed) while a window still shows the project.
  if (!canAccessRoot(user, root)) return gone(403, 'Kein Zugriff mehr auf dieses Projekt.');
  return { root };
}

function requireRoot(req, res) {
  const r = windowRoot(req);
  if (!r.root) res.status(r.status).json(r.body);
  return r.root || null;
}

// Desktop offline copy syncs every project the user owns, not just the active
// one: ?project=<projectId> selects it (owner/admin only), else the active root.
function requireSyncRoot(req, res) {
  if (!req.query.project) return requireRoot(req, res);
  const root = path.resolve(PROJECTS_DIR, String(req.query.project));
  if (!isInside(PROJECTS_DIR, root) || root === path.resolve(PROJECTS_DIR) || !fs.existsSync(root) || !canManageRoot(req.user, root)) {
    res.status(404).json({ error: 'Projekt nicht gefunden.' });
    return null;
  }
  return root;
}

function isInside(dir, p) {
  const d = path.resolve(dir);
  const r = path.resolve(p);
  return r === d || r.startsWith(d + path.sep);
}

// Owner = the user whose projects folder contains the root. Admin owns the
// top-level projects/ (except users/), and may open any path anyway.
function ownerIdOf(root) {
  const usersDir = path.join(PROJECTS_DIR, 'users');
  if (isInside(usersDir, root)) return path.relative(usersDir, path.resolve(root)).split(path.sep)[0];
  const admin = auth.users.find((u) => u.isAdmin);
  return admin ? admin.id : null;
}

function canManageRoot(user, root) {
  return user.isAdmin || ownerIdOf(root) === user.id;
}

// In the owner's trash or archive: members keep their share (back after restore), but no access meanwhile.
function isParked(root) {
  return [projects.TRASH_DIRNAME, projects.ARCHIVE_DIRNAME].includes(path.basename(path.dirname(path.resolve(root))));
}

function canAccessRoot(user, root) {
  if (!user || !root) return false;
  if (canManageRoot(user, root)) return true;
  return !isParked(root) && state.getShares(path.resolve(root)).includes(user.id);
}

function sharedRootsOf(userId) {
  return state.sharedRootsFor(userId).filter((r) => !isParked(r));
}

// Label key of an own project: folder name, '.trash/<name>', '.archive/<name>'.
const labelKeyOf = (projectsDir, root) => path.relative(projectsDir, root).split(path.sep).join('/');

// Owner moved a project folder: per-root state, the label and its watcher go along. Users who had
// it open follow a rename; into trash/archive it's dropped as their active project.
function projectMoved(req, projectsDir, oldRoot, newRoot) {
  kickRoot(path.resolve(oldRoot));
  state.moveRoot(oldRoot, newRoot, isParked(newRoot) ? null : newRoot);
  auth.moveMcpProject(projectIdOf(oldRoot), isParked(newRoot) ? null : projectIdOf(newRoot));
  state.moveLabelKey(req.user.id, labelKeyOf(projectsDir, oldRoot), labelKeyOf(projectsDir, newRoot));
  const w = watchersByRoot.get(path.resolve(oldRoot));
  if (w) {
    w.watcher.close();
    watchersByRoot.delete(path.resolve(oldRoot));
    if (!isParked(newRoot)) {
      ensureWatcher(path.resolve(newRoot));
      watchersByRoot.get(path.resolve(newRoot)).refCount = w.refCount;
    }
  }
}

// New project folder (create/copy/import) or permanently deleted one: no leftovers of an earlier project at that path.
function projectFresh(req, projectsDir, root) {
  state.dropRoot(root);
  auth.moveMcpProject(projectIdOf(root), null);
  state.moveLabelKey(req.user.id, labelKeyOf(projectsDir, root), null);
}

// 'owner' | 'editor' | 'reviewer' (read + comment only) | null
function roleOf(user, root) {
  if (!user || !root) return null;
  if (canManageRoot(user, root)) return 'owner';
  const key = path.resolve(root);
  return state.getShares(key).includes(user.id) ? state.getRole(key, user.id) : null;
}

// Stable id of a project for collab rooms / client caches: path below projects/.
function projectIdOf(root) {
  return path.relative(PROJECTS_DIR, path.resolve(root)).split(path.sep).join('/');
}

function ensureWatcher(root) {
  const entry = watchersByRoot.get(root);
  if (entry) {
    entry.refCount += 1;
    return;
  }
  const onEvent = (msg) => {
    // Edited on disk outside the IDE -> fold into the live doc; clients get it via Yjs.
    // ponytail: an external edit landing within the 500ms persist window of a live edit
    // wins over that edit (last writer); fine for occasional external tools.
    if (msg.type === 'fileChanged') collab.applyExternalText(root, msg.path, msg.content);
    if (msg.type === 'fileDeleted') collab.onPathMoved(root, msg.path, null);
    broadcast(root, msg);
  };
  watchersByRoot.set(root, { watcher: startWatcher(root, onEvent), refCount: 1 });
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

// Admin keeps using the pre-existing top-level projects/ folder as-is; every other, newly
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

// Only failed attempts use up the budget (many users behind one IP); separate buckets per purpose.
const failed = (res) => res.statusCode >= 400 && res.statusCode !== 429;
const limitLogin = authMw.rateLimit('login', 10, 15 * 60 * 1000, undefined, { countIf: failed });
const limitPassword = authMw.rateLimit('password', 10, 15 * 60 * 1000, undefined, { countIf: failed });
const limitRegister = authMw.rateLimit('register', 10, 60 * 60 * 1000);
const limitMail = authMw.rateLimit('mail', 5, 15 * 60 * 1000);
const limitToken = authMw.rateLimit('token', 30, 15 * 60 * 1000, undefined, { countIf: failed });
const limitImport = authMw.rateLimit('import', 30, 15 * 60 * 1000);
const limitMcp = authMw.rateLimit('mcp', 300, 60 * 1000);
// Local mode has no mail and only one login-free account: these routes have nothing to do there.
const notLocal = (req, res, next) => (authMw.LOCAL_MODE ? res.status(404).json({ error: 'Im lokalen Modus nicht verfügbar.' }) : next());

// Admin-chosen SMTP (auth-data.json) overrides .env; apply at startup.
{
  const s = auth.getSettings().smtp;
  if (s) mailer.setSmtp(s);
}
// Verification mode: mail (default) | admin | auto. Without working SMTP "mail" falls back to
// auto, otherwise invitees of a host without mail server could never log in.
const VERIFY_MODES = ['mail', 'admin', 'auto'];
const verifyMode = () => {
  const m = auth.getSettings().verifyMode || 'mail';
  return m === 'mail' && !mailer.isConfigured() ? 'auto' : m;
};

// Never throws (see mailer.sendMailSafe); result.error is set when delivery failed.
function sendVerifyMail(req, user) {
  const token = auth.createVerifyToken(user.id);
  return mailer.sendMailSafe({
    to: user.email,
    subject: 'LaTeX-IDE - E-Mail-Adresse bestätigen',
    text: `Hallo ${user.username || ''},\n\nbitte bestätige deine E-Mail-Adresse (Link gültig 48 Stunden):\n${baseUrl(req)}/?verify=${token}\n\nFalls du dich nicht registriert hast, ignoriere diese Mail.`,
  });
}

// Registration stays invite-gated: without a valid admin token nobody gets an account.
app.post('/api/auth/register', limitRegister, ah(async (req, res) => {
  const { token, username, email, password } = req.body;
  const invite = auth.getValidInvite(token || '');
  if (!invite) return res.status(400).json({ error: 'Der Einladungslink ist ungültig, abgelaufen oder bereits verwendet.' });
  let user;
  try {
    user = await auth.createUser({ email, password, username: (username || '').trim(), isAdmin: false, emailVerified: verifyMode() === 'auto' });
    auth.consumeInvite(token, user.id);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (verifyMode() === 'auto') return res.json({ ok: true, needsVerification: false, message: 'Konto angelegt. Du kannst dich jetzt anmelden.' });
  if (verifyMode() === 'admin') return res.json({ ok: true, needsVerification: true, message: 'Konto angelegt. Ein Admin muss deine E-Mail-Adresse noch bestätigen, bevor du dich anmelden kannst.' });
  // Account and invite are already used up: a mail failure must not look like a failed registration.
  const sent = await sendVerifyMail(req, user);
  res.json({
    ok: true,
    needsVerification: true,
    message: sent.error
      ? 'Konto angelegt, aber die Bestätigungsmail konnte gerade nicht verschickt werden. Bitte später beim Anmelden „Bestätigungsmail erneut senden“ nutzen.'
      : `Fast geschafft: Wir haben dir eine Bestätigungsmail an ${user.email} geschickt.`,
  });
}));

app.post('/api/auth/verify', notLocal, limitToken, (req, res) => {
  const user = auth.consumeVerifyToken(req.body.token || '');
  if (!user) return res.status(400).json({ error: 'Der Bestätigungslink ist ungültig oder abgelaufen. Beim Anmelden kannst du einen neuen anfordern.' });
  res.json({ ok: true, message: 'E-Mail-Adresse bestätigt. Du kannst dich jetzt anmelden.' });
});

app.post('/api/auth/resend-verification', notLocal, limitMail, ah(async (req, res) => {
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  // Not awaited: same answer and timing whether or not the account exists, and a hanging SMTP server doesn't block.
  if (user && !auth.isVerified(user) && verifyMode() === 'mail') sendVerifyMail(req, user);
  res.json({ ok: true, message: 'Falls ein unbestätigtes Konto existiert, wurde eine neue Bestätigungsmail verschickt.' });
}));

app.post('/api/auth/login', limitLogin, ah(async (req, res) => {
  const { password, rememberMe } = req.body;
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  const ok = user && (await auth.verifyPassword(user, password));
  if (!ok) return res.status(401).json({ error: 'Benutzername/E-Mail oder Passwort falsch.' });
  if (!auth.isVerified(user)) {
    return res.status(403).json({ error: verifyMode() === 'mail' ? 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungsmail).' : 'Dein Konto wartet noch auf die Bestätigung durch einen Admin.', unverified: true });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
    req.session.userId = user.id;
    req.session.loginAt = Date.now();
    authMw.applyRememberMe(req, !!rememberMe);
    res.json({ user: auth.toPublicUser(user) });
  });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('latex_ide_sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = authMw.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ user: { ...auth.toPublicUser(user), localMode: authMw.LOCAL_MODE }, features: { pandoc: exporter.pandocAvailable() } });
});

app.post('/api/auth/forgot-password', notLocal, limitMail, ah(async (req, res) => {
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  // Always answer the same way, whether or not the account exists -
  // otherwise the endpoint would leak which e-mails/usernames are registered.
  if (user) {
    const token = auth.createResetToken(user.id);
    const link = `${baseUrl(req)}/?reset=${token}`;
    // Not awaited (see resend-verification); sendMailSafe never rejects.
    mailer.sendMailSafe({
      to: user.email,
      subject: 'LaTeX-IDE - Passwort zurücksetzen',
      text: `Zum Zurücksetzen deines Passworts auf diesen Link klicken (gültig 1 Stunde):\n${link}\n\nFalls du das nicht angefordert hast, ignoriere diese Mail.`,
    });
  }
  res.json({ ok: true, message: 'Falls das Konto existiert, wurde ein Link zum Zurücksetzen an die hinterlegte E-Mail-Adresse verschickt.' });
}));

app.post('/api/auth/reset-password', notLocal, limitToken, ah(async (req, res) => {
  const { token, password } = req.body;
  // Check first: a typo must not burn the single-use link.
  try { auth.validatePassword(password); } catch (e) { return res.status(400).json({ error: e.message }); }
  const user = auth.consumeResetToken(token || '');
  if (!user) return res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte erneut "Passwort vergessen" anfordern.' });
  try {
    // Clicking the mailed link proves the mailbox, so this also verifies the address.
    user.emailVerified = true;
    await auth.setPassword(user, password); // logs out all other sessions
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

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
    usedAt: i.usedAt || null,
    usedByEmail: i.usedBy ? (auth.findUserById(i.usedBy) || {}).email || '(Konto gelöscht)' : null,
    expired: !i.usedBy && new Date(i.expiresAt).getTime() < Date.now(),
  }));
  res.json({ invites, baseUrl: baseUrl(req) });
});

app.delete('/api/admin/invites/:token', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  auth.revokeInvite(req.params.token);
  res.json({ ok: true });
});

// --- Admin: accounts ---

app.get('/api/admin/users', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  res.json({ users: auth.listUsers().map((u) => ({ ...auth.toPublicUser(u), verified: auth.isVerified(u) })) });
});

app.post('/api/admin/users/:id/verify', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  if (!auth.markVerified(req.params.id)) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  res.json({ ok: true });
});

// --- Admin: e-mail (SMTP from the UI overrides .env; the password never leaves the server) ---

function mailState() {
  const c = mailer.getConfig() || {};
  return {
    smtp: { host: c.host || '', port: c.port || '', secure: !!c.secure, user: c.user || '', from: c.from || '', passwordSet: !!c.pass, source: mailer.configSource() },
    smtpConfigured: mailer.isConfigured(),
    verifyMode: verifyMode(),
  };
}

app.get('/api/admin/mail', authMw.requireAuth, authMw.requireAdmin, (req, res) => res.json(mailState()));

app.put('/api/admin/mail', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  const { smtp, verifyMode: mode } = req.body || {};
  if (mode !== undefined && !VERIFY_MODES.includes(mode)) return res.status(400).json({ error: 'Ungültiger Bestätigungsmodus.' });
  const prev = auth.getSettings().smtp;
  if (smtp !== undefined) {
    const host = String((smtp && smtp.host) || '').trim();
    // Empty host = back to .env. Password: undefined keeps the stored one, '' removes it.
    const next = host ? {
      host,
      port: Number(smtp.port) || 587,
      secure: !!smtp.secure,
      user: String(smtp.user || '').trim(),
      pass: smtp.pass === undefined ? (prev && prev.pass) || '' : String(smtp.pass),
      from: String(smtp.from || '').trim(),
    } : null;
    mailer.setSmtp(next);
    auth.setSettings({ smtp: next });
  }
  if (mode === 'mail' && !mailer.isConfigured()) return res.status(400).json({ error: 'Bestätigung per Mail braucht einen funktionierenden SMTP-Zugang.' });
  if (mode !== undefined) auth.setSettings({ verifyMode: mode });
  res.json(mailState());
});

app.post('/api/admin/mail/test', authMw.requireAuth, authMw.requireAdmin, ah(async (req, res) => {
  if (!mailer.isConfigured()) return res.status(400).json({ error: 'Kein SMTP-Zugang konfiguriert.' });
  try {
    await mailer.sendMail({ to: req.user.email, subject: 'LaTeX-IDE - Testmail', text: 'Diese Testmail bestätigt, dass der Mailversand funktioniert.' });
  } catch (e) {
    return res.status(502).json({ error: `Versand fehlgeschlagen: ${e.message}` });
  }
  res.json({ ok: true, to: req.user.email });
}));

// Same as the user's own "Konto löschen", without the password (admin can't delete admins).
app.delete('/api/admin/users/:id', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  const user = auth.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  if (user.isAdmin) return res.status(400).json({ error: 'Admin-Konten können nicht gelöscht werden.' });
  removeAccount(user.id);
  res.json({ ok: true });
});

// --- Admin: server updates (like Nextcloud/Immich: banner for admins) ---
// UPDATE_MODE per host: off | notify (banner only, default) | button (admin can request
// the update) | auto (host cron installs nightly). Installing is always done by
// scripts/server-update.sh on the host; "button" only drops a request file it picks up.
const UPDATE_MODE = process.env.UPDATE_MODE || 'notify';
const { UPDATE_REPO } = legal; // env UPDATE_REPO, Standard felix-d-git/LaTeX-IDE
// Mit Vault ist DATA_DIR tmpfs im Container → Marker in VAULT_DIR, das der Host sieht
// (vault.js ignoriert dort Dateien, die kein Eintrag sind).
const UPDATE_REQUEST = path.join(process.env.DATA_KEY && process.env.VAULT_DIR ? process.env.VAULT_DIR : process.env.DATA_DIR || path.join(__dirname, '..'), '.update-request');
const APP_VERSION = require('../package.json').version;
// INSTALL_KIND=windows (set by the Windows installer): no cron/server-update.sh, update = run the new Setup.
const INSTALL_KIND = process.env.INSTALL_KIND || '';
let releaseCache = { at: 0, version: null, url: null };

async function latestRelease() {
  if (Date.now() - releaseCache.at < 6 * 3600e3) return releaseCache;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'LatexIDE-Server' };
  if (process.env.UPDATE_TOKEN) headers.Authorization = `Bearer ${process.env.UPDATE_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  const rel = await r.json();
  releaseCache = { at: Date.now(), version: String(rel.tag_name || '').replace(/^v/, ''), url: rel.html_url };
  return releaseCache;
}

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Written by scripts/server-update.sh on the host: { state: running|done|failed, from, to, at, log }.
const UPDATE_STATUS = path.join(path.dirname(UPDATE_REQUEST), '.update-status');
function updateStatus() {
  try { return JSON.parse(fs.readFileSync(UPDATE_STATUS, 'utf8')); } catch { return null; }
}

app.get('/api/admin/update', authMw.requireAuth, authMw.requireAdmin, ah(async (req, res) => {
  const base = { current: APP_VERSION, mode: UPDATE_MODE, installKind: INSTALL_KIND, requested: fs.existsSync(UPDATE_REQUEST), status: updateStatus() };
  if (UPDATE_MODE === 'off') return res.json({ ...base, available: false });
  try {
    const rel = await latestRelease();
    const out = { ...base, available: !!rel.version && isNewer(rel.version, APP_VERSION), version: rel.version, url: rel.url };
    if (INSTALL_KIND === 'windows' && rel.version) out.setupUrl = `https://github.com/${UPDATE_REPO}/releases/download/v${rel.version}/LatexIDE-Setup.exe`;
    res.json(out);
  } catch (e) {
    res.json({ ...base, available: false, error: e.message });
  }
}));

app.post('/api/admin/update', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  if (UPDATE_MODE !== 'button') return res.status(400).json({ error: 'Update per Button ist auf diesem Server nicht aktiviert (UPDATE_MODE).' });
  fs.writeFileSync(UPDATE_REQUEST, new Date().toISOString());
  res.json({ ok: true });
});

// --- MCP endpoint for external AI tools (own Bearer tokens, see lib/mcp.js) ---
// Projects a user can reach (own + shared) as { id, name, shared }; id = stable project id used in MCP tokens.
function mcpProjects(user) {
  const own = projects.listProjects(userProjectsDir(user), user.isAdmin ? ['users'] : []).map((p) => p.root);
  const shared = sharedRootsOf(user.id).filter((r) => fs.existsSync(r));
  return [...own, ...shared].map((r) => ({ id: projectIdOf(r), name: path.basename(r), shared: shared.includes(r) }));
}
app.post('/mcp', limitMcp, ah(createMcp({ PROJECTS_DIR, version: APP_VERSION, state, mcpProjects, projectIdOf, canAccessRoot, roleOf, runCompile, broadcast, pathMoved })));
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Nur POST.' }));

// --- Everything below requires a logged-in user ---
app.use('/api', authMw.requireAuth);

// Reviewers may read, compile and comment, but not change the project.
const REVIEWER_BLOCKED = /^\/api\/(collab\/raw|file|tree|main-file|settings|replace|import|history\/label)(\/|$)/;
app.use((req, res, next) => {
  if (req.method === 'GET' || !REVIEWER_BLOCKED.test(req.path)) return next();
  const { root } = windowRoot(req); // errors are answered by the route itself
  if (root && roleOf(req.user, root) === 'reviewer') {
    return res.status(403).json({ error: 'Du hast in diesem Projekt nur Kommentarrechte.' });
  }
  next();
});

// --- Desktop installers with this server's address built in (also the desktop apps' update source) ---
const desktopAssets = createDesktopAssets({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..'),
  repo: UPDATE_REPO,
  token: process.env.UPDATE_TOKEN,
  version: APP_VERSION,
});

app.get('/api/desktop/release', ah(async (req, res) => {
  try {
    res.json({ version: APP_VERSION, ...(await desktopAssets.available()) });
  } catch (e) {
    res.json({ version: APP_VERSION, windows: false, macos: false, error: e.message });
  }
}));

app.get('/api/desktop/download/:os', ah(async (req, res) => {
  try {
    await desktopAssets.send(req.params.os, baseUrl(req).replace(/\/+$/, ''), res);
  } catch (e) {
    if (res.headersSent) return res.destroy(e);
    res.status(502).json({ error: e.message });
  }
}));

// --- Account (logged in) ---

app.post('/api/auth/change-password', limitPassword, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await auth.verifyPassword(req.user, currentPassword))) {
    return res.status(400).json({ error: 'Aktuelles Passwort ist falsch.' });
  }
  try {
    await auth.setPassword(req.user, newPassword);
    // Every other session is now invalid; keep this one.
    if (req.session && req.session.userId) req.session.loginAt = Date.now();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Account incl. all projects in projects/users/<id> (also trash/archive), its watchers and sockets.
// The folder is moved aside first: if that fails (files in use), nothing is deleted
// and the account stays intact instead of ending up half-removed.
function removeAccount(userId) {
  const ownDir = path.resolve(path.join(PROJECTS_DIR, 'users', userId));
  const closeWatchers = () => {
    for (const [root, entry] of watchersByRoot) {
      if (isInside(ownDir, root)) {
        entry.watcher.close();
        watchersByRoot.delete(root);
      }
    }
  };
  collab.closeRoot(ownDir);
  const tmp = path.join(PROJECTS_DIR, 'users', `.deleted-${userId}-${Date.now()}`);
  const moveAside = () => {
    try {
      fs.renameSync(ownDir, tmp);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false; // no projects yet
      throw e;
    }
  };
  let moved;
  try {
    moved = moveAside();
  } catch (e) {
    // Windows: open watcher handles block renaming the folder -> close them and retry once.
    closeWatchers();
    try {
      moved = moveAside();
    } catch (e2) {
      const err = new Error('Konto konnte nicht gelöscht werden, Dateien sind noch in Benutzung. Bitte später erneut versuchen.');
      err.status = 500;
      err.cause = e2;
      throw err;
    }
  }
  closeWatchers();
  if (wss) wss.clients.forEach((c) => c.userId === userId && c.close());
  state.purgeUser(userId, ownDir);
  auth.deleteUser(userId);
  if (moved) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error(`[account] Rest von ${userId} nicht löschbar (${tmp}):`, e.message);
    }
  }
}

// Delete own account incl. all projects in projects/users/<id> (also trash/archive).
// The admin owns the top-level projects/ folder and can't delete itself.
app.post('/api/auth/delete-account', limitLogin, ah(async (req, res) => {
  if (req.user.isAdmin) return res.status(400).json({ error: 'Das Admin-Konto kann nicht gelöscht werden.' });
  if (!(await auth.verifyPassword(req.user, req.body.password))) {
    return res.status(400).json({ error: 'Passwort ist falsch.' });
  }
  removeAccount(req.user.id); // throws (-> error middleware) before deleting anything if files are in use
  req.session.destroy(() => {
    res.clearCookie('latex_ide_sid');
    res.json({ ok: true });
  });
}));

// Desktop app login: the browser (session) mints a token that the local
// desktop server stores and sends as Bearer. A token can't mint further tokens.
app.post('/api/auth/desktop-token', (req, res) => {
  if (!req.session || req.session.userId !== req.user.id) {
    return res.status(403).json({ error: 'Nur aus einer Browser-Anmeldung heraus möglich.' });
  }
  res.json({ token: auth.createApiToken(req.user.id, req.body.label) });
});

app.get('/api/auth/desktop-tokens', (req, res) => {
  res.json({ tokens: auth.listApiTokens(req.user.id) });
});

// MCP tokens: single rights (perms) for all projects or per selected project; shown once, only the hash is stored.
// Creating and changing the rights need the browser session.
// Local mode has no session (everything runs as the one admin) -> allowed without Bearer. `existing`: ids already in the
// token's saved scope stay allowed (project may be unreachable by now) - only new unreachable ids are refused.
function mcpScope(req, existing) {
  const browser = req.session && req.session.userId === req.user.id;
  if (!browser && !(authMw.LOCAL_MODE && !req.headers.authorization)) throw Object.assign(new Error('Nur aus einer Browser-Anmeldung heraus möglich.'), { status: 403 });
  const ids = new Set([...mcpProjects(req.user).map((p) => p.id), ...Object.keys((existing && existing.projects) || {})]);
  const sel = req.body.projects && typeof req.body.projects === 'object' ? req.body.projects : null;
  if (sel) for (const id of Object.keys(sel)) if (!ids.has(id)) throw Object.assign(new Error('Kein Zugriff auf Projekt ' + id), { status: 403 });
  return { perms: req.body.perms, projects: sel };
}

app.post('/api/auth/mcp-token', (req, res) => {
  try {
    res.json({ token: auth.createMcpToken(req.user.id, { name: req.body.name, ...mcpScope(req) }) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.patch('/api/auth/mcp-tokens/:id', (req, res) => {
  try {
    const existing = auth.listMcpTokens(req.user.id).find((t) => t.id === req.params.id);
    if (!existing || !auth.updateMcpToken(req.user.id, req.params.id, { name: req.body.name, ...mcpScope(req, existing) })) return res.status(404).json({ error: 'Token nicht gefunden.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.get('/api/auth/mcp-tokens', (req, res) => {
  res.json({ tokens: auth.listMcpTokens(req.user.id), projects: mcpProjects(req.user) });
});

app.delete('/api/auth/mcp-tokens/:id', (req, res) => {
  auth.revokeMcpToken(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/auth/desktop-tokens/:id', (req, res) => {
  auth.revokeApiToken(req.user.id, req.params.id);
  res.json({ ok: true });
});

// --- Sharing (of the active project) ---

function shareInfo(root, user) {
  const toMember = (id) => {
    const u = auth.findUserById(id);
    return u ? { id: u.id, username: auth.toPublicUser(u).username, email: u.email } : null;
  };
  const key = path.resolve(root);
  const canManage = canManageRoot(user, root);
  return {
    canManage,
    myRole: roleOf(user, root),
    owner: toMember(ownerIdOf(root)),
    members: state
      .getShares(key)
      .map((id) => toMember(id) && { ...toMember(id), role: state.getRole(key, id) })
      .filter(Boolean),
    links: canManage ? state.getShareLinks(key) : {},
  };
}

const SHARE_ROLES = ['editor', 'reviewer'];

function requireManagedRoot(req, res) {
  const root = requireRoot(req, res);
  if (!root) return null;
  if (!canManageRoot(req.user, root)) {
    res.status(403).json({ error: 'Nur der Eigentümer kann das Projekt teilen.' });
    return null;
  }
  return root;
}

app.get('/api/share', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json(shareInfo(root, req.user));
});

app.post('/api/share', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  if (!canManageRoot(req.user, root)) return res.status(403).json({ error: 'Nur der Eigentümer kann das Projekt teilen.' });
  const role = req.body.role || 'editor';
  if (!SHARE_ROLES.includes(role)) return res.status(400).json({ error: 'Ungültige Rolle.' });
  const target = auth.findUserByLogin(req.body.login || '');
  if (!target || !auth.isVerified(target)) return res.status(404).json({ error: 'Kein bestätigtes Konto mit diesem Benutzernamen / dieser E-Mail.' });
  if (canManageRoot(target, root)) return res.status(400).json({ error: 'Diese Person hat bereits Zugriff.' });
  const key = path.resolve(root);
  const ids = state.getShares(key);
  if (!ids.includes(target.id)) state.setShares(key, [...ids, target.id]);
  state.setRole(key, target.id, role);
  res.json(shareInfo(root, req.user));
});

app.post('/api/share/role', (req, res) => {
  const root = requireManagedRoot(req, res);
  if (!root) return;
  const key = path.resolve(root);
  if (!SHARE_ROLES.includes(req.body.role) || !state.getShares(key).includes(req.body.userId)) {
    return res.status(400).json({ error: 'Ungültige Rolle oder kein Mitglied.' });
  }
  state.setRole(key, req.body.userId, req.body.role);
  res.json(shareInfo(root, req.user));
});

// Share link per role (edit/view links). Whoever opens it
// while logged in becomes a member; the owner can revoke it any time.
app.post('/api/share/link', (req, res) => {
  const root = requireManagedRoot(req, res);
  if (!root) return;
  if (!SHARE_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Ungültige Rolle.' });
  const maxUses = Math.max(0, Math.min(1000, parseInt(req.body.maxUses, 10) || 0));
  state.setShareLink(path.resolve(root), req.body.role, { token: crypto.randomBytes(24).toString('base64url'), maxUses, uses: 0 });
  res.json(shareInfo(root, req.user));
});

app.delete('/api/share/link/:role', (req, res) => {
  const root = requireManagedRoot(req, res);
  if (!root) return;
  state.setShareLink(path.resolve(root), req.params.role, null);
  res.json(shareInfo(root, req.user));
});

app.post('/api/share/join', limitToken, (req, res) => {
  const link = typeof req.body.token === 'string' && state.findShareLink(req.body.token);
  if (!link || !fs.existsSync(link.root) || isParked(link.root)) return res.status(404).json({ error: 'Link ungültig oder zurückgezogen.' });
  if (!auth.isVerified(req.user)) return res.status(403).json({ error: 'Bitte zuerst die E-Mail-Adresse bestätigen.' });
  if (!canManageRoot(req.user, link.root)) {
    const ids = state.getShares(link.root);
    // An existing member keeps the role they have; the link only adds new people.
    if (!ids.includes(req.user.id)) {
      state.setShares(link.root, [...ids, req.user.id]);
      state.setRole(link.root, req.user.id, link.role);
      state.useShareLink(link.root, link.role);
    }
  }
  res.json({ root: link.root });
});

// Owner removes a member, or a member leaves (userId = self).
app.delete('/api/share/:userId', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  if (!canManageRoot(req.user, root) && req.params.userId !== req.user.id) {
    return res.status(403).json({ error: 'Nur der Eigentümer kann Mitglieder entfernen.' });
  }
  const key = path.resolve(root);
  state.setShares(key, state.getShares(key).filter((id) => id !== req.params.userId));
  state.setRole(key, req.params.userId, 'editor');
  kickRoot(key, req.params.userId);
  if (req.params.userId === req.user.id) return res.json({ ok: true });
  res.json(shareInfo(root, req.user));
});

// --- Collab ---

// Identity of a file's Y.Doc - client keys its offline cache (IndexedDB) by it.
app.get('/api/collab/epoch', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    if (!isTextFile(req.query.path || '')) return res.status(400).json({ error: 'Keine Textdatei.' });
    safeResolve(root, req.query.path);
    res.json({ projectId: projectIdOf(root), epoch: collab.getEpoch(root, req.query.path), maxPayload: collab.WS_MAX_PAYLOAD });
  } catch (e) {
    res.status(e.notUtf8 ? 415 : 404).json({ error: e.message, notUtf8: !!e.notUtf8 });
  }
});

// sha1 of one file, recomputed only when size/mtime/ctime changed since the last manifest.
const manifestCache = new Map(); // abs path -> { size, mtimeMs, ctimeMs, sha1 }
function fileSha1(abs) {
  const st = fs.statSync(abs);
  const c = manifestCache.get(abs);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.ctimeMs === st.ctimeMs) return { size: st.size, sha1: c.sha1 };
  const buf = fs.readFileSync(abs);
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  manifestCache.set(abs, { size: buf.length, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha1 });
  return { size: buf.length, sha1 };
}

// File list with hashes for the desktop app's local compile mirror.
app.get('/api/collab/manifest', (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  collab.flushRoot(root);
  const files = [];
  const seen = new Set();
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) {
        const abs = path.join(root, r);
        seen.add(abs);
        files.push({ path: r, ...fileSha1(abs) });
      }
    }
  };
  walk('');
  for (const k of manifestCache.keys()) if (k.startsWith(root + path.sep) && !seen.has(k)) manifestCache.delete(k);
  res.json({
    projectId: projectIdOf(root),
    mainFile: mainFileOf(root),
    settings: state.getProjectSettings(root),
    files,
  });
});

// Projects the user owns = what the desktop app keeps as offline copy.
app.get('/api/collab/owned', (req, res) => {
  const dir = userProjectsDir(req.user);
  const list = projects
    .listProjects(dir, req.user.isAdmin ? ['users'] : [])
    .map((p) => ({ name: p.name, projectId: projectIdOf(path.join(dir, p.name)) }));
  res.json({ projects: list });
});

// Optional ?base=<sha1 from the manifest | 'none'>: the sync run only overwrites/deletes what it last saw
// (live edits of collaborators during the run are not lost). Without base: old behaviour.
function checkSyncBase(req, root, abs) {
  const base = req.query.base ?? req.get('if-match')?.replace(/^"|"$/g, ''); // If-Match = same value as ?base
  if (base === undefined) return true;
  collab.flushRoot(root); // live edits are on disk before comparing
  let cur = 'none';
  try {
    if (fs.statSync(abs).isFile()) cur = fileSha1(abs).sha1;
  } catch {}
  return base === cur;
}

// Desktop sync upload/delete of one file (bytes as body) in an owned project.
app.put('/api/collab/raw', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  try {
    const rel = String(req.query.path || '');
    if (isIgnored(rel.split('/')[0])) throw new Error('Pfad nicht erlaubt.');
    const abs = safeResolve(root, rel);
    if (!checkSyncBase(req, root, abs)) return res.status(409).json({ error: 'Die Datei wurde inzwischen geändert.', conflict: true });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (isTextFile(rel)) state.markSelfWrite(abs, buf);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    if (isTextFile(rel)) collab.applyExternalText(root, rel, decodeText(buf));
    safeSnapshot(root, { trigger: 'autosave' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/collab/raw', (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  try {
    if (isIgnored(String(req.query.path || '').split('/')[0])) throw new Error('Pfad nicht erlaubt.');
    collab.flushRoot(root);
    if (!checkSyncBase(req, root, safeResolve(root, String(req.query.path || '')))) return res.status(409).json({ error: 'Die Datei wurde inzwischen geändert.', conflict: true });
    treeOps.trashPath(root, req.query.path);
    collab.onPathMoved(root, req.query.path, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Add files: from another project / from an external URL ---

// Other projects this user may read, addressed by projectIdOf().
function importSourceRoot(req, id) {
  const r = path.resolve(PROJECTS_DIR, String(id || ''));
  if (!isInside(PROJECTS_DIR, r) || r === path.resolve(PROJECTS_DIR) || !fs.existsSync(r) || !canAccessRoot(req.user, r)) return null;
  return r;
}

app.get('/api/import/projects', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const own = projects.listProjects(userProjectsDir(req.user), req.user.isAdmin ? ['users'] : []).map((p) => p.root);
  const roots = [...own, ...sharedRootsOf(req.user.id)]
    .map((r) => path.resolve(r))
    .filter((r) => r !== path.resolve(root) && importSourceRoot(req, projectIdOf(r)));
  res.json({ projects: roots.map((r) => ({ id: projectIdOf(r), name: path.basename(r) })) });
});

app.get('/api/import/files', (req, res) => {
  const src = importSourceRoot(req, req.query.project);
  if (!src) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const files = [];
  const walk = (nodes) => nodes.forEach((n) => (n.type === 'dir' ? walk(n.children) : files.push(n.path)));
  walk(buildTree(src));
  res.json({ files });
});

app.post('/api/import/project-file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const src = importSourceRoot(req, req.body.project);
  if (!src) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  try {
    collab.flushRoot(src);
    const data = fs.readFileSync(safeResolve(src, req.body.path));
    const name = req.body.name || path.posix.basename(req.body.path);
    res.json({ path: treeOps.uploadFile(root, req.body.dir, name, data.toString('base64')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// File name derived from the URL: invalid characters replaced, extension from the content type when the URL has none.
const EXT_BY_TYPE = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'text/plain': '.txt', 'application/x-bibtex': '.bib' };
function nameFromUrl(finalUrl, headers = {}) {
  let last = '';
  try {
    last = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '');
  } catch {
    last = '';
  }
  let name = last.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'download';
  const ext = EXT_BY_TYPE[String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (ext && !path.extname(name)) name += ext;
  return name;
}

app.post('/api/import/url', limitImport, ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const { data, finalUrl, headers } = await fetchUrl(req.body.url);
    const name = String(req.body.name || '').trim() || nameFromUrl(finalUrl, headers);
    res.json({ path: treeOps.uploadFile(root, req.body.dir, name, data.toString('base64')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Literatur: DOI → BibTeX (doi.org Content-Negotiation) und Zotero-Bibliothek als .bib.
// replace: Zotero-Refresh überschreibt die Datei, DOI hängt an.
function appendOrUpload(root, dir, name, text, replace = false) {
  if (!/\.bib$/i.test(name)) throw new Error('Zieldatei muss auf .bib enden.');
  const rel = path.posix.join(String(dir || ''), name);
  const abs = safeResolve(root, rel);
  if (fs.existsSync(abs)) {
    // Bestehende .bib ergänzen, auch wenn sie gerade live bearbeitet wird.
    collab.flushRoot(root);
    const relPath = path.relative(root, abs).split(path.sep).join('/');
    const old = replace ? '' : decodeText(fs.readFileSync(abs));
    if (old === null) throw new Error(NOT_UTF8_MSG);
    safeSnapshot(root, { trigger: 'import', label: `Vor Literatur-Import: ${relPath}` });
    const content = replace ? text : old.replace(/\s*$/, '\n\n') + text;
    state.markSelfWrite(abs, content);
    fs.writeFileSync(abs, content, 'utf8');
    collab.applyExternalText(root, relPath, content);
    return relPath;
  }
  return treeOps.uploadFile(root, dir, name, Buffer.from(text).toString('base64'));
}

app.post('/api/import/doi', limitImport, ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const doi = String(req.body.doi || '').trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) return res.status(400).json({ error: 'Keine gültige DOI (Form 10.xxxx/…).' });
  try {
    const { data } = await fetchUrl('https://doi.org/' + encodeURI(doi), { Accept: 'application/x-bibtex; charset=utf-8' });
    const bib = data.toString('utf8').trim();
    if (!bib.startsWith('@')) throw new Error('doi.org lieferte kein BibTeX.');
    res.json({ path: appendOrUpload(root, req.body.dir, req.body.name || 'references.bib', bib + '\n') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.get('/api/zotero', (req, res) => {
  const z = req.user.zotero;
  res.json(z ? { libraryType: z.libraryType, libraryId: z.libraryId, hasKey: !!z.apiKey } : {});
});

app.post('/api/zotero', (req, res) => {
  const { libraryType, libraryId, apiKey } = req.body || {};
  if (!libraryId) {
    auth.setZotero(req.user.id, null);
    return res.json({});
  }
  if (!/^\d+$/.test(String(libraryId))) return res.status(400).json({ error: 'Library-ID muss eine Zahl sein.' });
  const key = apiKey || (req.user.zotero && req.user.zotero.apiKey) || '';
  if (key && !/^[A-Za-z0-9]{8,64}$/.test(key)) return res.status(400).json({ error: 'API-Key hat ein ungültiges Format.' });
  auth.setZotero(req.user.id, { libraryType: libraryType === 'group' ? 'group' : 'user', libraryId: String(libraryId), apiKey: key });
  res.json({ ok: true });
});

// Eigenes Wörterbuch je Konto (statt je Browser). Ganze Liste ersetzen; der Client führt zusammen.
app.get('/api/dictionary', (req, res) => res.json({ words: req.user.dictionary || [] }));
app.post('/api/dictionary', (req, res) => {
  const { words } = req.body;
  if (!Array.isArray(words) || words.length > 20000 || words.some((w) => typeof w !== 'string' || !w || w.length > 100 || /\s/.test(w))) {
    return res.status(400).json({ error: 'Ungültiges Wörterbuch.' });
  }
  auth.setDictionary(req.user.id, [...new Set(words)].sort());
  res.json({ ok: true });
});

app.post('/api/import/zotero', limitImport, ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const z = req.user.zotero;
  if (!z) return res.status(400).json({ error: 'Zuerst unter Einstellungen ▸ Literatur den Zotero-Zugang eintragen.' });
  const format = req.body.format === 'biblatex' ? 'biblatex' : 'bibtex';
  const name = String(req.body.name || 'zotero.bib').trim();
  if (!/\.bib$/i.test(name)) return res.status(400).json({ error: 'Dateiname muss auf .bib enden.' });
  const base = `https://api.zotero.org/${z.libraryType === 'group' ? 'groups' : 'users'}/${z.libraryId}/items/top?format=${format}&limit=100`;
  const headers = { 'Zotero-API-Version': '3', ...(z.apiKey ? { 'Zotero-API-Key': z.apiKey } : {}) };
  try {
    const parts = [];
    // ponytail: max. 50 Seiten à 100 Einträge; größere Bibliotheken über Collections aufteilen.
    for (let start = 0, total = 1; start < total && start < 5000; start += 100) {
      const { data, headers: h } = await fetchUrl(`${base}&start=${start}`, headers);
      total = Number(h['total-results']) || 0;
      if (total > 5000) throw new Error(`Die Bibliothek hat ${total} Einträge (Limit 5000). Bitte über eine Collection aufteilen.`);
      parts.push(data.toString('utf8').trim());
      const backoff = Number(h.backoff) || 0;
      if (backoff && start + 100 < total) {
        if (backoff > 30) throw new Error(`Zotero bittet um ${backoff} s Pause, bitte später erneut importieren.`);
        await new Promise((r) => setTimeout(r, backoff * 1000));
      }
    }
    // Refresh aus einem anderen Ordner: die eine vorhandene Datei ersetzen statt eine zweite anzulegen.
    let dir = req.body.dir;
    if (!fs.existsSync(safeResolve(root, path.posix.join(String(dir || ''), name)))) {
      const hits = findByName(root, name);
      if (hits.length === 1) dir = path.posix.dirname(hits[0]);
    }
    res.json({ path: appendOrUpload(root, dir, name, parts.filter(Boolean).join('\n\n') + '\n', true) });
  } catch (e) {
    res.status(400).json({ error: 'Zotero: ' + e.message });
  }
}));

// Grammatik über einen selbst betriebenen LanguageTool-Server (LANGUAGETOOL_URL).
app.get('/api/languagetool', (req, res) => res.json({ enabled: !!process.env.LANGUAGETOOL_URL }));

app.post('/api/languagetool', ah(async (req, res) => {
  const ltUrl = process.env.LANGUAGETOOL_URL;
  if (!ltUrl) return res.status(501).json({ error: 'LanguageTool ist auf diesem Server nicht eingerichtet.' });
  const data = String(req.body.data || '');
  if (data.length > 1_000_000) return res.status(413).json({ error: 'Text zu lang.' });
  const language = /^[a-z]{2}(-[A-Z]{2})?$/.test(req.body.language) ? req.body.language : 'auto';
  try {
    const r = await fetch(ltUrl.replace(/\/+$/, '') + '/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data, language }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`LanguageTool antwortet mit ${r.status}.`);
    res.json({ matches: (await r.json()).matches || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

// --- Projects ---

app.get('/api/projects/list', (req, res) => {
  const projectsDir = userProjectsDir(req.user);
  res.json({
    activeRoot: state.getActiveRoot(req.user.id),
    recentRoots: state.getRecentRoots(req.user.id),
    localProjects: projects.listProjects(projectsDir, req.user.isAdmin ? ['users'] : []),
    sharedProjects: sharedRootsOf(req.user.id)
      .filter((root) => fs.existsSync(root))
      .map((root) => {
        const owner = auth.findUserById(ownerIdOf(root));
        return { name: path.basename(root), root, owner: owner ? auth.toPublicUser(owner).username : '?', lastModified: projects.getLastModified(root) };
      }),
    trashedProjects: projects.listTrash(projectsDir),
    archivedProjects: projects.listArchived(projectsDir),
    labels: state.getLabels(req.user.id),
    labelColors: state.LABEL_COLORS,
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
  const root = req.body.root ? path.resolve(String(req.body.root)) : '';
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return res.status(400).json({ error: 'Ordner nicht gefunden.' });
  }
  // Non-admin users may only activate a project inside their own folder or
  // one shared with them - otherwise they could type any local path (e.g.
  // the admin's thesis folder) into the "open folder" dialog and read it.
  if (!canAccessRoot(req.user, root)) {
    return res.status(403).json({ error: 'Kein Zugriff auf diesen Ordner.' });
  }
  const previousRoot = state.getActiveRoot(req.user.id);
  state.setActiveRoot(req.user.id, root);
  if (previousRoot && previousRoot !== root) releaseWatcher(previousRoot);
  if (previousRoot !== root) ensureWatcher(root);
  const main = mainFileOf(root);
  if (main) state.setMainFile(root, main);
  // Startdatei beim Öffnen: flachste main.tex, sonst erste .tex (nicht die gespeicherte Hauptdatei).
  const startFile = pickStartFile(root);
  res.json({ activeRoot: root, mainFile: main, startFile, projectId: projectIdOf(root), role: roleOf(req.user, root) });
});

app.post('/api/projects/create', (req, res) => {
  try {
    const projectsDir = userProjectsDir(req.user);
    const root = projects.createProject(projectsDir, req.body.name || '');
    projectFresh(req, projectsDir, root);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/rename', (req, res) => {
  const { oldName, newName } = req.body;
  const projectsDir = userProjectsDir(req.user);
  const root = path.resolve(path.join(projectsDir, oldName || ''));
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses umbenannt wird.' });
  }
  try {
    // Save first, send editors away only once the (synchronous) move worked.
    collab.flushRoot(root);
    const newRoot = projects.renameProject(projectsDir, oldName, newName);
    collab.closeRoot(root);
    projectMoved(req, projectsDir, root, path.resolve(newRoot));
    res.json({ root: newRoot });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/copy', (req, res) => {
  try {
    const projectsDir = userProjectsDir(req.user);
    collab.flushRoot(path.resolve(path.join(projectsDir, req.body.name || ''))); // live edits into the copy
    const root = projects.copyProject(projectsDir, req.body.name, req.body.newName);
    projectFresh(req, projectsDir, root);
    state.copyRoot(path.join(projectsDir, req.body.name), root);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/archive', (req, res) => {
  const { name } = req.body;
  const projectsDir = userProjectsDir(req.user);
  const root = path.resolve(path.join(projectsDir, name || ''));
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses archiviert wird.' });
  }
  try {
    collab.flushRoot(root);
    const dest = projects.archiveProject(projectsDir, name);
    collab.closeRoot(root);
    projectMoved(req, projectsDir, root, path.resolve(dest));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/unarchive', (req, res) => {
  try {
    const projectsDir = userProjectsDir(req.user);
    const root = projects.unarchiveProject(projectsDir, req.body.name);
    projectMoved(req, projectsDir, path.resolve(projectsDir, projects.ARCHIVE_DIRNAME, req.body.name), path.resolve(root));
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Neues Projekt aus .zip (Body = rohe Zip-Bytes, ?name=<Dateiname>). Limits/Zip-Slip: lib/unzip.js.
app.post('/api/projects/upload-zip', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Keine Zip-Datei empfangen.' });
  try {
    const projectsDir = userProjectsDir(req.user);
    const root = projects.importZip(projectsDir, String(req.query.name || ''), req.body);
    projectFresh(req, projectsDir, root);
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mehrere Projekte als ein Zip, je ein Ordner pro Projekt. ?items=<JSON-Array>: eigene = Ordnername,
// geteilte = Root-Pfad (nur wenn mit dem Nutzer geteilt).
app.get('/api/projects/download/zip', (req, res) => {
  let items;
  try {
    items = JSON.parse(String(req.query.items || '[]'));
    if (!Array.isArray(items) || !items.length || items.some((i) => typeof i !== 'string')) throw new Error();
  } catch (e) {
    return res.status(400).json({ error: 'Ungültige Auswahl.' });
  }
  const dir = userProjectsDir(req.user);
  const shared = sharedRootsOf(req.user.id).map((r) => path.resolve(r));
  const list = [];
  try {
    for (const it of items) {
      const root = path.isAbsolute(it) ? path.resolve(it) : resolveProjectRoot(dir, it);
      if (path.isAbsolute(it) ? !shared.includes(root) : root === path.resolve(dir)) throw new Error('Ungültiger Projektname.');
      if (!fs.existsSync(root)) throw new Error('Projekt nicht gefunden.');
      list.push(root);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="projekte.zip"');
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(err.message));
  archive.pipe(res);
  const used = new Set();
  for (const root of list) {
    collab.flushRoot(root);
    let folder = path.basename(root);
    for (let i = 2; used.has(folder); i++) folder = `${path.basename(root)}_${i}`;
    used.add(folder);
    archive.directory(root, folder, (entry) => (entry.name.split('/').some((p) => isIgnored(p)) ? false : entry));
  }
  archive.finalize();
});

// --- Labels (pro Nutzer privat) ---

function labelFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 40) throw new Error('Labelname: 1-40 Zeichen.');
    out.name = name;
  }
  if (!partial || body.color !== undefined) {
    if (!state.LABEL_COLORS.includes(body.color)) throw new Error('Ungültige Farbe.');
    out.color = body.color;
  }
  return out;
}

app.post('/api/labels', (req, res) => {
  try {
    const f = labelFields(req.body, false);
    res.json(state.addLabel(req.user.id, f.name, f.color));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/labels/:id', (req, res) => {
  try {
    const l = state.updateLabel(req.user.id, req.params.id, labelFields(req.body, true));
    if (!l) return res.status(404).json({ error: 'Label nicht gefunden.' });
    res.json(l);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/labels/:id', (req, res) => {
  state.deleteLabel(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.post('/api/labels/assign', (req, res) => {
  const { keys, labelId, on } = req.body;
  if (!Array.isArray(keys) || keys.length > 1000 || keys.some((k) => typeof k !== 'string')) {
    return res.status(400).json({ error: 'Ungültige Auswahl.' });
  }
  if (!state.assignLabel(req.user.id, keys, String(labelId), !!on)) return res.status(404).json({ error: 'Label nicht gefunden.' });
  res.json(state.getLabels(req.user.id));
});

app.get('/api/projects/:name/download/zip', (req, res) => {
  let root;
  try {
    root = resolveProjectRoot(userProjectsDir(req.user), req.params.name);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!fs.existsSync(root)) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  collab.flushRoot(root);
  res.attachment(`${req.params.name}.zip`); // RFC 5987 filename*: names outside Latin-1 no longer make setHeader throw
  const archive = new ZipArchive({ zlib: { level: 9 } });
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
  const main = mainFileOf(root);
  if (!main) return res.status(404).json({ error: 'Keine .tex-Hauptdatei gefunden.' });
  const pdfAbs = path.join(root, outRelFor(root, req.user.id), pdfNameFor(main));
  if (!fs.existsSync(pdfAbs)) return res.status(404).json({ error: 'Noch kein PDF für dieses Projekt kompiliert.' });
  res.attachment(`${req.params.name}.pdf`);
  streamFile(res, pdfAbs);
});

app.post('/api/projects/trash', (req, res) => {
  const { name, from } = req.body;
  const projectsDir = userProjectsDir(req.user);
  // An archived project can't be open; it may share its name with an active one.
  if (from === 'archive') {
    try {
      const dest = projects.trashArchivedProject(projectsDir, name);
      projectMoved(req, projectsDir, path.resolve(projectsDir, projects.ARCHIVE_DIRNAME, name), path.resolve(dest));
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  const root = path.resolve(path.join(projectsDir, name || ''));
  if (state.getActiveRoot(req.user.id) === root) {
    return res.status(400).json({ error: 'Bitte zuerst ein anderes Projekt öffnen, bevor dieses in den Papierkorb verschoben wird.' });
  }
  try {
    collab.flushRoot(root);
    const dest = projects.trashProject(projectsDir, name);
    collab.closeRoot(root);
    projectMoved(req, projectsDir, root, path.resolve(dest));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/projects/restore', (req, res) => {
  try {
    const projectsDir = userProjectsDir(req.user);
    const root = projects.restoreProject(projectsDir, req.body.name);
    projectMoved(req, projectsDir, path.resolve(projectsDir, projects.TRASH_DIRNAME, req.body.name), path.resolve(root));
    res.json({ root });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/projects/trash/:name', (req, res) => {
  try {
    const projectsDir = userProjectsDir(req.user);
    projects.deleteProjectPermanently(projectsDir, req.params.name);
    projectFresh(req, projectsDir, path.resolve(projectsDir, projects.TRASH_DIRNAME, req.params.name));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- File tree / content ---

app.get('/api/tree', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ tree: buildTree(root), mainFile: mainFileOf(root), projectId: projectIdOf(root) });
});

app.get('/api/file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    collab.flushRoot(root);
    if (isTextFile(req.query.path)) {
      const buf = fs.readFileSync(abs);
      const text = decodeText(buf);
      if (text !== null) return res.json({ path: req.query.path, content: text, binary: false });
      // Read-only view of a Latin-1 file; editing needs "Nach UTF-8 umwandeln".
      res.json({ path: req.query.path, content: new TextDecoder('windows-1252').decode(buf), binary: false, notUtf8: true });
    } else {
      const buf = fs.readFileSync(abs);
      res.json({ path: req.query.path, content: buf.toString('base64'), binary: true });
    }
  } catch (e) {
    res.status(404).json({ error: e.message });
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
    collab.flushRoot(root);
    const relPath = treeOps.renamePath(root, req.body.path, req.body.newName);
    pathMoved(root, req.body.path, relPath);
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
    collab.flushRoot(root);
    const relPath = treeOps.movePath(root, req.body.path, req.body.targetDir, !!req.body.overwrite);
    if (relPath !== req.body.path) {
      // Overwritten target: its editors/comments go first, then the moved entry's take its place.
      if (req.body.overwrite) pathMoved(root, relPath, null);
      pathMoved(root, req.body.path, relPath);
    }
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
    collab.flushRoot(root); // a pending edit would otherwise recreate the deleted file
    treeOps.deletePath(root, req.query.path);
    pathMoved(root, req.query.path, null);
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
    const relPath = treeOps.uploadFile(root, req.body.dir, req.body.name, req.body.content, !!req.body.overwrite);
    // Überschriebene Textdatei: offene Editoren live auf den neuen Inhalt setzen
    if (req.body.overwrite && isTextFile(relPath)) {
      collab.applyExternalText(root, relPath, decodeText(Buffer.from(req.body.content, 'base64')));
    }
    res.json({ ok: true, path: relPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/main-file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const prev = state.getMainFile(root);
  state.setMainFile(root, req.body.path);
  // main.tex and thesis/main.tex both write main.pdf: drop the other file's
  // output so download/SyncTeX don't serve it until the next compile. Queued
  // behind running compiles so it doesn't pull the directory from under latexmk.
  if (prev && req.body.path && prev !== req.body.path && pdfNameFor(prev) === pdfNameFor(req.body.path)) {
    compileChain = compileChain.then(() => fs.rmSync(path.join(root, OUT_DIR), { recursive: true, force: true })).catch(() => {});
  }
  res.json({ ok: true });
});

// --- Compile ---

// The Pi compiles one document at a time; a second request for the same
// project while it is still waiting shares the queued run.
// ponytail: one global queue - per-core workers if the server gets stronger.
let compileChain = Promise.resolve();
const queuedCompile = new Map(); // output dir -> promise of a not-yet-started run

// opts.auto: autocompile run - its version snapshot is throttled like autosave.
function runCompile(root, main, userId, meta, { auto = false } = {}) {
  const outRel = outRelFor(root, userId);
  const key = path.join(root, outRel);
  // Group mode: everyone on the project sees the run; individual: only the compiling user.
  const to = outRel === OUT_DIR ? undefined : userId;
  if (queuedCompile.has(key)) return queuedCompile.get(key);
  broadcast(root, { type: 'compileStatus', status: 'running' }, to);
  const run = compileChain
    .then(() => {
      queuedCompile.delete(key);
      return doCompile(root, main, outRel, to, meta, auto);
    })
    .catch((e) => {
      // Otherwise every client's status would stay on 'running'.
      console.error('[compile]', root, e);
      broadcast(root, { type: 'compileStatus', status: 'error', log: String((e && e.message) || e) }, to);
      throw e;
    });
  queuedCompile.set(key, run);
  compileChain = run.catch(() => {});
  return run;
}

// A failing version snapshot (unreadable file, full disk) must not fail the save/compile it belongs to.
function safeSnapshot(root, opts) {
  try {
    return history.snapshot(root, opts);
  } catch (e) {
    console.error('[history] Snapshot fehlgeschlagen:', root, e.message);
    return null;
  }
}

async function doCompile(root, main, outRel, to, meta, auto) {
  lastAutocompileAt.set(root, Date.now()); // the flush below must not trigger a second autocompile
  collab.flushRoot(root);
  const t0 = Date.now();
  const result = await compile(root, main, state.getProjectSettings(root), outRel);
  result.durationMs = Date.now() - t0;
  try {
    if (result.pdfPath) state.addCompileTime(root, { ms: result.durationMs, at: new Date().toISOString(), ...meta });
  } catch (e) {
    console.error('[compile] Laufzeit nicht gespeichert:', e.message);
  }
  const status = result.success ? 'success' : result.pdfPath ? 'warning' : 'error';
  broadcast(root, { type: 'compileStatus', status, log: result.log, errors: result.errors || [], warnings: result.warnings || [] }, to);
  if (result.pdfPath) broadcast(root, { type: 'pdfChanged', path: result.pdfPath }, to);
  safeSnapshot(root, { trigger: auto ? 'autocompile' : 'compile' });
  if (result.pdfPath) {
    try {
      wordCountByOut.set(path.join(root, outRel), wordcount.countWords(root, main));
    } catch (e) {
      // best-effort - word count just stays unavailable for this root
    }
  }
  return result;
}

app.post('/api/compile', ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const main = mainFileOf(root);
  if (!main) return res.status(400).json({ error: 'Keine .tex-Hauptdatei gefunden.' });
  try {
    res.json(await runCompile(root, main, req.user.id));
  } catch (e) {
    res.status(500).json({ error: 'Kompilierung fehlgeschlagen: ' + e.message });
  }
}));

// "Clear cached files" im Log: Ausgabeordner (aux, PDF, synctex …) löschen.
// Group mode clears the shared folder incl. the per-user ones (just caches).
app.post('/api/compile/clear-cache', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  fs.rmSync(path.join(root, outRelFor(root, req.user.id)), { recursive: true, force: true });
  res.json({ ok: true });
});

// --- Settings ---

app.get('/api/wordcount', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const stats = wordCountByOut.get(path.join(root, outRelFor(root, req.user.id)));
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
  const { compiler, stopOnFirstError, autocompile, compileMode } = req.body;
  const patch = {};
  if (compiler !== undefined) patch.compiler = compiler;
  if (compileMode !== undefined) patch.compileMode = compileMode === 'group' ? 'group' : 'individual';
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
    streamFile(res, abs);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Raw byte stream for previewing arbitrary project files (images, reference
// PDFs) in a tab - unlike /api/file (base64 JSON), this is a direct stream
// so <img>/<iframe> can point straight at the URL.
app.get('/api/raw', (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    const ext = path.extname(abs).toLowerCase();
    res.setHeader('Content-Type', RAW_MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    streamFile(res, abs);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Download the whole project as a .zip (File -> Download -> Source in the
// menu bar), skipping the same generated/hidden dirs the file
// tree already hides (fsTree.isIgnored).
app.get('/api/export', ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const main = mainFileOf(root);
  if (!main) return res.status(400).json({ error: 'Keine Hauptdatei festgelegt.' });
  collab.flushRoot(root);
  try {
    const { data, fmt } = await exporter.exportProject(root, main, String(req.query.format));
    const name = `${path.basename(root) || 'dokument'}.${fmt.ext}`;
    res.setHeader('Content-Type', fmt.mime);
    res.setHeader('Content-Disposition', `attachment; filename="export.${fmt.ext}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(data);
  } catch (e) {
    res.status(e.code === 'ENOENT' ? 501 : 400).json({ error: e.message.slice(0, 500) });
  }
}));

app.get('/api/download/zip', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const name = path.basename(root) || 'project';
  collab.flushRoot(root);
  res.attachment(`${name}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(err.message));
  archive.pipe(res);
  archive.directory(root, false, (entry) => {
    const parts = entry.name.split('/');
    return parts.some((p) => isIgnored(p)) ? false : entry;
  });
  archive.finalize();
});

// --- SyncTeX (code <-> PDF position) ---

app.get('/api/synctex/forward', ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { file, line } = req.query;
  if (!file || !line) return res.status(400).json({ error: 'file und line sind erforderlich.' });
  const pdfAbs = activeMainPdfAbs(root, req.user.id);
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
}));

app.get('/api/synctex/inverse', ah(async (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { page, x, y } = req.query;
  if (!page || x === undefined || y === undefined) {
    return res.status(400).json({ error: 'page, x und y sind erforderlich.' });
  }
  const pdfAbs = activeMainPdfAbs(root, req.user.id);
  if (!pdfAbs || !fs.existsSync(pdfAbs)) {
    return res.status(400).json({ error: 'Noch kein PDF vorhanden - zuerst kompilieren.' });
  }
  try {
    res.json(await synctex.inverseInProject(root, pdfAbs, page, x, y));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// --- Comments ---

app.get('/api/comments', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json({ comments: comments.listAll(root) });
});

function canWriteRoot(user, root) {
  const role = roleOf(user, root);
  return !!role && role !== 'reviewer';
}

function authorOf(user) {
  return { id: user.id, name: auth.toPublicUser(user).username };
}

// Eigener Beitrag oder Owner/Admin (Altbestand ohne Autor: nur Owner/Admin).
function mayChange(user, root, item) {
  return canManageRoot(user, root) || (!!item.author && item.author.id === user.id);
}

function commentText(req, res) {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) res.status(400).json({ error: 'text ist erforderlich.' });
  return text;
}

// result: Kommentar | null (nicht gefunden) | false (verboten)
function commentResult(res, root, relPath, result) {
  if (result === null) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (result === false) return res.status(403).json({ error: 'Nur eigene Beitraege (oder der Eigentuemer) duerfen geaendert werden.' });
  broadcast(root, { type: 'commentsChanged', path: relPath });
  res.json({ comment: result });
}

app.post('/api/comments', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { path: relPath, from, to, anchorText } = req.body;
  if (!relPath || typeof from !== 'number' || typeof to !== 'number') {
    return res.status(400).json({ error: 'path, from, to und text sind erforderlich.' });
  }
  const text = commentText(req, res);
  if (!text) return;
  const comment = comments.add(root, relPath, { from, to, anchorText, text, author: authorOf(req.user) });
  broadcast(root, { type: 'commentsChanged', path: relPath });
  res.json({ comment });
});

app.patch('/api/comments/:id', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const text = commentText(req, res);
  if (!text) return;
  const relPath = req.body.path;
  const r = comments.edit(root, relPath, req.params.id, null, text, (c) => mayChange(req.user, root, c));
  commentResult(res, root, relPath, r);
});

app.post('/api/comments/:id/replies', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const text = commentText(req, res);
  if (!text) return;
  const relPath = req.body.path;
  commentResult(res, root, relPath, comments.reply(root, relPath, req.params.id, { text, author: authorOf(req.user) }));
});

app.patch('/api/comments/:id/replies/:rid', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const text = commentText(req, res);
  if (!text) return;
  const relPath = req.body.path;
  const r = comments.edit(root, relPath, req.params.id, req.params.rid, text, (c) => mayChange(req.user, root, c));
  commentResult(res, root, relPath, r);
});

app.delete('/api/comments/:id/replies/:rid', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const relPath = req.query.path;
  commentResult(res, root, relPath, comments.removeReply(root, relPath, req.params.id, req.params.rid, (c) => mayChange(req.user, root, c)));
});

app.delete('/api/comments/:id', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path ist erforderlich.' });
  // Altkommentare ohne Autor bleiben fuer alle loeschbar (wie bisher).
  const ok = comments.remove(root, relPath, req.params.id, (c) => !c.author || mayChange(req.user, root, c));
  if (ok === null) return res.status(403).json({ error: 'Nur eigene Kommentare (oder der Eigentuemer) duerfen geloescht werden.' });
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

app.post('/api/history/restore', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  if (!canWriteRoot(req.user, root)) return res.status(403).json({ error: 'Kein Schreibrecht.' });
  const { id, file } = req.body;
  try {
    if (!id || !file || !isTextFile(file) || isIgnored(file.split('/')[0])) throw new Error('id und Textdatei sind erforderlich.');
    const abs = safeResolve(root, file);
    const buf = history.readSnapshotBuffer(root, id, file);
    if (buf === null) throw new Error('Datei war in dieser Version nicht vorhanden.');
    collab.flushRoot(root);
    history.snapshot(root, { trigger: 'restore' }); // aktuellen Stand sichern
    state.markSelfWrite(abs, buf);
    fs.writeFileSync(abs, buf);
    collab.applyExternalText(root, file, decodeText(buf)); // live fuer alle offenen Editoren
    const entry = safeSnapshot(root, { label: `Wiederhergestellt: ${file}`, trigger: 'restore' });
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Search / Replace ---

app.get('/api/refs', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  res.json(collectRefs(root));
});

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

// Latin-1 -> UTF-8, only on request; the snapshot before it keeps the original bytes.
app.post('/api/file/convert-utf8', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  if (!canWriteRoot(req.user, root)) return res.status(403).json({ error: 'Kein Schreibrecht.' });
  const file = String((req.body && req.body.path) || '');
  try {
    if (!isTextFile(file) || isIgnored(file.split('/')[0])) throw new Error('Keine Textdatei.');
    const abs = safeResolve(root, file);
    const buf = fs.readFileSync(abs);
    if (decodeText(buf) !== null) return res.json({ ok: true, converted: false });
    collab.flushRoot(root);
    history.snapshot(root, { label: `Vor UTF-8-Umwandlung: ${file}`, trigger: 'restore' });
    const content = toUtf8Text(buf);
    state.markSelfWrite(abs, content);
    fs.writeFileSync(abs, content, 'utf8');
    collab.applyExternalText(root, file, content);
    res.json({ ok: true, converted: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Last middleware: thrown/rejected route errors answer 500 instead of crashing the server.
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error('[route]', req.method, req.path, err.cause || err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Interner Fehler: ' + (err.message || err) });
});

const server = http.createServer(app);
wss = new WebSocketServer({ noServer: true, maxPayload: collab.WS_MAX_PAYLOAD });
const yjsWss = new WebSocketServer({ noServer: true, maxPayload: collab.WS_MAX_PAYLOAD });

collab.setHooks({
  markSelfWrite: (root, rel, text) => state.markSelfWrite(safeResolve(root, rel), text),
  onPersist: (root) => {
    safeSnapshot(root, { trigger: 'autosave' });
    maybeAutocompile(root, null);
  },
  // Disk write failed (retried with backoff) / works again: tell the windows on this project.
  onSaveState: (root, rel, failed) => broadcast(root, { type: 'saveFailed', path: rel, failed }),
});

function rejectUpgrade(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// /ws = app events (tree/pdf/compile), /yjs/<projectId>/<file> = live text sync.
server.on('upgrade', (req, socket, head) =>
  handleUpgrade(req, socket, head).catch((e) => {
    console.error('[upgrade]', e);
    socket.destroy();
  }),
);

async function handleUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  // Cross-site WebSocket hijacking guard (cookies ride along on upgrades).
  if (authMw.LOCAL_MODE && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return rejectUpgrade(socket, 403, 'Forbidden');
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== req.headers.host) return rejectUpgrade(socket, 403, 'Forbidden');
  }
  if (url.pathname === '/ws') {
    return wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (e) => console.warn('[ws] WebSocket-Fehler', e.code || e.message)); // see collab.handleConnection
      wss.emit('connection', ws, req);
    });
  }
  if (!url.pathname.startsWith('/yjs/')) return rejectUpgrade(socket, 404, 'Not Found');
  const parts = url.pathname.slice(5).split('/');
  if (parts.length !== 2) return rejectUpgrade(socket, 400, 'Bad Request');
  let root;
  let rel;
  try {
    root = path.resolve(PROJECTS_DIR, decodeURIComponent(parts[0]));
    rel = canonRel(decodeURIComponent(parts[1]));
    safeResolve(root, rel);
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  const userId = await authMw.getUserIdFromUpgradeRequest(req);
  const user = userId && auth.findUserById(userId);
  if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
  if (!canAccessRoot(user, root) || !isTextFile(rel) || !fs.existsSync(root)) return rejectUpgrade(socket, 403, 'Forbidden');
  const readOnly = roleOf(user, root) === 'reviewer';
  yjsWss.handleUpgrade(req, socket, head, (ws) => collab.handleConnection(ws, root, rel, url.searchParams.get('epoch'), readOnly));
}

wss.on('connection', (ws, req) => {
  // The first message (subscribe) can arrive while the session is still being looked up.
  const ready = authMw
    .getUserIdFromUpgradeRequest(req)
    .catch((e) => {
      console.error('[ws]', e);
      return null;
    })
    .then((userId) => {
      if (!userId) return ws.close();
      ws.userId = userId;
    });
  ws.on('message', async (data) => {
    await ready;
    if (!ws.userId) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && msg.type === 'ping') return ws.readyState === 1 && ws.send('{"type":"pong"}'); // client heartbeat
    if (!msg || msg.type !== 'subscribe') return;
    const user = auth.findUserById(ws.userId);
    const r = user && msg.projectId ? windowRoot({ user, get: () => String(msg.projectId), query: {} }) : {};
    if (msg.projectId && !r.root) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'projectGone', projectId: String(msg.projectId) }));
      return wsSubscribe(ws, null);
    }
    wsSubscribe(ws, r.root || null);
  });
  ws.on('close', () => {
    if (ws.root) releaseWatcher(ws.root);
  });
});

// Creates the admin account on first boot (no users.json yet) from
// ADMIN_EMAIL/ADMIN_PASSWORD, and migrates the old single-user
// activeRoot/recentRoots from workspace.json onto that admin so they keep
// their previously open project instead of starting from an empty dashboard.
async function bootstrapAdmin() {
  if (auth.users.length > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (authMw.LOCAL_MODE && !password) {
    // Lokal meldet sich niemand an → zufälliges Passwort statt des bekannten Fallbacks.
    await auth.createUser({ email: 'lokal@local.host', password: crypto.randomBytes(24).toString('hex'), username: 'lokal', isAdmin: true });
    return;
  }
  if (!email || !password) {
    console.warn(
      '[auth] ADMIN_EMAIL/ADMIN_PASSWORD nicht gesetzt - lege Fallback-Admin admin@local.host / bitte-sofort-aendern an. ' +
        'UNBEDINGT direkt nach dem ersten Login das Passwort im Profil ändern. ADMIN_* wirken nur beim allerersten Start (leerer Datenordner).'
    );
  }
  const adminUser = await auth.createUser({
    email: email || 'admin@local.host',
    password: password || 'bitte-sofort-aendern',
    username: process.env.ADMIN_USERNAME || 'admin',
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

// Sync-Papierkorb (.trash im Projekt) aller Projekte unter PROJECTS_DIR nach 30 Tagen leeren.
// Fremde, per Pfad geöffnete Ordner bleiben unberührt; geparkte Projekte laufen erst nach dem Zurückholen ab.
function purgeAllTrash() {
  const subdirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(d, e.name));
  const usersDir = path.join(PROJECTS_DIR, 'users');
  for (const base of [PROJECTS_DIR, ...subdirs(usersDir)]) {
    for (const root of subdirs(base)) {
      if (root === usersDir) continue;
      try {
        treeOps.purgeTrash(root);
      } catch (e) {
        console.error('[trash]', root, e.message);
      }
    }
  }
}

// docker stop / Ctrl+C: get pending live edits onto disk first.
function shutdown() {
  collab.flushAll();
  vault.flush();
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  // State is unknown now: save open live edits, then exit (Docker/systemd restarts).
  try {
    collab.flushAll();
    vault.flush();
  } catch {}
  process.exit(1);
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Lokal: Browserfenster zu → kein /ws-Client mehr → Änderungen sichern und beenden.
// ponytail: 30 s Gnadenfrist deckt Neuladen und langsamen Browserstart ab (LOCAL_IDLE_MS). Verwirft der
// Browser einen lange inaktiven Tab, ist der Server danach weg → einfach neu starten (Verknüpfung).
const LOCAL_IDLE_MS = Number(process.env.LOCAL_IDLE_MS) || 30000;

bootstrapAdmin()
  .then(() => {
    restoreWatchers();
    purgeAllTrash();
    setInterval(purgeAllTrash, 86400000).unref();
    if (authMw.LOCAL_MODE) {
      // Zweiter Start, während schon einer läuft: nur den Browser öffnen.
      server.on('error', (e) => {
        if (e.code !== 'EADDRINUSE') throw e;
        openBrowser(`http://localhost:${PORT}`);
        process.exit(0);
      });
      let idleSince = Date.now();
      setInterval(() => {
        if (wss.clients.size > 0) idleSince = Date.now();
        else if (Date.now() - idleSince > LOCAL_IDLE_MS) shutdown();
      }, 2000).unref();
    }
    server.listen(PORT, authMw.LOCAL_MODE ? '127.0.0.1' : undefined, () => {
      console.log(`LaTeX-IDE laeuft auf http://localhost:${PORT}`);
      if (authMw.LOCAL_MODE) return process.env.LOCAL_NO_BROWSER || openBrowser(`http://localhost:${PORT}`);
      // Fetch the desktop installers in the background so the first download doesn't wait on GitHub.
      if (UPDATE_MODE !== 'off') for (const os of ['windows', 'macos']) desktopAssets.assetFile(os).catch(() => {});
    });
  })
  .catch((e) => {
    console.error('Fehler beim Start (Admin-Bootstrap):', e);
    process.exit(1);
  });
