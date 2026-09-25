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
  path: path.join(__dirname, '..', '..', '.sessions'),
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

function checkCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const header = req.get('X-CSRF-Token');
  if (!header || header !== req.cookies[CSRF_COOKIE_NAME]) {
    return res.status(403).json({ error: 'CSRF-Prüfung fehlgeschlagen. Bitte Seite neu laden und erneut versuchen.' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  const user = auth.findUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  req.user = user;
  next();
}

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
  return new Promise((resolve) => {
    const header = req.headers.cookie;
    if (!header) return resolve(null);
    const cookies = cookie.parseCookie(header);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (!raw || !raw.startsWith('s:')) return resolve(null);
    const sid = signature.unsign(raw.slice(2), SESSION_SECRET);
    if (!sid) return resolve(null);
    sessionStore.get(sid, (err, sessionData) => {
      if (err || !sessionData) return resolve(null);
      resolve(sessionData.userId || null);
    });
  });
}

module.exports = {
  createSessionMiddleware,
  ensureCsrfCookie,
  checkCsrf,
  requireAuth,
  requireAdmin,
  applyRememberMe,
  getUserIdFromUpgradeRequest,
  CSRF_COOKIE_NAME,
};
