// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #176: Audit-Log - Dateirechte, keine Secrets, Rotation, Admin-Route nur für Admins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AUDIT_MAX_BYTES = '400'; // vor dem require, für den Rotationstest
const { startServer, client, adminAndUser, ADMIN_PASSWORD } = require('./_server');
const audit = require('../server/lib/audit');

test('Rotation: 3 Generationen, älteste fällt weg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    for (let i = 0; i < 40; i++) audit.audit('test_event', null, { i });
    const f = path.join(dir, 'audit.log');
    assert.ok(fs.existsSync(f + '.1') && fs.existsSync(f + '.2'));
    assert.ok(!fs.existsSync(f + '.3'));
    assert.ok(fs.statSync(f).size < 800);
    assert.ok(audit.recent({ limit: 1 })[0].i === 39);
  } finally {
    process.env.DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit: Geheimnis-Felder fallen weg, E-Mails werden maskiert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    audit.audit('x', null, { password: 'pw-geheim', token: 'lmcp_abc', resetLink: 'http://x/?reset=zzz', login: 'carol' + '@' + 'example.test' });
    const txt = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
    assert.ok(!/pw-geheim|lmcp_abc|reset=zzz|carol@/.test(txt), txt);
    assert.ok(txt.includes('c***@example.test'));
  } finally {
    process.env.DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Server: Ereignisse, 0600, keine Secrets, Admin-Route nur für Admins', async () => {
  const srv = await startServer({ AUDIT_MAX_BYTES: undefined });
  try {
    const { admin, user } = await adminAndUser(srv);
    const bad = client(srv.base);
    await bad.call('GET', '/api/auth/me');
    for (let i = 0; i < 2; i++) await bad.call('POST', '/api/auth/login', { login: 'bob' + '@' + 'example.test', password: 'falsches-passwort-xyz' });
    const inv = (await admin.call('POST', '/api/admin/invites')).body.token;
    await admin.call('DELETE', `/api/admin/invites/${inv}`);
    const mcpTok = (await admin.call('POST', '/api/auth/mcp-token', { name: 'tok', perms: ['read'] })).body.token;
    await admin.call('GET', '/api/history/diff?id=1&to=2&file=../../etc/passwd');

    const f = path.join(srv.dataDir, 'audit.log');
    const txt = fs.readFileSync(f, 'utf8');
    const ev = txt.trim().split('\n').map((l) => JSON.parse(l));
    const names = ev.map((e) => e.event);
    assert.strictEqual(names.filter((n) => n === 'login_fail').length, 2);
    assert.ok(names.includes('login_ok') && names.includes('mcp_token_created') && names.includes('path_traversal_attempt') && names.includes('admin_invite_revoked'));
    for (const secret of ['falsches-passwort-xyz', ADMIN_PASSWORD, 'geheim-passwort-123', inv, mcpTok, 'bob@example.test']) assert.ok(!txt.includes(secret), 'Secret im Log: ' + secret);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);

    assert.strictEqual((await user.call('GET', '/api/admin/audit')).status, 403);
    assert.strictEqual((await client(srv.base).call('GET', '/api/admin/audit')).status, 401);
    const r = await admin.call('GET', '/api/admin/audit?event=login_fail');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.entries.length, 2);
    assert.ok(r.body.entries.every((e) => e.event === 'login_fail'));
  } finally { await srv.stop(); }
});
