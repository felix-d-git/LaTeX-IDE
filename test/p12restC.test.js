// P12-Rest C: SMTP im Admin, Bestätigungsmodus, "E-Mail bestätigen" (#64).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startServer, client, adminAndUser } = require('./_server');

// Minimal SMTP sink: collects the DATA of every mail.
function dummySmtp() {
  const mails = [];
  const srv = net.createServer((sock) => {
    let data = '', inData = false, buf = '';
    sock.write('220 dummy\r\n');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; mails.push(data); data = ''; sock.write('250 ok\r\n'); } else data += line + '\n';
        } else if (/^EHLO|^HELO/i.test(line)) sock.write('250 dummy\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ mails, port: srv.address().port, close: () => srv.close() })));
}

async function register(srv, admin, name) {
  const { token } = (await admin.call('POST', '/api/admin/invites')).body;
  const c = client(srv.base);
  await c.call('GET', '/api/auth/me');
  const reg = await c.call('POST', '/api/auth/register', { token, username: name, email: `${name}@example.test`, password: 'geheim-passwort-123' });
  return { c, reg };
}
const login = (c, name) => c.call('POST', '/api/auth/login', { login: name, password: 'geheim-passwort-123' });

test('Rechte: Nicht-Admin bekommt 403, Anonym 401', async () => {
  const srv = await startServer();
  try {
    const { user, userId } = await adminAndUser(srv);
    const anon = client(srv.base);
    await anon.call('GET', '/api/auth/me');
    for (const [m, u, b] of [['GET', '/api/admin/mail'], ['PUT', '/api/admin/mail', {}], ['POST', '/api/admin/mail/test'], ['POST', `/api/admin/users/${userId}/verify`]]) {
      assert.equal((await user.call(m, u, b)).status, 403, u);
      assert.equal((await anon.call(m, u, b)).status, 401, u);
    }
  } finally { await srv.stop(); }
});

test('Standard: Modus mail, kein SMTP; "mail" ohne SMTP abgelehnt, Passwort nie im Response', async () => {
  const srv = await startServer();
  const smtp = await dummySmtp();
  try {
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    let r = await admin.call('GET', '/api/admin/mail');
    assert.equal(r.body.verifyMode, 'mail');
    assert.equal(r.body.smtpConfigured, false);
    assert.equal((await admin.call('POST', '/api/admin/mail/test')).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/mail', { verifyMode: 'mail' })).status, 400);
    assert.equal((await admin.call('PUT', '/api/admin/mail', { verifyMode: 'quatsch' })).status, 400);
    // SMTP setzen
    r = await admin.call('PUT', '/api/admin/mail', { smtp: { host: '127.0.0.1', port: smtp.port, user: '', from: 'ide@example.test', pass: 'TopSecret123' }, verifyMode: 'mail' });
    assert.equal(r.status, 200);
    assert.equal(r.body.smtpConfigured, true);
    assert.equal(r.body.smtp.passwordSet, true);
    assert.equal(r.body.smtp.source, 'ui');
    assert.ok(!r.text.includes('TopSecret123'));
    assert.ok(!(await admin.call('GET', '/api/admin/mail')).text.includes('TopSecret123'));
    // Passwort bleibt beim erneuten Speichern ohne pass erhalten
    r = await admin.call('PUT', '/api/admin/mail', { smtp: { host: '127.0.0.1', port: smtp.port, from: 'ide@example.test' } });
    assert.equal(r.body.smtp.passwordSet, true);
    assert.ok(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'auth-data.json'), 'utf8')).settings.smtp.pass === 'TopSecret123');
    // Testmail
    r = await admin.call('POST', '/api/admin/mail/test');
    assert.equal(r.status, 200);
    assert.equal(smtp.mails.length, 1);
    assert.match(smtp.mails[0], /Testmail/);
    // Host leeren = zurück zu .env (hier: keins) -> "mail" nicht mehr wählbar
    r = await admin.call('PUT', '/api/admin/mail', { smtp: { host: '' } });
    assert.equal(r.body.smtpConfigured, false);
    assert.equal(r.body.smtp.source, 'none');
  } finally { smtp.close(); await srv.stop(); }
});

test('Modus admin: Konto unbestätigt, Login 403, Knopf-Endpunkt bestätigt, danach Login', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    assert.equal((await admin.call('PUT', '/api/admin/mail', { verifyMode: 'admin' })).status, 200);
    const { c, reg } = await register(srv, admin, 'carol');
    assert.equal(reg.status, 200);
    assert.equal(reg.body.needsVerification, true);
    const outbox = path.join(srv.dataDir, 'mail-outbox.log');
    assert.ok(!fs.existsSync(outbox) || !/carol@/.test(fs.readFileSync(outbox, 'utf8')), 'keine Mail im Modus admin');
    let l = await login(c, 'carol');
    assert.equal(l.status, 403);
    assert.equal(l.body.unverified, true);
    const { users } = (await admin.call('GET', '/api/admin/users')).body;
    const carol = users.find((u) => u.username === 'carol');
    assert.equal(carol.verified, false);
    assert.equal((await admin.call('POST', '/api/admin/users/nope/verify')).status, 404);
    assert.equal((await admin.call('POST', `/api/admin/users/${carol.id}/verify`)).status, 200);
    assert.equal((await login(c, 'carol')).status, 200);
  } finally { await srv.stop(); }
});

test('Modus auto: Login direkt nach Registrierung; Modus mail (Standard): Login gesperrt', async () => {
  const srv = await startServer();
  try {
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    const dflt = await register(srv, admin, 'dave');
    assert.equal(dflt.reg.body.needsVerification, true);
    assert.equal((await login(dflt.c, 'dave')).status, 403);
    assert.equal((await admin.call('PUT', '/api/admin/mail', { verifyMode: 'auto' })).status, 200);
    const { c, reg } = await register(srv, admin, 'erin');
    assert.equal(reg.body.needsVerification, false);
    assert.equal((await login(c, 'erin')).status, 200);
  } finally { await srv.stop(); }
});
