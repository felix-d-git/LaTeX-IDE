const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_PATH = path.join((process.env.DATA_DIR || path.join(__dirname, '..', '..')), 'auth-data.json');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage
const RESET_TTL_MS = 60 * 60 * 1000; // 1 Stunde
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 2 Tage
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function load() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      for (const k of ['users', 'invites', 'resetTokens', 'verifyTokens', 'apiTokens']) if (!data[k]) data[k] = [];
      return data;
    } catch (e) {
      // fall through to default
    }
  }
  return { users: [], invites: [], resetTokens: [], verifyTokens: [], apiTokens: [] };
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

async function createUser({ email, password, isAdmin, username, emailVerified = true }) {
  const norm = (email || '').trim().toLowerCase();
  if (!norm || !/^\S+@\S+\.\S+$/.test(norm)) throw new Error('Ungültige E-Mail-Adresse.');
  if (!password || password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
  if (username !== undefined && !USERNAME_RE.test(username || '')) {
    throw new Error('Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
  }
  // Same message for both duplicates would hide which one collides - but the
  // form is invite-gated, so telling an invited person which field to change wins.
  if (findUserByEmail(norm)) throw new Error('Für diese E-Mail-Adresse existiert bereits ein Konto.');
  if (username && findUserByUsername(username)) throw new Error('Dieser Benutzername ist schon vergeben.');
  const passwordHash = await bcrypt.hash(password, 12);
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
  return bcrypt.compare(password || '', user.passwordHash);
}

async function setPassword(user, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
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

module.exports = {
  findUserByEmail,
  findUserByUsername,
  findUserByLogin,
  findUserById,
  isVerified,
  toPublicUser,
  createUser,
  verifyPassword,
  setPassword,
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
  USERNAME_RE,
  get users() {
    return data.users;
  },
};
