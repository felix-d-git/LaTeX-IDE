// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Issue #39: per-project state (settings, main file, shares, labels) moves with the folder into the
// trash/archive and back; a new project of the same name starts clean; parked projects are closed to members.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startServer, adminAndUser } = require('./_server');

let srv;
test.before(async () => {
  srv = await startServer();
});
test.after(() => srv && srv.stop());

test('Papierkorb: neues gleichnamiges Projekt ohne Altlasten, Wiederherstellen bringt alles zurück', async () => {
  const { admin, user, userId } = await adminAndUser(srv);
  const open = (c, root) => c.call('POST', '/api/projects/open', { root });
  const thesis = (await admin.call('POST', '/api/projects/create', { name: 'Thesis' })).body.root;
  const other = (await admin.call('POST', '/api/projects/create', { name: 'Anderes' })).body.root;

  assert.strictEqual((await open(admin, thesis)).status, 200);
  require('fs').writeFileSync(path.join(thesis, 'thesis.tex'), 'x'); // mainFileOf repairs a main file that does not exist
  await admin.call('POST', '/api/main-file', { path: 'thesis.tex' });
  await admin.call('POST', '/api/settings', { compiler: 'xelatex', autocompile: true });
  assert.strictEqual((await admin.call('POST', '/api/share', { login: 'bob' })).status, 200);
  const label = (await admin.call('POST', '/api/labels', { name: 'Wichtig', color: (await admin.call('GET', '/api/projects/list')).body.labelColors[0] })).body;
  await admin.call('POST', '/api/labels/assign', { keys: ['Thesis'], labelId: label.id, on: true });
  await open(admin, other);

  assert.strictEqual((await admin.call('POST', '/api/projects/trash', { name: 'Thesis' })).status, 200);
  const trashed = path.join(path.dirname(thesis), '.trash', 'Thesis');
  // Member: no access while it is in the trash.
  const bobList = (await user.call('GET', '/api/projects/list')).body;
  assert.deepStrictEqual(bobList.sharedProjects, []);
  assert.strictEqual((await open(user, trashed)).status, 403);

  // New project with the old name: defaults, no members, no label.
  const fresh = (await admin.call('POST', '/api/projects/create', { name: 'Thesis' })).body.root;
  assert.strictEqual(fresh, thesis);
  const o = (await open(admin, fresh)).body;
  assert.strictEqual(o.mainFile, 'main.tex');
  const settings = (await admin.call('GET', '/api/settings')).body.settings;
  assert.notStrictEqual(settings.compiler, 'xelatex');
  assert.ok(!settings.autocompile);
  assert.deepStrictEqual((await admin.call('GET', '/api/share')).body.members, []);
  let list = (await admin.call('GET', '/api/projects/list')).body;
  assert.strictEqual(list.labels.assign.Thesis, undefined);
  assert.deepStrictEqual(list.labels.assign['.trash/Thesis'], [label.id]);
  assert.strictEqual((await user.call('GET', '/api/projects/list')).body.sharedProjects.length, 0);
  await open(admin, other);

  // Restore -> Thesis_2 with its own settings, member and label.
  const restored = (await admin.call('POST', '/api/projects/restore', { name: 'Thesis' })).body.root;
  assert.strictEqual(path.basename(restored), 'Thesis_2');
  assert.strictEqual((await open(admin, restored)).body.mainFile, 'thesis.tex');
  assert.strictEqual((await admin.call('GET', '/api/settings')).body.settings.compiler, 'xelatex');
  assert.deepStrictEqual((await admin.call('GET', '/api/share')).body.members.map((m) => m.id), [userId]);
  list = (await admin.call('GET', '/api/projects/list')).body;
  assert.deepStrictEqual(list.labels.assign.Thesis_2, [label.id]);
  assert.strictEqual(list.labels.assign['.trash/Thesis'], undefined);
  assert.strictEqual((await open(user, restored)).status, 200);
});

test('Archiv: Zustand wandert mit, endgültiges Löschen verwirft nur den Papierkorb-Eintrag', async () => {
  const { admin } = await adminAndUser(srv, 'carol');
  const a = (await admin.call('POST', '/api/projects/create', { name: 'Arch' })).body.root;
  await admin.call('POST', '/api/projects/open', { root: a });
  await admin.call('POST', '/api/settings', { compiler: 'lualatex' });
  const label = (await admin.call('POST', '/api/labels', { name: 'A', color: (await admin.call('GET', '/api/projects/list')).body.labelColors[0] })).body;
  await admin.call('POST', '/api/labels/assign', { keys: ['Arch'], labelId: label.id, on: true });
  const b = (await admin.call('POST', '/api/projects/create', { name: 'Sonst' })).body.root;
  await admin.call('POST', '/api/projects/open', { root: b });

  await admin.call('POST', '/api/projects/archive', { name: 'Arch' });
  let list = (await admin.call('GET', '/api/projects/list')).body;
  assert.deepStrictEqual(list.labels.assign['.archive/Arch'], [label.id]);
  assert.strictEqual(list.archivedProjects[0].key, '.archive/Arch');

  // A new active "Arch" gets the name label, then the archived one goes to the trash and is deleted.
  await admin.call('POST', '/api/projects/create', { name: 'Arch' });
  await admin.call('POST', '/api/labels/assign', { keys: ['Arch'], labelId: label.id, on: true });
  assert.strictEqual((await admin.call('POST', '/api/projects/trash', { name: 'Arch', from: 'archive' })).status, 200);
  list = (await admin.call('GET', '/api/projects/list')).body;
  assert.deepStrictEqual(list.labels.assign['.trash/Arch'], [label.id]);
  assert.strictEqual((await admin.call('DELETE', '/api/projects/trash/Arch')).status, 200);
  list = (await admin.call('GET', '/api/projects/list')).body;
  assert.strictEqual(list.labels.assign['.trash/Arch'], undefined);
  assert.deepStrictEqual(list.labels.assign.Arch, [label.id], 'Label des aktiven Projekts bleibt');
  await admin.call('POST', '/api/projects/open', { root: a });
  assert.notStrictEqual((await admin.call('GET', '/api/settings')).body.settings.compiler, 'lualatex');
});
