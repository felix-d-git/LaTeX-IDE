// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #187: MCP comments/suggestions take the author name from the account, not the free token name.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-batchb-'));
process.env.DATA_DIR = DATA;
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
const comments = require('../server/lib/comments');
const { createMcp } = require('../server/lib/mcp');

const PD = path.join(DATA, 'projects');
fs.mkdirSync(path.join(PD, 'p'), { recursive: true });
fs.writeFileSync(path.join(PD, 'p', 'a.tex'), 'Hallo Welt\nzweite Zeile\n');
const mcp = createMcp({
  PROJECTS_DIR: PD,
  version: 't',
  mcpProjects: () => [{ id: 'p', name: 'p', shared: false }],
  projectIdOf: (root) => path.relative(PD, root).split(path.sep).join('/'),
  canAccessRoot: () => true,
  roleOf: () => 'owner',
  searchAllowed: () => true,
  broadcast: () => {},
});
const tok = { user: { id: 'u1', email: 'mallory@example.test', username: 'mallory' }, name: 'Betreuer', perms: ['read', 'comment'], projects: null };
const call = (name, args) => mcp.callTool(tok, { name, arguments: args });

test('add_comment and suggest_change: account name + via mcp, token name only as suffix', async () => {
  await call('add_comment', { project: 'p', path: 'a.tex', quote: 'Welt', text: 'hm' });
  await call('suggest_change', { project: 'p', path: 'a.tex', old_text: 'zweite', new_text: '2.' });
  const list = comments.listAll(path.join(PD, 'p'));
  const items = Array.isArray(list) ? list : Object.values(list).flat();
  assert.strictEqual(items.length, 2);
  for (const c of items) {
    assert.ok(c.author.name.startsWith('mallory'), c.author.name);
    assert.strictEqual(c.author.via, 'mcp');
  }
});
