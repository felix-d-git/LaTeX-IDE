// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// SMTP nur aus der .env (keine Einstellung in der UI), ergänzt crashSafety (#66):
// Absender aus SMTP_FROM vor SMTP_USER, Fehler kommt vom Verbindungsaufbau statt aus getConfig().
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-mailenv-'));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_USER = 'ide-user';
process.env.SMTP_FROM = 'LaTeX-IDE <ide@example.test>';

test('mailer: SMTP aus .env liefert Konfiguration, Absender aus SMTP_FROM, sonst SMTP_USER', () => {
  const mailer = require('../server/lib/mailer');
  assert.strictEqual(mailer.isConfigured(), true);
  assert.strictEqual(mailer.configSource(), 'env');
  assert.strictEqual(mailer.getConfig().from, 'LaTeX-IDE <ide@example.test>');
  delete process.env.SMTP_FROM;
  assert.strictEqual(mailer.getConfig().from, 'ide-user');
});

test('mailer: nicht erreichbarer SMTP aus .env scheitert am Verbindungsaufbau', async () => {
  const mailer = require('../server/lib/mailer');
  const r = await mailer.sendMailSafe({ to: 'a@example.invalid', subject: 's', text: 't' });
  assert.strictEqual(r.delivered, false);
  assert.notStrictEqual(r.error.name, 'RangeError');
  assert.ok(r.error.code, `Fehler ohne Code: ${r.error.message}`);
});

// #167: Server ohne STARTTLS -> ohne Opt-out kein Versand und kein AUTH; mit SMTP_ALLOW_PLAIN=true läuft er.
test('mailer: ohne STARTTLS scheitert der Versand (kein AUTH), mit SMTP_ALLOW_PLAIN=true läuft er', async () => {
  const net = require('net');
  let sawAuth = false, mails = 0;
  const srv = net.createServer((sock) => {
    let inData = false;
    sock.write('220 plain\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; mails++; sock.write('250 ok\r\n'); } }
        else if (/^EHLO/i.test(line)) sock.write('250-plain\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^STARTTLS/i.test(line)) sock.write('502 no\r\n');
        else if (/^AUTH/i.test(line)) { sawAuth = true; sock.write('235 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const mailer = require('../server/lib/mailer');
  process.env.SMTP_PORT = String(srv.address().port);
  process.env.SMTP_PASS = 'pw';
  try {
    mailer.setSmtp(null);
    delete process.env.SMTP_ALLOW_PLAIN;
    const r = await mailer.sendMailSafe({ to: 'a@example.test', subject: 's', text: 't' });
    assert.strictEqual(r.delivered, false);
    assert.match(r.error.message, /STARTTLS/);
    assert.strictEqual(sawAuth, false);
    process.env.SMTP_ALLOW_PLAIN = 'true';
    mailer.setSmtp(null);
    assert.strictEqual((await mailer.sendMailSafe({ to: 'a@example.test', subject: 's', text: 't' })).delivered, true);
    assert.strictEqual(mails, 1);
  } finally { delete process.env.SMTP_ALLOW_PLAIN; srv.close(); }
});
