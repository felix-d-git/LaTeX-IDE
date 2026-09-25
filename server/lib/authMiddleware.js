const path = require('path');
const crypto = require('crypto');
const cookie = require('cookie');
const signature = require('cookie-signature');
const session = require('express-session');
const FileStoreFactory = require('session-file-store');
const auth = require('./auth');

const FileStore = FileStoreFactory(session);

const SESSION_COOKIE_NAME = 'latex_ide_sid';
const CSRF_COOKIE_NAME = 'csrfToken';
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 Tage

// Falls kein SESSION_SECRET gesetzt ist (Testsetup), generieren wir einen
// Zufallswert fuer die Laufzeit - Logins ueberleben dann keinen Neustart.
// Fuer den Pi-Deploy zwingend SESSION_SECRET in der Umgebung setzen.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET nicht gesetzt - Sessions ueberleben keinen Server-Neustart. Fuer Produktivbetrieb einen festen Wert in der Umgebung setzen.');
}

const sessionStore = new FileStore({
  path: path.join((process.env.DATA_DIR || path.join(__dirname, '..', '..')), '.sessions'),
  logFn: () => {},
});

function createSessionMiddleware() {
  return session({
    name: SESSION_COOKIE_NAME,
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      // no maxAge here = regular session cookie (expires on browser close);
      // login sets an explicit maxAge on req.session.cookie when "Angemeldet bleiben" is checked.
    },
  });
}

function ensureCsrfCookie(req, res, next) {
  let token = req.cookies[CSRF_COOKIE_NAME];
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // client JS must read this to echo it back in the X-CSRF-Token header
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
    });
  }
  req.csrfToken = token;
  next();
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function checkCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  // Bearer requests (desktop app) carry no cookies, so they can't be forged cross-site.
  if (bearerToken(req) && !req.headers.cookie) return next();
  const header = req.get('X-CSRF-Token');
  if (!header || header !== req.cookies[CSRF_COOKIE_NAME]) {
    return res.status(403).json({ error: 'CSRF-Prüfung fehlgeschlagen. Bitte Seite neu laden und erneut versuchen.' });
  }
  next();
}

// A password change logs out every other session: sessions older than the
// change are rejected (the changing session re-stamps its own loginAt).
function sessionUser(sessionData) {
  if (!sessionData || !sessionData.userId) return null;
  const user = auth.findUserById(sessionData.userId);
  if (!user || !auth.isVerified(user)) return null;
  if (user.passwordChangedAt && (sessionData.loginAt || 0) < new Date(user.passwordChangedAt).getTime()) return null;
  return user;
}

function currentUser(req) {
  const token = bearerToken(req);
  if (token) return auth.findUserByApiToken(token);
  return sessionUser(req.session);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  req.user = user;
  next();
}

// ponytail: in-memory fixed-window limiter, resets on restart - enough for a handful of users behind one Funnel.
const hits = new Map();
function rateLimit(name, max, windowMs, keyFn = (req) => req.ip) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    if (e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut probieren.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
}, 10 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Nur fuer Admins.' });
  }
  next();
}

function applyRememberMe(req, rememberMe) {
  if (rememberMe) req.session.cookie.maxAge = REMEMBER_ME_MAX_AGE;
}

// Resolves the userId for an incoming WebSocket upgrade request by manually
// parsing + unsigning the session cookie and loading the session from the
// same store express-session uses for regular HTTP requests.
function getUserIdFromUpgradeRequest(req) {
  const token = bearerToken(req);
  if (token) {
    const user = auth.findUserByApiToken(token);
    return Promise.resolve(user ? user.id : null);
  }
  return new Promise((resolve) => {
    const header = req.headers.cookie;
    if (!header) return resolve(null);
    const cookies = cookie.parseCookie(header);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (!raw || !raw.startsWith('s:')) return resolve(null);
    const sid = signature.unsign(raw.slice(2), SESSION_SECRET);
    if (!sid) return resolve(null);
    sessionStore.get(sid, (err, sessionData) => {
      const user = err ? null : sessionUser(sessionData);
      resolve(user ? user.id : null);
    });
  });
}

module.exports = {
  createSessionMiddleware,
  ensureCsrfCookie,
  checkCsrf,
  requireAuth,
  requireAdmin,
  currentUser,
  rateLimit,
  applyRememberMe,
  getUserIdFromUpgradeRequest,
  CSRF_COOKIE_NAME,
};
