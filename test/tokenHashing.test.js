// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #178/#182: Einladungen atomar beanspruchen, Invite-/Share-Tokens nur gehasht speichern, optionaler Share-Ablauf.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-tokhash-'));
process.env.DATA_DIR = dir;
delete process.env.DATA_KEY;
delete process.env.VAULT_DIR;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const future = new Date(Date.now() + 86400000).toISOString();
const root = path.join(dir, 'proj');
// Altbestand im Klartext, vor dem ersten require geschrieben
fs.writeFileSync(path.join(dir, 'auth-data.json'), JSON.stringify({ users: [], invites: [{ token: 'alt-invite-klartext', createdBy: 'x', createdAt: future, expiresAt: future, usedBy: null, usedAt: null }] }));
fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ shareLinksByRoot: { [root]: { editor: 'alt-link-string', reviewer: { token: 'alt-link-obj', maxUses: 3, uses: 1 } } } }));
const auth = require('../server/lib/auth');
const state = require('../server/state');

test('Migration: Klartext-Invite wird gehasht und bleibt einloesbar', () => {
  const disk = fs.readFileSync(path.join(dir, 'auth-data.json'), 'utf8');
  assert.ok(!disk.includes('alt-invite-klartext'));
  assert.ok(disk.includes(sha('alt-invite-klartext')));
  assert.ok(auth.getValidInvite('alt-invite-klartext'));
  assert.strictEqual(auth.getValidInvite('falsch'), null);
});

test('Migration: Klartext-Share-Links (String und Objekt) werden gehasht und bleiben einloesbar', () => {
  const disk = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
  assert.ok(!disk.includes('alt-link-string') && !disk.includes('alt-link-obj'));
  assert.strictEqual(state.findShareLink('alt-link-string').role, 'editor');
  const r = state.findShareLink('alt-link-obj');
  assert.deepStrictEqual([r.role, r.maxUses, r.uses], ['reviewer', 3, 1]);
  assert.strictEqual(state.findShareLink('nope'), null);
});

test('neue Invites und Share-Links: kein Klartext in den gespeicherten Daten', () => {
  const t = auth.createInvite('admin');
  const s = 'frischer-share-token';
  state.setShareLink(root, 'editor', { tokenHash: state.hashShareToken(s), maxUses: 0, uses: 0, expiresAt: null });
  for (const f of ['auth-data.json', 'workspace.json']) {
    const disk = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!disk.includes(t) && !disk.includes(s), f);
  }
  assert.ok(auth.getValidInvite(t));
  assert.ok(state.findShareLink(s));
  assert.ok(!('tokenHash' in state.getShareLinksPublic(root).editor));
});

test('abgelaufener Share-Link wird abgelehnt, ohne Ablauf gilt er weiter', () => {
  state.setShareLink(root, 'editor', { tokenHash: state.hashShareToken('abgelaufen'), maxUses: 0, uses: 0, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual(state.findShareLink('abgelaufen'), null);
  state.setShareLink(root, 'editor', { tokenHash: state.hashShareToken('offen'), maxUses: 0, uses: 0, expiresAt: null });
  assert.ok(state.findShareLink('offen'));
});

test('claimInvite: nur ein Beansprucher; release gibt frei; Widerruf wird nicht ueberschrieben', () => {
  const t = auth.createInvite('admin');
  assert.ok(auth.claimInvite(t));
  assert.strictEqual(auth.claimInvite(t), null);
  assert.strictEqual(auth.getValidInvite(t), null);
  auth.releaseInvite(t);
  assert.ok(auth.getValidInvite(t));
  assert.ok(auth.claimInvite(t));
  auth.revokeInvite(sha(t));
  assert.strictEqual(auth.consumeInvite(t, 'u1'), false);
  assert.strictEqual(auth.getValidInvite(t), null);
  assert.strictEqual(auth.consumeInvite('unbekannt', 'u1'), false);
  const t2 = auth.createInvite('admin');
  assert.strictEqual(auth.consumeInvite(t2, 'u1'), false); // nicht beansprucht -> kein Ueberschreiben
  assert.ok(auth.getValidInvite(t2));
});
