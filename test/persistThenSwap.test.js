// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #161: persist-then-swap. If persisting fails, the in-memory state stays unchanged and the error reaches the caller.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-pts-'));
process.env.DATA_DIR = dir;
delete process.env.DATA_KEY;
delete process.env.VAULT_DIR;
const auth = require('../server/lib/auth');
const state = require('../server/state');

// A directory in place of the .tmp file makes writeFileSync throw (EISDIR), like ENOSPC would.
const breakTmp = (file) => fs.mkdirSync(file + '.tmp');
const fixTmp = (file) => fs.rmdirSync(file + '.tmp');

test('auth: failed persist keeps token and user, error propagates', async () => {
  const user = await auth.createUser({ email: 'a@example.test', username: 'alice', password: 'Passwort-12345!' });
  const api = auth.createApiToken(user.id, 'x');
  const mcp = auth.createMcpToken(user.id, { name: 'm', perms: ['read'], projects: [] });
  const file = path.join(dir, 'auth-data.json');
  breakTmp(file);
  assert.throws(() => auth.revokeApiToken(user.id, auth.listApiTokens(user.id)[0].id));
  assert.throws(() => auth.revokeMcpToken(user.id, auth.listMcpTokens(user.id)[0].id));
  assert.throws(() => auth.deleteUser(user.id));
  assert.strictEqual(auth.listApiTokens(user.id).length, 1);
  assert.strictEqual(auth.listMcpTokens(user.id).length, 1);
  assert.ok(auth.findUserById(user.id));
  fixTmp(file);
  // success path
  auth.revokeApiToken(user.id, auth.listApiTokens(user.id)[0].id);
  auth.revokeMcpToken(user.id, auth.listMcpTokens(user.id)[0].id);
  assert.strictEqual(auth.listApiTokens(user.id).length, 0);
  assert.strictEqual(auth.listMcpTokens(user.id).length, 0);
  auth.deleteUser(user.id);
  assert.strictEqual(auth.findUserById(user.id), null);
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).users.some((u) => u.id === user.id));
  void api; void mcp;
});

test('state: failed persist keeps shares, roles and links', () => {
  const root = path.join(dir, 'proj');
  const file = path.join(dir, 'workspace.json');
  state.setShares(root, ['u1']);
  state.setRole(root, 'u1', 'reviewer');
  state.setShareLink(root, 'editor', { token: 't', maxUses: 0, uses: 0 });
  breakTmp(file);
  assert.throws(() => state.setShares(root, []));
  assert.throws(() => state.setRole(root, 'u1', 'editor'));
  assert.throws(() => state.setShareLink(root, 'editor', null));
  assert.deepStrictEqual(state.getShares(root), ['u1']);
  assert.strictEqual(state.getRole(root, 'u1'), 'reviewer');
  assert.strictEqual(state.getShareLinks(root).editor.token, 't');
  fixTmp(file);
  state.setShares(root, []);
  state.setRole(root, 'u1', 'editor');
  state.setShareLink(root, 'editor', null);
  assert.deepStrictEqual(state.getShares(root), []);
  assert.strictEqual(state.getRole(root, 'u1'), 'editor');
  assert.deepStrictEqual(state.getShareLinks(root), {});
});
