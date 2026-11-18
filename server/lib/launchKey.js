// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Start-Schlüssel (#163) für Desktop-Proxy und LOCAL_MODE: pro Start zufällig, nur im vom Prozess selbst
// geöffneten Link (?k=). Daraus wird ein HttpOnly-Cookie; ohne Cookie antwortet alles 403, auch /ws.
// Der Schlüssel liegt nach dem Bind zusätzlich in <Datenordner>/.launch-key (0600), damit ein zweiter Start
// (Port belegt) den Browser mit dem richtigen Link öffnen kann.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'lideLocal';
const KEY_FILE = '.launch-key';

const generate = () => crypto.randomBytes(32).toString('hex');

function save(dir, key) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, KEY_FILE);
  fs.rmSync(file, { force: true }); // mode gilt nur beim Neuanlegen
  fs.writeFileSync(file, key, { mode: 0o600 });
}

function read(dir) {
  try {
    return fs.readFileSync(path.join(dir, KEY_FILE), 'utf8').trim();
  } catch {
    return null;
  }
}

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function hasCookie(req, key) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return !!m && same(m[1], key);
}

// Express-Middleware: ?k=<Schlüssel> -> Cookie + Weiterleitung ohne k; sonst ohne Cookie 403.
function middleware(key) {
  return (req, res, next) => {
    const u = new URL(req.originalUrl, 'http://localhost');
    const k = u.searchParams.get('k');
    if (k !== null && same(k, key)) {
      u.searchParams.delete('k');
      res.setHeader('Set-Cookie', `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict`);
      return res.redirect(u.pathname + u.search);
    }
    if (!hasCookie(req, key)) return res.status(403).type('text/plain').end('Zugriff nur über den Startlink der App.');
    next();
  };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Zweiter Start bei belegtem Port: Browser mit dem Schlüssel des laufenden Prozesses öffnen.
function openRunning(dir, port) {
  const key = read(dir);
  openBrowser(`http://localhost:${port}/${key ? `?k=${key}` : ''}`);
}

module.exports = { generate, save, read, hasCookie, middleware, openBrowser, openRunning };
