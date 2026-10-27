// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Issue #30: errors that used to end the whole server process (uncaught exception /
// unhandled 'error' event / unhandled rejection) must now stay local.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-crash-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Before any require that reads them: no real data dir, an SMTP server that refuses,
// and "pandoc" = node, which rejects --sandbox and exits without reading stdin.
process.env.DATA_DIR = tmp();
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.PANDOC = process.execPath;

test('fetchUrl: redirect to an invalid Location rejects instead of throwing', async (t) => {
  const { fetchUrl } = require('../server/lib/fetchUrl');
  // Real sockets to 127.0.0.1 are blocked (SSRF), so fake the response; the callback
  // runs asynchronously like a real one, where a throw is an uncaught exception.
  t.mock.method(http, 'get', (u, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => cb({ statusCode: 302, headers: { location: 'http://[nicht gültig' }, resume() {}, destroy() {} }));
    return req;
  });
  await assert.rejects(fetchUrl('http://93.184.216.34/x'), /ungültige Adresse/);
});

test('export: pandoc exiting before reading stdin (EPIPE) rejects', async () => {
  const { exportProject } = require('../server/lib/export');
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.tex'), 'x'.repeat(32 * 1024 * 1024));
  await assert.rejects(exportProject(root, 'main.tex', 'docx'), /sandbox/);
});

test('history: dangling symlink does not break the snapshot', (t) => {
  const history = require('../server/lib/history');
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.tex'), 'hallo');
  try {
    // Windows without developer mode: a junction needs no privilege and dangles just the same.
    const type = process.platform === 'win32' ? 'junction' : 'file';
    fs.symlinkSync(path.join(root, 'gibts-nicht'), path.join(root, 'kaputt.tex'), type);
  } catch (e) {
    return t.skip('Symlinks nicht erlaubt: ' + e.code);
  }
  const entry = history.snapshot(root, { trigger: 'manual' });
  assert.ok(entry);
  assert.deepStrictEqual(entry.files, ['main.tex']);
});

test('watcher: error event (e.g. ENOSPC) has a listener', async () => {
  const { startWatcher } = require('../server/lib/watcher');
  const w = startWatcher(tmp(), () => {});
  try {
    assert.doesNotThrow(() => w.emit('error', Object.assign(new Error('watch limit'), { code: 'ENOSPC' })));
  } finally {
    await w.close();
  }
});

test('collab: socket error (e.g. message > maxPayload) has a listener', () => {
  const collab = require('../server/lib/collab');
  assert.strictEqual(collab.WS_MAX_PAYLOAD, 64 * 1024 * 1024);
  const ws = new EventEmitter();
  ws.close = () => {};
  ws.send = () => {};
  collab.handleConnection(ws, tmp(), 'gibts-nicht.tex', null);
  assert.doesNotThrow(() => ws.emit('error', Object.assign(new Error('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })));
});

test('auth: non-string password is a failed login, not a 500/crash', async () => {
  const auth = require('../server/lib/auth');
  const user = { passwordHash: '$2a$10$abcdefghijklmnopqrstuuJ3pZ9mRk0gS1y1hVQ6k1lJQ3dQ9QeW2' };
  assert.strictEqual(await auth.verifyPassword(user, 123), false);
  assert.strictEqual(await auth.verifyPassword(user, { a: 1 }), false);
  assert.strictEqual(await auth.verifyPassword({}, 'pw'), false);
});

test('mailer: sendMailSafe never throws when SMTP is unreachable', async () => {
  const mailer = require('../server/lib/mailer');
  const r = await mailer.sendMailSafe({ to: 'a@example.invalid', subject: 's', text: 't' });
  assert.strictEqual(r.delivered, false);
  assert.ok(r.error);
  assert.doesNotMatch(String(r.error), /call stack/);
});

test('mailer: SMTP from .env resolves without recursion', () => {
  const mailer = require('../server/lib/mailer');
  process.env.SMTP_USER = 'u@example.invalid';
  assert.strictEqual(mailer.getConfig().from, 'u@example.invalid');
  assert.strictEqual(mailer.configSource(), 'env');
});
