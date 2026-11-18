'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer, client, adminAndUser } = require('./_server');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('Login parallel zum Passwortwechsel: keine ueberlebende Sitzung (#153)', async () => {
  const { user } = await adminAndUser(srv, 'carol');
  for (let i = 0; i < 4; i++) {
    const old = i === 0 ? 'geheim-passwort-123' : `wechsel-passwort-${i - 1}x`;
    const next = `wechsel-passwort-${i}x`;
    const attacker = client(srv.base);
    await attacker.call('GET', '/api/auth/me');
    const [login, change] = await Promise.all([
      attacker.call('POST', '/api/auth/login', { login: 'carol', password: old }),
      user.call('POST', '/api/auth/change-password', { currentPassword: old, newPassword: next }),
    ]);
    assert.strictEqual(change.status, 200);
    // Whatever the interleaving: a login with the old password must not hold a valid session afterwards.
    assert.strictEqual((await attacker.call('GET', '/api/auth/me')).status, 401, `Lauf ${i}: login=${login.status}`);
    assert.strictEqual((await attacker.call('POST', '/api/auth/login', { login: 'carol', password: old })).status, 401);
  }
});

test('Login mit neuem Passwort nach Wechsel funktioniert', async () => {
  const c = client(srv.base);
  await c.login('carol', 'wechsel-passwort-3x');
  assert.strictEqual((await c.call('GET', '/api/auth/me')).status, 200);
});
