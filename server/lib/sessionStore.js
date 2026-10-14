// Small file-backed express-session store (replaces session-file-store).
// Same on-disk format: <sid>.json holding the session plus __lastAccess (ms), so existing
// sessions stay valid. A session expires ttl after its last access, or after the cookie's
// originalMaxAge ("stay logged in"). Writes are atomic (tmp file + rename).
const fs = require('fs');
const path = require('path');
const { Store } = require('express-session');

const SID = /^[A-Za-z0-9_-]+$/; // express-session ids; also keeps ids from escaping the folder

class FileSessionStore extends Store {
  constructor({ path: dir, ttl = 3600, reapInterval = 3600 } = {}) {
    super();
    this.dir = dir;
    this.ttl = ttl * 1000;
    fs.mkdirSync(dir, { recursive: true });
    this.reap();
    if (reapInterval > 0) this.timer = setInterval(() => this.reap(), reapInterval * 1000).unref();
  }

  file(sid) { return SID.test(sid) ? path.join(this.dir, `${sid}.json`) : null; }

  expired(s) {
    const life = s.cookie && s.cookie.originalMaxAge ? s.cookie.originalMaxAge : this.ttl;
    return !(s.__lastAccess + life >= Date.now());
  }

  read(file) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s && typeof s === 'object' ? s : null;
    } catch { return null; }
  }

  get(sid, cb) {
    const f = this.file(sid);
    const s = f && this.read(f);
    if (!s) return cb(null, null);
    if (this.expired(s)) return this.destroy(sid, () => cb(null, null));
    delete s.__lastAccess;
    cb(null, s);
  }

  set(sid, session, cb = () => {}) {
    const f = this.file(sid);
    if (!f) return cb(new Error('Ungültige Session-ID'));
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...session, __lastAccess: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return cb(e);
    }
    cb(null);
  }

  // Only extends expiry: a failed write (Windows EPERM on rename) must not fail the request.
  touch(sid, session, cb = () => {}) { this.set(sid, session, () => cb(null)); }

  destroy(sid, cb = () => {}) {
    const f = this.file(sid);
    if (f) fs.rmSync(f, { force: true });
    cb(null);
  }

  // Removes expired sessions and leftover tmp files of a crashed write.
  reap() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const n of names) {
      const f = path.join(this.dir, n);
      if (n.endsWith('.tmp')) {
        try { if (Date.now() - fs.statSync(f).mtimeMs > 60000) fs.rmSync(f, { force: true }); } catch { /* gone */ }
      } else if (n.endsWith('.json')) {
        const s = this.read(f);
        if (!s || this.expired(s)) fs.rmSync(f, { force: true });
      }
    }
  }
}

module.exports = FileSessionStore;
