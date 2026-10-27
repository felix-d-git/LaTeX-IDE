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
