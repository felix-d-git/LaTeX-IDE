// SPDX-License-Identifier: AGPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
process.env.DATA_DIR = dir;
delete process.env.SMTP_HOST;
const mailer = require('../server/lib/mailer');
const file = path.join(dir, 'mail-outbox.log');

test('outbox: stdout masked, file has link, old entries pruned, 0600', async () => {
  const old = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, `\n--- ${old} ---\nAn: x@example.org\nBetreff: alt\nOLDLINK\n`);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { await mailer.sendMailSafe({ to: 'alice@example.org', subject: 'Betreff1', text: 'https://h/?reset=SECRET' }); } finally { console.log = orig; }
  const out = logs.join('\n');
  assert.match(out, /a\*\*\*@example\.org/);
  assert.match(out, /Betreff1/);
  assert.doesNotMatch(out, /SECRET|alice/);
  const f = fs.readFileSync(file, 'utf8');
  assert.match(f, /reset=SECRET/);
  assert.doesNotMatch(f, /OLDLINK/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('SMTP configured + send fails: nothing written to outbox, masked error', async () => {
  fs.rmSync(file, { force: true });
  mailer.setSmtp({ host: '127.0.0.1', port: 1, secure: false, from: 'f@example.org' });
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const r = await mailer.sendMailSafe({ to: 'alice@example.org', subject: 's', text: 'LINK-X' });
    assert.strictEqual(r.delivered, false);
  } finally { console.error = orig; mailer.setSmtp(null); }
  assert.ok(!fs.existsSync(file));
  assert.doesNotMatch(errs.join('\n'), /alice|LINK-X/);
});
