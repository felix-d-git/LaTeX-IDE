// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.LATEX_IDE_LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-pw-'));
const { startServer, client } = require('./_server');
const auth = require('../server/lib/auth');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('validatePassword: 72 Byte ok, 73 Byte (auch Multibyte) abgelehnt (#180)', () => {
  assert.doesNotThrow(() => auth.validatePassword('a'.repeat(72)));
  assert.doesNotThrow(() => auth.validatePassword('€'.repeat(24)));
  assert.throws(() => auth.validatePassword('a'.repeat(73)), /zu lang/);
  assert.throws(() => auth.validatePassword('€'.repeat(25)), /zu lang/);
});

test('verifyPassword: unbekannter User und >1024 Zeichen laufen durch bcrypt und scheitern (#179/#180)', async () => {
  const hash = await require('bcryptjs').hash('geheim-passwort-123', 12);
  const user = { passwordHash: hash };
  await auth.verifyPassword(null, 'x'); // warm up the dummy hash
  const time = async (u, pw) => { const t = Date.now(); const r = await auth.verifyPassword(u, pw); return [r, Date.now() - t]; };
  const [rUnknown, tUnknown] = await time(null, 'irgendwas-123');
  const [rKnown, tKnown] = await time(user, 'falsches-passwort');
  assert.strictEqual(rUnknown, false);
  assert.ok(tUnknown > tKnown / 3 && tUnknown > 20, `unbekannt ${tUnknown}ms vs bekannt ${tKnown}ms`);
  const [rLong, tLong] = await time(user, 'a'.repeat(1025));
  assert.strictEqual(rLong, false);
  assert.ok(tLong > 20, `lang ${tLong}ms`);
  assert.strictEqual(await auth.verifyPassword(user, 'geheim-passwort-123'), true);
});

test('Login: unbekannter User und zu langes Passwort -> 401 mit gleicher Meldung', async () => {
  const c = client(srv.base);
  await c.call('GET', '/api/auth/me');
  const a = await c.call('POST', '/api/auth/login', { login: 'niemand', password: 'passwort-123' });
  const b = await c.call('POST', '/api/auth/login', { login: 'niemand', password: 'a'.repeat(2000) });
  assert.strictEqual(a.status, 401);
  assert.strictEqual(b.status, 401);
  assert.deepStrictEqual(a.body ?? a.json, b.body ?? b.json);
});
