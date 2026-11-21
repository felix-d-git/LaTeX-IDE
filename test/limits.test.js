// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #158: Zip-Limit, Nutzer-Quota (Admin ausgenommen), Längenlimits, Admin-Route für die Limits.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, adminAndUser } = require('./_server');
const limits = require('../server/lib/limits');
const history = require('../server/lib/history');
const { extractZip } = require('../server/lib/unzip');

// Minimal "stored" zip (no compression, CRC not checked by extractZip).
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const rawPost = (c, base, url, body) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip', Cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': c.jar.csrfToken || '' },
  body,
});

test('extractZip: Eintragsweise, onTotal-Abbruch schreibt nichts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-'));
  try {
    const zip = makeZip({ 'a.txt': Buffer.from('hallo'), 'b/c.txt': Buffer.from('welt') });
    assert.throws(() => extractZip(zip, dir, (t) => { assert.strictEqual(t, 9); throw new Error('stop'); }), /stop/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    extractZip(zip, dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'b', 'c.txt'), 'utf8'), 'welt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits.validate: nur positive Ganzzahlen bis zur Obergrenze', () => {
  assert.deepStrictEqual(limits.validate({ zipLimitMb: '10', labelMaxChars: 5 }), { zipLimitMb: 10, labelMaxChars: 5 });
  for (const bad of [{ zipLimitMb: 0 }, { zipLimitMb: -1 }, { zipLimitMb: 1.5 }, { zipLimitMb: 'abc' }, { zipLimitMb: 999999 }, { nope: 1 }, null, []]) {
    assert.throws(() => limits.validate(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('history.retained: nur die neuesten maxLabeledEntries bleiben geschützt', () => {
  limits.setOverrides({ maxLabeledEntries: 2 });
  try {
    const now = Date.now();
    // alle am selben Tag: ohne Schutz bleibt nur einer, die Ausdünnung greift
    const same = (i) => ({ id: `s${i}`, createdAt: new Date(now - 40 * 24 * 3600 * 1000 - i * 1000).toISOString(), label: `l${i}`, trigger: 'manual' });
    const kept = history.retained([same(3), same(2), same(1), same(0)], now);
    // s0 (neueste) + s1 geschützt; s2,s3 gleicher Tages-Bucket -> höchstens einer davon
    assert.ok(kept.some((e) => e.id === 's0') && kept.some((e) => e.id === 's1'));
    assert.ok(kept.length < 4);
  } finally { limits.setOverrides({}); }
});

test('Server: Admin-Route, Zip-Limit, Quota, Längenlimits, Wirkung ohne Neustart', async () => {
  const srv = await startServer();
  try {
    const { admin, user } = await adminAndUser(srv);
    // Zugriff
    assert.strictEqual((await user.call('GET', '/api/admin/limits')).status, 403);
    assert.strictEqual((await user.call('PUT', '/api/admin/limits', { limits: { userQuotaMb: 1 } })).status, 403);
    const g = await admin.call('GET', '/api/admin/limits');
    assert.strictEqual(g.body.limits.zipLimitMb.value, 50);
    assert.strictEqual(g.body.limits.userQuotaMb.value, 300);
    assert.strictEqual(g.body.limits.commentMaxChars.value, 20000);
    assert.strictEqual(g.body.limits.labelMaxChars.value, 100);
    assert.strictEqual(g.body.limits.maxLabeledEntries.value, 50);
    assert.strictEqual(g.body.limits.freeReserveMb.value, 200);
    assert.strictEqual((await admin.call('PUT', '/api/admin/limits', { limits: { userQuotaMb: 0 } })).status, 400);
    assert.strictEqual((await admin.call('PUT', '/api/admin/limits', { limits: { zipLimitMb: 'x' } })).status, 400);
    assert.strictEqual((await admin.call('PUT', '/api/admin/limits', { limits: { foo: 1 } })).status, 400);

    // Quota 1 MB (sofort wirksam): Nutzer 2 MB-Zip -> 413 und nichts bleibt liegen, Admin ausgenommen
    const put = await admin.call('PUT', '/api/admin/limits', { limits: { userQuotaMb: 1, commentMaxChars: 5, labelMaxChars: 3, zipLimitMb: 3 } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.limits.userQuotaMb.value, 1);
    const big = makeZip({ 'main.tex': Buffer.alloc(2 * 1024 * 1024, 97) });
    const small = makeZip({ 'main.tex': Buffer.from('\\documentclass{article}') });
    const r1 = await rawPost(user, srv.base, '/api/projects/upload-zip?name=gross', big);
    assert.strictEqual(r1.status, 413);
    assert.match((await r1.json()).error, /Speicherkontingent/);
    const usersDir = path.join(srv.dataDir, 'projects', 'users');
    const left = fs.existsSync(usersDir) ? fs.readdirSync(usersDir).flatMap((u) => fs.readdirSync(path.join(usersDir, u))) : [];
    assert.deepStrictEqual(left, []);
    assert.strictEqual((await rawPost(user, srv.base, '/api/projects/upload-zip?name=klein', small)).status, 200);
    assert.strictEqual((await rawPost(admin, srv.base, '/api/projects/upload-zip?name=adminbig', big)).status, 200);
    // Zip-Upload-Limit 3 MB
    const huge = makeZip({ 'main.tex': Buffer.alloc(4 * 1024 * 1024, 98) });
    assert.strictEqual((await rawPost(admin, srv.base, '/api/projects/upload-zip?name=zuviel', huge)).status, 413);
    // Quota gilt auch bei Projektanlage/-kopie: Nutzer mit 1 MB Kontingent, Kopie des vollen Projekts
    await admin.call('PUT', '/api/admin/limits', { limits: { userQuotaMb: 1 } });

    // Längenlimits
    const created = await admin.call('POST', '/api/projects/create', { name: 'lim' });
    assert.strictEqual(created.status, 200);
    await admin.call('POST', '/api/projects/open', { root: created.body.root });
    const cm = (text) => admin.call('POST', '/api/comments', { path: 'main.tex', from: 0, to: 1, text });
    assert.strictEqual((await cm('123456')).status, 413);
    assert.strictEqual((await cm('12345')).status, 200);
    assert.strictEqual((await admin.call('POST', '/api/history/label', { id: 'x', name: 'abcd' })).status, 413);

    // Limit wieder hoch: wirkt sofort
    await admin.call('PUT', '/api/admin/limits', { limits: { commentMaxChars: 10 } });
    assert.strictEqual((await cm('123456')).status, 200);

    // Freie-Speicher-Reserve riesig: Schreiben 507, Lesen und Admin-Route bleiben
    await admin.call('PUT', '/api/admin/limits', { limits: { freeReserveMb: 10485760 } });
    assert.strictEqual((await cm('1')).status, 507);
    assert.strictEqual((await admin.call('GET', '/api/comments')).status, 200);
    assert.strictEqual((await admin.call('PUT', '/api/admin/limits', { limits: { freeReserveMb: 1 } })).status, 200);
    assert.strictEqual((await cm('1')).status, 200);
  } finally {
    await srv.stop();
  }
});
