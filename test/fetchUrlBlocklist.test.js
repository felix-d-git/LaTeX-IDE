// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// SSRF-Blocklist (#189): IPv6-Übersetzungs-/Tunnelpräfixe, die auf IPv4-Ziele abbilden.
const test = require('node:test');
const assert = require('node:assert');
const { isBlocked } = require('../server/lib/fetchUrl');

test('isBlocked: IPv4-kompatibel, NAT64 lokal, SIIT, Teredo gesperrt', () => {
  for (const a of ['::127.0.0.1', '::a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '2001::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', 'fd00::1']) {
    assert.strictEqual(isBlocked(a), true, a);
  }
});

test('isBlocked: öffentliche Adressen erlaubt', () => {
  assert.strictEqual(isBlocked('2606:4700:4700::1111'), false);
  assert.strictEqual(isBlocked('1.1.1.1'), false);
});
