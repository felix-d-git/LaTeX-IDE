// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_PATH = path.join((process.env.DATA_DIR || path.join(__dirname, '..', '..')), 'auth-data.json');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage
const RESET_TTL_MS = 60 * 60 * 1000; // 1 Stunde
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 2 Tage
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MCP_PERMS = ['read', 'comment', 'edit', 'create', 'delete', 'move', 'compile'];
const LEGACY_LEVEL_PERMS = { read: ['read'], review: ['read', 'comment'], edit: ['read', 'comment', 'edit'] }; // before load(): migration uses it

function load() {
  if (fs.existsSync(DATA_PATH)) {
    // A damaged file must not silently turn into an empty account list (bootstrapAdmin would then create a new admin): keep a copy and refuse to start.
    let data;
    try {
      data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8').replace(/^﻿/, ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein JSON-Objekt');
    } catch (e) {
      try { fs.copyFileSync(DATA_PATH, `${DATA_PATH}.corrupt-${Date.now()}`); } catch (_) { /* best effort */ }
      throw new Error(`auth-data.json ist beschädigt/nicht lesbar (${e.message}). Kopie als .corrupt-* gesichert; Datei prüfen oder aus dem Backup wiederherstellen: ${DATA_PATH}`);
    }
    for (const k of ['users', 'invites', 'resetTokens', 'verifyTokens', 'apiTokens', 'mcpTokens']) if (!Array.isArray(data[k])) data[k] = [];
    if (!data.settings || typeof data.settings !== 'object') data.settings = {};
    data.mcpTokens.forEach(migrateMcpToken);
    return data;
  }
  return { users: [], invites: [], resetTokens: [], verifyTokens: [], apiTokens: [], mcpTokens: [], settings: {} };
}

// tmp + rename: a crash mid-write must never leave a truncated auth file behind.
function save(data) {
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_PATH);
}

const data = load();

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function findUserByEmail(email) {
  const norm = (email || '').trim().toLowerCase();
  return data.users.find((u) => u.email === norm) || null;
}

function findUserByUsername(name) {
  const norm = (name || '').trim().toLowerCase();
  return data.users.find((u) => u.username && u.username.toLowerCase() === norm) || null;
}

// Login field accepts either the e-mail address or the username.
function findUserByLogin(login) {
  return (login || '').includes('@') ? findUserByEmail(login) : findUserByUsername(login);
}

function findUserById(id) {
  return data.users.find((u) => u.id === id) || null;
}

// Accounts created before e-mail verification existed have no flag -> count as verified.
function isVerified(user) {
  return user.emailVerified !== false;
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username || user.email.split('@')[0],
    isAdmin: !!user.isAdmin,
    createdAt: user.createdAt,
  };
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
}

async function createUser({ email, password, isAdmin, username, emailVerified = true }) {
  const norm = (email || '').trim().toLowerCase();
  if (!norm || !/^\S+@\S+\.\S+$/.test(norm)) throw new Error('Ungültige E-Mail-Adresse.');
  validatePassword(password);
  if (username !== undefined && !USERNAME_RE.test(username || '')) {
    throw new Error('Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
  }
  // Same message for both duplicates would hide which one collides - but the
  // form is invite-gated, so telling an invited person which field to change wins.
  if (findUserByEmail(norm)) throw new Error('Für diese E-Mail-Adresse existiert bereits ein Konto.');
  if (username && findUserByUsername(username)) throw new Error('Dieser Benutzername ist schon vergeben.');
  const passwordHash = await bcrypt.hash(password, 12);
  // bcrypt yields the event loop: a double-submitted registration passes the checks above twice -> check again right before the push.
  if (findUserByEmail(norm)) throw new Error('Für diese E-Mail-Adresse existiert bereits ein Konto.');
  if (username && findUserByUsername(username)) throw new Error('Dieser Benutzername ist schon vergeben.');
  const user = {
    id: crypto.randomUUID(),
    email: norm,
    username: username || null,
    passwordHash,
    isAdmin: !!isAdmin,
    emailVerified: !!emailVerified,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  save(data);
  return user;
}

async function verifyPassword(user, password) {
  // Malformed bodies (password: 123, {}) would make bcrypt throw.
  if (typeof (password || '') !== 'string' || typeof user.passwordHash !== 'string') return false;
  return bcrypt.compare(password || '', user.passwordHash);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
}

async function setPassword(user, newPassword) {
  validatePassword(newPassword);
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordChangedAt = new Date().toISOString();
  save(data);
}

// --- Invites: admin generates a link, the recipient uses it once to self-register ---

function createInvite(createdByUserId) {
  const token = randomToken();
  data.invites.push({
    token,
    createdBy: createdByUserId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    usedBy: null,
    usedAt: null,
  });
  save(data);
  return token;
}

function listInvites() {
  return data.invites.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getValidInvite(token) {
  const invite = data.invites.find((i) => i.token === token);
  if (!invite) return null;
  if (invite.usedBy) return null;
  if (new Date(invite.expiresAt).getTime() < Date.now()) return null;
  return invite;
}

function consumeInvite(token, userId) {
  const invite = data.invites.find((i) => i.token === token);
  if (!invite) return;
  invite.usedBy = userId;
  invite.usedAt = new Date().toISOString();
  save(data);
}

function revokeInvite(token) {
  data.invites = data.invites.filter((i) => i.token !== token);
  save(data);
}

// --- Single-use, hashed, short-lived tokens (password reset + e-mail verification) ---

function createOneTimeToken(list, userId, ttl) {
  const token = randomToken();
  data[list] = data[list].filter((t) => t.userId !== userId); // invalidate older ones
  data[list].push({ tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + ttl).toISOString() });
  save(data);
  return token;
}

function consumeOneTimeToken(list, token) {
  const tokenHash = hashToken(token || '');
  const entry = data[list].find((t) => t.tokenHash === tokenHash);
  if (!entry) return null;
  data[list] = data[list].filter((t) => t.tokenHash !== tokenHash);
  save(data);
  if (new Date(entry.expiresAt).getTime() < Date.now()) return null;
  return findUserById(entry.userId);
}

const createResetToken = (userId) => createOneTimeToken('resetTokens', userId, RESET_TTL_MS);
const consumeResetToken = (token) => consumeOneTimeToken('resetTokens', token);
const createVerifyToken = (userId) => createOneTimeToken('verifyTokens', userId, VERIFY_TTL_MS);

function consumeVerifyToken(token) {
  const user = consumeOneTimeToken('verifyTokens', token);
  if (!user) return null;
  user.emailVerified = true;
  save(data);
  return user;
}

// --- API tokens for the desktop app (Authorization: Bearer), stored hashed ---

function createApiToken(userId, label) {
  const token = 'lide_' + randomToken();
  data.apiTokens.push({
    id: crypto.randomUUID(),
    tokenHash: hashToken(token),
    userId,
    label: String(label || 'Desktop-App').slice(0, 80),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  save(data);
  return token;
}

let lastUsedSaveAt = 0;
function findUserByApiToken(token) {
  if (!token || !token.startsWith('lide_')) return null;
  const tokenHash = hashToken(token);
  const entry = data.apiTokens.find((t) => t.tokenHash === tokenHash);
  if (!entry) return null;
  entry.lastUsedAt = new Date().toISOString();
  // ponytail: lastUsedAt is persisted at most once a minute - exact to the minute is enough for "zuletzt benutzt".
  if (Date.now() - lastUsedSaveAt > 60000) {
    lastUsedSaveAt = Date.now();
    save(data);
  }
  return findUserById(entry.userId);
}

function listApiTokens(userId) {
  return data.apiTokens
    .filter((t) => t.userId === userId)
    .map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
}

function revokeApiToken(userId, id) {
  data.apiTokens = data.apiTokens.filter((t) => !(t.userId === userId && t.id === id));
  save(data);
}

// --- MCP tokens (external AI tools): single rights, for all projects (perms) or per selected project (projects), stored hashed ---

// Old tokens had level read|review|edit (+ optional single project); compile was implicit, now off by default.
function migrateMcpToken(t) {
  if (t.perms) return;
  const perms = LEGACY_LEVEL_PERMS[t.level] || ['read'];
  t.perms = t.project ? [] : perms;
  t.projects = t.project ? { [t.project]: perms } : null;
  delete t.level;
  delete t.project;
}

function cleanMcpScope({ perms, projects }) {
  const clean = (list) => {
    if (!Array.isArray(list) || list.some((p) => !MCP_PERMS.includes(p))) throw new Error('Ungültige Rechte.');
    return MCP_PERMS.filter((p) => list.includes(p));
  };
  if (projects && typeof projects === 'object') {
    return { perms: [], projects: Object.fromEntries(Object.entries(projects).map(([id, l]) => [id, clean(l)])) };
  }
  return { perms: clean(perms), projects: null };
}

function createMcpToken(userId, { name, perms, projects }) {
  const scope = cleanMcpScope({ perms, projects });
  const token = 'lmcp_' + randomToken();
  data.mcpTokens.push({
    id: crypto.randomUUID(),
    tokenHash: hashToken(token),
    userId,
    name: String(name || 'KI-Tool').slice(0, 80),
    ...scope,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  save(data);
  return token;
}

// Rights/name can be changed later; the secret stays the same.
function updateMcpToken(userId, id, { name, perms, projects }) {
  const t = data.mcpTokens.find((x) => x.userId === userId && x.id === id);
  if (!t) return false;
  Object.assign(t, cleanMcpScope({ perms, projects }));
  if (name) t.name = String(name).slice(0, 80);
  save(data);
  return true;
}

// -> { user, perms, projects, name } or null (projects null = perms apply to every project)
function findMcpToken(token) {
  if (!token || !token.startsWith('lmcp_')) return null;
  const tokenHash = hashToken(token);
  const entry = data.mcpTokens.find((t) => t.tokenHash === tokenHash);
  const user = entry && findUserById(entry.userId);
  if (!user || !isVerified(user)) return null;
  entry.lastUsedAt = new Date().toISOString(); // in memory; persisted with the next save
  return { user, perms: entry.perms, projects: entry.projects, name: entry.name };
}

// Project folder renamed (newId) or gone/parked (newId null): tokens limited to projects follow it,
// otherwise a new project with the old name would inherit the rights.
function moveMcpProject(oldId, newId) {
  let changed = false;
  for (const t of data.mcpTokens) {
    if (!t.projects || !(oldId in t.projects)) continue;
    const perms = t.projects[oldId];
    delete t.projects[oldId];
    if (newId) t.projects[newId] = perms;
    changed = true;
  }
  if (changed) save(data);
}

function listMcpTokens(userId) {
  return data.mcpTokens
    .filter((t) => t.userId === userId)
    .map(({ id, name, perms, projects, createdAt, lastUsedAt }) => ({ id, name, perms, projects, createdAt, lastUsedAt }));
}

function revokeMcpToken(userId, id) {
  data.mcpTokens = data.mcpTokens.filter((t) => !(t.userId === userId && t.id === id));
  save(data);
}

// Removes the account and everything keyed to it (tokens, invites it used stay as history).
// Zotero-Zugang je Nutzer (Literatur importieren); nie über toPublicUser ausgeliefert.
function setZotero(userId, zotero) {
  const user = findUserById(userId);
  if (!user) return;
  if (zotero) user.zotero = zotero;
  else delete user.zotero;
  save(data);
}

// Admin settings (SMTP, verification mode) live in auth-data.json -> covered by the vault like the accounts.
function getSettings() {
  return data.settings;
}

function setSettings(patch) {
  Object.assign(data.settings, patch);
  save(data);
}

function markVerified(id) {
  const user = findUserById(id);
  if (!user) return false;
  user.emailVerified = true;
  data.verifyTokens = data.verifyTokens.filter((t) => t.userId !== id);
  save(data);
  return true;
}

function listUsers() {
  return data.users.slice();
}

function deleteUser(id) {
  data.users = data.users.filter((u) => u.id !== id);
  for (const k of ['apiTokens', 'mcpTokens', 'resetTokens', 'verifyTokens']) data[k] = data[k].filter((t) => t.userId !== id);
  save(data);
}

module.exports = {
  getSettings,
  setSettings,
  markVerified,
  moveMcpProject,
  validatePassword,
  deleteUser,
  listUsers,
  setZotero,
  findUserByEmail,
  findUserByUsername,
  findUserByLogin,
  findUserById,
  isVerified,
  toPublicUser,
  createUser,
  verifyPassword,
  setPassword,
  validatePassword,
  createInvite,
  listInvites,
  getValidInvite,
  consumeInvite,
  revokeInvite,
  createResetToken,
  consumeResetToken,
  createVerifyToken,
  consumeVerifyToken,
  createApiToken,
  findUserByApiToken,
  listApiTokens,
  revokeApiToken,
  createMcpToken,
  updateMcpToken,
  findMcpToken,
  listMcpTokens,
  revokeMcpToken,
  MCP_PERMS,
  USERNAME_RE,
  get users() {
    return data.users;
  },
};
