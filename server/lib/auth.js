const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_PATH = path.join(__dirname, '..', '..', 'auth-data.json');
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage
const RESET_TTL_MS = 60 * 60 * 1000; // 1 Stunde

function load() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      if (!data.users) data.users = [];
      if (!data.invites) data.invites = [];
      if (!data.resetTokens) data.resetTokens = [];
      return data;
    } catch (e) {
      // fall through to default
    }
  }
  return { users: [], invites: [], resetTokens: [] };
}

function save(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
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

function findUserById(id) {
  return data.users.find((u) => u.id === id) || null;
}

function toPublicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, isAdmin: !!user.isAdmin, createdAt: user.createdAt };
}

async function createUser({ email, password, isAdmin }) {
  const norm = (email || '').trim().toLowerCase();
  if (!norm || !/^\S+@\S+\.\S+$/.test(norm)) throw new Error('Ungültige E-Mail-Adresse.');
  if (!password || password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
  if (findUserByEmail(norm)) throw new Error('Für diese E-Mail-Adresse existiert bereits ein Konto.');
  const passwordHash = await bcrypt.hash(password, 12);
  const user = {
    id: crypto.randomUUID(),
    email: norm,
    passwordHash,
    isAdmin: !!isAdmin,
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

// --- Password reset tokens: stored hashed, single-use, short-lived ---

function createResetToken(userId) {
  const token = randomToken();
  data.resetTokens = data.resetTokens.filter((t) => t.userId !== userId); // invalidate older ones
  data.resetTokens.push({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
  });
  save(data);
  return token;
}

function consumeResetToken(token) {
  const tokenHash = hashToken(token || '');
  const entry = data.resetTokens.find((t) => t.tokenHash === tokenHash);
  if (!entry) return null;
  data.resetTokens = data.resetTokens.filter((t) => t.tokenHash !== tokenHash);
  save(data);
  if (new Date(entry.expiresAt).getTime() < Date.now()) return null;
  return findUserById(entry.userId);
}

module.exports = {
  findUserByEmail,
  findUserById,
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
  get users() {
    return data.users;
  },
};
