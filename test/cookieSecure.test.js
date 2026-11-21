// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Secure cookie automation + HSTS only over HTTPS (#165). Loopback is a trusted proxy by default,
// so X-Forwarded-Proto: https makes req.secure true.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, ADMIN_PASSWORD } = require('./_server');

async function probe(env) {
  const srv = await startServer(env);
  try {
    const out = {};
    for (const proto of ['http', 'https']) {
      const h = { 'X-Forwarded-Proto': proto, 'Content-Type': 'application/json' };
      const me = await fetch(srv.base + '/api/auth/me', { headers: h });
      const csrf = me.headers.getSetCookie().find((c) => c.startsWith('csrfToken='));
      const token = csrf.split(';')[0].split('=')[1];
      const login = await fetch(srv.base + '/api/auth/login', {
        method: 'POST',
        headers: { ...h, Cookie: `csrfToken=${token}`, 'X-CSRF-Token': token },
        body: JSON.stringify({ login: 'admin', password: ADMIN_PASSWORD }),
      });
      const sid = login.headers.getSetCookie().find((c) => c.startsWith('latex_ide_sid='));
      out[proto] = { csrf: /;\s*secure/i.test(csrf), sid: /;\s*secure/i.test(sid), hsts: me.headers.get('strict-transport-security') };
    }
    return out;
  } finally {
    await srv.stop();
  }
}

test('COOKIE_SECURE unset: Secure + HSTS nur bei HTTPS', async () => {
  const r = await probe({ COOKIE_SECURE: undefined });
  assert.deepStrictEqual(r.http, { csrf: false, sid: false, hsts: null });
  assert.deepStrictEqual(r.https, { csrf: true, sid: true, hsts: 'max-age=31536000' });
});

test('COOKIE_SECURE=true: immer Secure, false: nie', async () => {
  const t = await probe({ COOKIE_SECURE: 'true' });
  assert.ok(t.http.csrf && t.https.csrf && t.https.sid); // express-session sets no Secure cookie over plain HTTP at all
  const f = await probe({ COOKIE_SECURE: 'false' });
  assert.ok(!f.https.csrf && !f.https.sid);
});
