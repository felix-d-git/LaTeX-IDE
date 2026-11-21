// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #169: gespeichertes SMTP-Passwort nur bei gleichem Ziel; Testmail-Fehler generisch + Rate-Limit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, client, ADMIN_PASSWORD } = require('./_server');

test('SMTP-Passwort wird nur bei gleichem Host/Port/Benutzer weiterverwendet', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', ADMIN_PASSWORD);
    const base = { host: '127.0.0.1', port: 1, user: 'u', from: 'ide@example.com' };
    let r = await admin.call('PUT', '/api/admin/mail', { smtp: { ...base, pass: 'geheim' } });
    assert.equal(r.status, 200);
    // anderer Host ohne pass -> 400, Konfiguration unveraendert
    r = await admin.call('PUT', '/api/admin/mail', { smtp: { ...base, host: '127.0.0.2' } });
    assert.equal(r.status, 400);
    assert.equal((await admin.call('GET', '/api/admin/mail')).body.smtp.host, '127.0.0.1');
    // anderer Port / Benutzer ebenso
    assert.equal((await admin.call('PUT', '/api/admin/mail', { smtp: { ...base, port: 2 } })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/mail', { smtp: { ...base, user: 'x' } })).status, 400);
    // gleiches Ziel ohne pass -> Passwort bleibt
    r = await admin.call('PUT', '/api/admin/mail', { smtp: base });
    assert.equal(r.body.smtp.passwordSet, true);
    // neuer Host mit neuem pass -> ok
    r = await admin.call('PUT', '/api/admin/mail', { smtp: { ...base, host: '127.0.0.2', pass: 'neu' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'auth-data.json'), 'utf8')).settings.smtp.pass, 'neu');
  } finally { await srv.stop(); }
});

test('mail/test: generische Fehlermeldung ohne Details, Rate-Limit', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', ADMIN_PASSWORD);
    await admin.call('PUT', '/api/admin/mail', { smtp: { host: '127.0.0.1', port: 1, from: 'ide@example.com' } });
    const r = await admin.call('POST', '/api/admin/mail/test');
    assert.equal(r.status, 502);
    assert.ok(!/ECONNREFUSED|127\.0\.0\.1/.test(r.text), r.text);
    let last;
    for (let i = 0; i < 6; i++) last = await admin.call('POST', '/api/admin/mail/test');
    assert.equal(last.status, 429);
  } finally { await srv.stop(); }
});
