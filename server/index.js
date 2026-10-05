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
const { compile, findMainCandidate, OUT_DIR, BACKEND } = require('./lib/compile');
// tectonic has no openin_any=p: a document could \input other users' projects or auth-data.json.
if (BACKEND !== 'latexmk') throw new Error('TEX_BACKEND=tectonic ist nur für die Desktop-App erlaubt (liest Dateien außerhalb des Projekts).');
const { searchProject, replaceInProject, collectRefs } = require('./lib/search');
const { startWatcher } = require('./lib/watcher');
const projects = require('./lib/projects');
const treeOps = require('./lib/treeOps');
const comments = require('./lib/comments');
const history = require('./lib/history');
const synctex = require('./lib/synctex');
const wordcount = require('./lib/wordcount');
const { createDesktopAssets } = require('./lib/desktopAssets');
const state = require('./state');
const auth = require('./lib/auth');
const mailer = require('./lib/mailer');
const authMw = require('./lib/authMiddleware');
const collab = require('./lib/collab');

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

function activeMainPdfAbs(root, userId) {
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return null;
  return path.join(root, outRelFor(root, userId), main.replace(/\.tex$/i, '.pdf'));
}

const PORT = process.env.PORT || 3077;
const PROJECTS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'projects');

const app = express();
// Behind Tailscale Funnel/serve: real client IP (rate limits) + https for baseUrl.
app.set('trust proxy', 'loopback, uniquelocal');
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(authMw.createSessionMiddleware());
app.use(authMw.ensureCsrfCookie);
app.use(authMw.checkCsrf);
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/dist', express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use('/katex', express.static(path.join(__dirname, '..', 'node_modules', 'katex', 'dist')));

// Fehlende/gesperrte Datei beim Streamen: 404 statt unbehandeltem Stream-Fehler (Server-Absturz).
function streamFile(res, abs) {
  fs.createReadStream(abs)
    .on('error', () => {
      if (res.headersSent) return res.destroy();
      res.removeHeader('Content-Disposition');
      res.status(404).json({ error: 'Datei nicht gefunden.' });
    })
    .pipe(res);
}

let wss = null;
const lastAutocompileAt = new Map(); // root -> timestamp, throttles autocompile-on-save
const AUTOCOMPILE_THROTTLE_MS = 5000;
const wordCountByOut = new Map(); // abs output dir -> { words, headers, mathInline, mathDisplay }, refreshed on each successful compile

// userId = who saved; null (collab persist) = everyone who has the project open.
function maybeAutocompile(root, userId) {
  const settings = state.getProjectSettings(root);
  if (!settings.autocompile) return;
  const last = lastAutocompileAt.get(root) || 0;
  if (Date.now() - last < AUTOCOMPILE_THROTTLE_MS) return;
  lastAutocompileAt.set(root, Date.now());
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (!main) return;
  const users = userId ? [userId] : [...new Set([...(wss ? wss.clients : [])].filter((c) => c.userId && state.getActiveRoot(c.userId) === root).map((c) => c.userId))];
  if (settings.compileMode === 'group') users.splice(1);
  for (const u of users) runCompile(root, main, u).catch(() => {});
}

// Multiple users can have different projects open at the same time, so
// broadcasts and file watchers must be scoped per project root instead of
// the single global watcher/broadcast-to-everyone the tool used as a
// single-user MVP. Each ws client only receives events for the root that is
// currently that connection's user's active project (looked up live, not
// cached, so switching projects takes effect immediately).
const watchersByRoot = new Map(); // root -> { watcher, refCount }

// onlyUserId: restrict to one user's connections (per-user compile events).
function broadcast(root, msg, onlyUserId) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (onlyUserId && client.userId !== onlyUserId) return;
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
  // Access can be revoked (share removed) while the project is still "active".
  if (!canAccessRoot(req.user, root)) {
    res.status(403).json({ error: 'Kein Zugriff mehr auf dieses Projekt.' });
    return null;
  }
  return root;
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

function canAccessRoot(user, root) {
  if (!user || !root) return false;
  if (canManageRoot(user, root)) return true;
  return state.getShares(path.resolve(root)).includes(user.id);
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

const limitLogin = authMw.rateLimit('login', 10, 15 * 60 * 1000);
const limitRegister = authMw.rateLimit('register', 10, 60 * 60 * 1000);
const limitMail = authMw.rateLimit('mail', 5, 15 * 60 * 1000);
const limitToken = authMw.rateLimit('token', 30, 15 * 60 * 1000);

async function sendVerifyMail(req, user) {
  const token = auth.createVerifyToken(user.id);
  await mailer.sendMail({
    to: user.email,
    subject: 'LaTeX Web IDE - E-Mail-Adresse bestätigen',
    text: `Hallo ${user.username || ''},\n\nbitte bestätige deine E-Mail-Adresse (Link gültig 48 Stunden):\n${baseUrl(req)}/?verify=${token}\n\nFalls du dich nicht registriert hast, ignoriere diese Mail.`,
  });
}

// Registration stays invite-gated: without a valid admin token nobody gets an account.
app.post('/api/auth/register', limitRegister, async (req, res) => {
  const { token, username, email, password } = req.body;
  const invite = auth.getValidInvite(token || '');
  if (!invite) return res.status(400).json({ error: 'Der Einladungslink ist ungültig, abgelaufen oder bereits verwendet.' });
  try {
    const user = await auth.createUser({ email, password, username: (username || '').trim(), isAdmin: false, emailVerified: false });
    auth.consumeInvite(token, user.id);
    await sendVerifyMail(req, user);
    res.json({ ok: true, needsVerification: true, message: `Fast geschafft: Wir haben dir eine Bestätigungsmail an ${user.email} geschickt.` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/verify', limitToken, (req, res) => {
  const user = auth.consumeVerifyToken(req.body.token || '');
  if (!user) return res.status(400).json({ error: 'Der Bestätigungslink ist ungültig oder abgelaufen. Beim Anmelden kannst du einen neuen anfordern.' });
  res.json({ ok: true, message: 'E-Mail-Adresse bestätigt. Du kannst dich jetzt anmelden.' });
});

app.post('/api/auth/resend-verification', limitMail, async (req, res) => {
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  if (user && !auth.isVerified(user)) await sendVerifyMail(req, user);
  res.json({ ok: true, message: 'Falls ein unbestätigtes Konto existiert, wurde eine neue Bestätigungsmail verschickt.' });
});

app.post('/api/auth/login', limitLogin, async (req, res) => {
  const { password, rememberMe } = req.body;
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  const ok = user && (await auth.verifyPassword(user, password));
  if (!ok) return res.status(401).json({ error: 'Benutzername/E-Mail oder Passwort falsch.' });
  if (!auth.isVerified(user)) {
    return res.status(403).json({ error: 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungsmail).', unverified: true });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Anmeldung fehlgeschlagen.' });
    req.session.userId = user.id;
    req.session.loginAt = Date.now();
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
  const user = authMw.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ user: auth.toPublicUser(user) });
});

app.post('/api/auth/forgot-password', limitMail, async (req, res) => {
  const user = auth.findUserByLogin(req.body.login || req.body.email || '');
  // Always answer the same way, whether or not the account exists -
  // otherwise the endpoint would leak which e-mails/usernames are registered.
  if (user) {
    const token = auth.createResetToken(user.id);
    const link = `${baseUrl(req)}/?reset=${token}`;
    await mailer.sendMail({
      to: user.email,
      subject: 'LaTeX Web IDE - Passwort zurücksetzen',
      text: `Zum Zurücksetzen deines Passworts auf diesen Link klicken (gültig 1 Stunde):\n${link}\n\nFalls du das nicht angefordert hast, ignoriere diese Mail.`,
    });
  }
  res.json({ ok: true, message: 'Falls das Konto existiert, wurde ein Link zum Zurücksetzen an die hinterlegte E-Mail-Adresse verschickt.' });
});

app.post('/api/auth/reset-password', limitToken, async (req, res) => {
  const { token, password } = req.body;
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

// --- Admin: server updates (like Nextcloud/Immich: banner for admins) ---
// UPDATE_MODE per host: off | notify (banner only, default) | button (admin can request
// the update) | auto (host cron installs nightly). Installing is always done by
// scripts/server-update.sh on the host; "button" only drops a request file it picks up.
const UPDATE_MODE = process.env.UPDATE_MODE || 'notify';
const UPDATE_REPO = process.env.UPDATE_REPO || 'felix-d-git/latex-web-ide';
const UPDATE_REQUEST = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.update-request');
const APP_VERSION = require('../package.json').version;
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

app.get('/api/admin/update', authMw.requireAuth, authMw.requireAdmin, async (req, res) => {
  const base = { current: APP_VERSION, mode: UPDATE_MODE, requested: fs.existsSync(UPDATE_REQUEST) };
  if (UPDATE_MODE === 'off') return res.json({ ...base, available: false });
  try {
    const rel = await latestRelease();
    res.json({ ...base, available: !!rel.version && isNewer(rel.version, APP_VERSION), version: rel.version, url: rel.url });
  } catch (e) {
    res.json({ ...base, available: false, error: e.message });
  }
});

app.post('/api/admin/update', authMw.requireAuth, authMw.requireAdmin, (req, res) => {
  if (UPDATE_MODE !== 'button') return res.status(400).json({ error: 'Update per Button ist auf diesem Server nicht aktiviert (UPDATE_MODE).' });
  fs.writeFileSync(UPDATE_REQUEST, new Date().toISOString());
  res.json({ ok: true });
});

// --- Everything below requires a logged-in user ---
app.use('/api', authMw.requireAuth);

// --- Desktop installers with this server's address built in (also the desktop apps' update source) ---
const desktopAssets = createDesktopAssets({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..'),
  repo: UPDATE_REPO,
  token: process.env.UPDATE_TOKEN,
  version: APP_VERSION,
});

app.get('/api/desktop/release', async (req, res) => {
  try {
    res.json({ version: APP_VERSION, ...(await desktopAssets.available()) });
  } catch (e) {
    res.json({ version: APP_VERSION, windows: false, macos: false, error: e.message });
  }
});

app.get('/api/desktop/download/:os', async (req, res) => {
  try {
    await desktopAssets.send(req.params.os, baseUrl(req).replace(/\/+$/, ''), res);
  } catch (e) {
    if (res.headersSent) return res.destroy(e);
    res.status(502).json({ error: e.message });
  }
});

// --- Account (logged in) ---

app.post('/api/auth/change-password', limitLogin, async (req, res) => {
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
});

// Delete own account incl. all projects in projects/users/<id> (also trash/archive).
// The admin owns the top-level projects/ folder and can't delete itself.
app.post('/api/auth/delete-account', limitLogin, async (req, res) => {
  if (req.user.isAdmin) return res.status(400).json({ error: 'Das Admin-Konto kann nicht gelöscht werden.' });
  if (!(await auth.verifyPassword(req.user, req.body.password))) {
    return res.status(400).json({ error: 'Passwort ist falsch.' });
  }
  const ownDir = path.resolve(path.join(PROJECTS_DIR, 'users', req.user.id));
  for (const [root, entry] of watchersByRoot) {
    if (isInside(ownDir, root)) {
      entry.watcher.close();
      watchersByRoot.delete(root);
    }
  }
  if (wss) wss.clients.forEach((c) => c.userId === req.user.id && c.close());
  fs.rmSync(ownDir, { recursive: true, force: true });
  state.purgeUser(req.user.id, ownDir);
  auth.deleteUser(req.user.id);
  req.session.destroy(() => {
    res.clearCookie('latex_ide_sid');
    res.json({ ok: true });
  });
});

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
  return {
    canManage: canManageRoot(user, root),
    owner: toMember(ownerIdOf(root)),
    members: state.getShares(path.resolve(root)).map(toMember).filter(Boolean),
  };
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
  const target = auth.findUserByLogin(req.body.login || '');
  if (!target || !auth.isVerified(target)) return res.status(404).json({ error: 'Kein bestätigtes Konto mit diesem Benutzernamen / dieser E-Mail.' });
  if (canManageRoot(target, root)) return res.status(400).json({ error: 'Diese Person hat bereits Zugriff.' });
  const key = path.resolve(root);
  const ids = state.getShares(key);
  if (!ids.includes(target.id)) state.setShares(key, [...ids, target.id]);
  res.json(shareInfo(root, req.user));
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
    res.json({ projectId: projectIdOf(root), epoch: collab.getEpoch(root, req.query.path) });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// File list with hashes for the desktop app's local compile mirror.
app.get('/api/collab/manifest', (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  collab.flushRoot(root);
  const files = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (isIgnored(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) {
        const buf = fs.readFileSync(path.join(root, r));
        files.push({ path: r, size: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex') });
      }
    }
  };
  walk('');
  res.json({
    projectId: projectIdOf(root),
    mainFile: state.getMainFile(root) || findMainCandidate(root),
    settings: state.getProjectSettings(root),
    files,
  });
});

// Projects the user owns = what the desktop app keeps as offline copy.
app.get('/api/collab/owned', (req, res) => {
  const dir = userProjectsDir(req.user);
  const list = projects
    .listProjects(dir)
    .filter((p) => !(req.user.isAdmin && p.name === 'users'))
    .map((p) => ({ name: p.name, projectId: projectIdOf(path.join(dir, p.name)) }));
  res.json({ projects: list });
});

// Desktop sync upload/delete of one file (bytes as body) in an owned project.
app.put('/api/collab/raw', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  const root = requireSyncRoot(req, res);
  if (!root) return;
  try {
    const rel = String(req.query.path || '');
    if (isIgnored(rel.split('/')[0])) throw new Error('Pfad nicht erlaubt.');
    const abs = safeResolve(root, rel);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    state.selfWrittenHashes.set(rel, crypto.createHash('sha1').update(buf).digest('hex'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    if (isTextFile(rel)) collab.applyExternalText(root, rel, buf.toString('utf8'));
    history.snapshot(root, { trigger: 'autosave' });
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
    treeOps.deletePath(root, req.query.path);
    collab.onPathMoved(root, req.query.path, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Projects ---

app.get('/api/projects/list', (req, res) => {
  const projectsDir = userProjectsDir(req.user);
  res.json({
    activeRoot: state.getActiveRoot(req.user.id),
    recentRoots: state.getRecentRoots(req.user.id),
    localProjects: projects.listProjects(projectsDir).filter((p) => !(req.user.isAdmin && p.name === 'users')),
    sharedProjects: state
      .sharedRootsFor(req.user.id)
      .filter((root) => fs.existsSync(root))
      .map((root) => {
        const owner = auth.findUserById(ownerIdOf(root));
        return { name: path.basename(root), root, owner: owner ? auth.toPublicUser(owner).username : '?', lastModified: fs.statSync(root).mtimeMs };
      }),
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
  const main = state.getMainFile(root) || findMainCandidate(root);
  if (main) state.setMainFile(root, main);
  res.json({ activeRoot: root, mainFile: main, projectId: projectIdOf(root) });
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
    collab.flushRoot(root);
    // ponytail: members who have this project open keep the old path until they reopen it from the dashboard.
    const newRoot = projects.renameProject(projectsDir, oldName, newName);
    state.moveRoot(path.resolve(root), path.resolve(newRoot));
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
  collab.flushRoot(root);
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
  const pdfAbs = path.join(root, outRelFor(root, req.user.id), main.replace(/\.tex$/i, '.pdf'));
  if (!fs.existsSync(pdfAbs)) return res.status(404).json({ error: 'Noch kein PDF für dieses Projekt kompiliert.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.pdf"`);
  streamFile(res, pdfAbs);
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
  res.json({ tree: buildTree(root), mainFile: state.getMainFile(root), projectId: projectIdOf(root) });
});

app.get('/api/file', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  try {
    const abs = safeResolve(root, req.query.path);
    collab.flushRoot(root);
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
    collab.applyExternalText(root, relPath, content);
    history.snapshot(root, { trigger: 'autosave' });
    maybeAutocompile(root, req.user.id);
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
    collab.flushRoot(root);
    const relPath = treeOps.renamePath(root, req.body.path, req.body.newName);
    collab.onPathMoved(root, req.body.path, relPath);
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
    if (req.body.overwrite) collab.onPathMoved(root, relPath, null);
    collab.onPathMoved(root, req.body.path, relPath);
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
    collab.onPathMoved(root, req.query.path, null);
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

// The Pi compiles one document at a time; a second request for the same
// project while it is still waiting shares the queued run.
// ponytail: one global queue - per-core workers if the server gets stronger.
let compileChain = Promise.resolve();
const queuedCompile = new Map(); // output dir -> promise of a not-yet-started run

function runCompile(root, main, userId) {
  const outRel = outRelFor(root, userId);
  const key = path.join(root, outRel);
  // Group mode: everyone on the project sees the run; individual: only the compiling user.
  const to = outRel === OUT_DIR ? undefined : userId;
  if (queuedCompile.has(key)) return queuedCompile.get(key);
  broadcast(root, { type: 'compileStatus', status: 'running' }, to);
  const run = compileChain.then(() => {
    queuedCompile.delete(key);
    return doCompile(root, main, outRel, to);
  });
  queuedCompile.set(key, run);
  compileChain = run.catch(() => {});
  return run;
}

async function doCompile(root, main, outRel, to) {
  collab.flushRoot(root);
  const result = await compile(root, main, state.getProjectSettings(root), outRel);
  const status = result.success ? 'success' : result.pdfPath ? 'warning' : 'error';
  broadcast(root, { type: 'compileStatus', status, log: result.log }, to);
  if (result.pdfPath) broadcast(root, { type: 'pdfChanged', path: result.pdfPath }, to);
  history.snapshot(root, { trigger: 'compile' });
  if (result.pdfPath) {
    try {
      wordCountByOut.set(path.join(root, outRel), wordcount.countWords(root, main));
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
  const result = await runCompile(root, main, req.user.id);
  res.json(result);
});

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
// Overleaf-style menu bar), skipping the same generated/hidden dirs the file
// tree already hides (fsTree.isIgnored).
app.get('/api/download/zip', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const name = path.basename(root) || 'project';
  collab.flushRoot(root);
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
});

app.get('/api/synctex/inverse', async (req, res) => {
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

// Kein Reviewer-/Rollenmodell in dieser Basis: jeder mit Zugriff darf schreiben.
// Einziger Haken fuer spaetere Rollen (Verlauf-Wiederherstellen).
function canWriteRoot(user, root) {
  return canAccessRoot(user, root);
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
    const content = history.readSnapshotFile(root, id, file);
    if (content === null) throw new Error('Datei war in dieser Version nicht vorhanden.');
    collab.flushRoot(root);
    history.snapshot(root, { trigger: 'restore' }); // aktuellen Stand sichern
    state.selfWrittenHashes.set(file, crypto.createHash('sha1').update(content).digest('hex'));
    fs.writeFileSync(abs, content, 'utf8');
    collab.applyExternalText(root, file, content); // live fuer alle offenen Editoren
    const entry = history.snapshot(root, { label: `Wiederhergestellt: ${file}`, trigger: 'restore' });
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

app.post('/api/replace', (req, res) => {
  const root = requireRoot(req, res);
  if (!root) return;
  const { query, replacement, regex, caseSensitive, wholeWord } = req.body;
  try {
    collab.flushRoot(root);
    const result = replaceInProject(root, query, replacement, { regex, caseSensitive, wholeWord });
    for (const f of result.changedFiles) {
      const content = fs.readFileSync(path.join(root, f.file), 'utf8');
      state.selfWrittenHashes.set(f.file, crypto.createHash('sha1').update(content).digest('hex'));
      collab.applyExternalText(root, f.file, content);
      broadcast(root, { type: 'fileChanged', path: f.file, content, changedRanges: [], source: 'replace' });
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const server = http.createServer(app);
wss = new WebSocketServer({ noServer: true });
const yjsWss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 });

collab.setHooks({
  markSelfWrite: (root, rel, text) => state.selfWrittenHashes.set(rel, crypto.createHash('sha1').update(text).digest('hex')),
  onPersist: (root) => {
    history.snapshot(root, { trigger: 'autosave' });
    maybeAutocompile(root, null);
  },
});

function rejectUpgrade(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// /ws = app events (tree/pdf/compile), /yjs/<projectId>/<file> = live text sync.
server.on('upgrade', async (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  // Cross-site WebSocket hijacking guard (cookies ride along on upgrades).
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== req.headers.host) return rejectUpgrade(socket, 403, 'Forbidden');
  }
  if (url.pathname === '/ws') {
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  if (!url.pathname.startsWith('/yjs/')) return rejectUpgrade(socket, 404, 'Not Found');
  const parts = url.pathname.slice(5).split('/');
  if (parts.length !== 2) return rejectUpgrade(socket, 400, 'Bad Request');
  let root;
  let rel;
  try {
    root = path.resolve(PROJECTS_DIR, decodeURIComponent(parts[0]));
    rel = decodeURIComponent(parts[1]);
    safeResolve(root, rel);
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  const userId = await authMw.getUserIdFromUpgradeRequest(req);
  const user = userId && auth.findUserById(userId);
  if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
  if (!canAccessRoot(user, root) || !isTextFile(rel) || !fs.existsSync(root)) return rejectUpgrade(socket, 403, 'Forbidden');
  yjsWss.handleUpgrade(req, socket, head, (ws) => collab.handleConnection(ws, root, rel, url.searchParams.get('epoch')));
});

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

// docker stop / Ctrl+C: get pending live edits onto disk first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    collab.flushAll();
    process.exit(0);
  });
}

bootstrapAdmin()
  .then(() => {
    restoreWatchers();
    server.listen(PORT, () => {
      console.log(`LaTeX Web IDE laeuft auf http://localhost:${PORT}`);
      // Fetch the desktop installers in the background so the first download doesn't wait on GitHub.
      if (UPDATE_MODE !== 'off') for (const os of ['windows', 'macos']) desktopAssets.assetFile(os).catch(() => {});
    });
  })
  .catch((e) => {
    console.error('Fehler beim Start (Admin-Bootstrap):', e);
    process.exit(1);
  });
