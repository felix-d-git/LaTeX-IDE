// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #183: no absolute server paths in error answers, share/join and project lists.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startServer, adminAndUser } = require('./_server');

const ABS = /[A-Za-z]:[\/]|(^|["\s])\/(home|tmp|var|usr|opt)\//;

test('#183: 500 ohne Pfad, share/join und Projektlisten ohne absoluten root', async () => {
  const srv = await startServer();
  test.after(() => srv.stop());
  const { admin, user } = await adminAndUser(srv, 'erika');
  const created = (await admin.call('POST', '/api/projects/create', { name: 'Leck' })).body;
  const pid = { 'X-Project-Id': created.projectId };
  await admin.call('POST', '/api/projects/open', { projectId: created.projectId });

  const err = await admin.call('POST', '/api/projects/rename', { oldName: 5, newName: 'x' });
  assert.strictEqual(err.status, 500);
  assert.ok(!ABS.test(err.text) && !err.text.includes(srv.dataDir), err.text);

  const link = (await admin.call('POST', '/api/share/link', { role: 'editor' }, pid)).body;
  const token = link.newLink.token;
  const join = await user.call('POST', '/api/share/join', { token });
  assert.strictEqual(join.status, 200, join.text);
  assert.deepStrictEqual(Object.keys(join.body), ['projectId']);
  assert.ok(!path.isAbsolute(join.body.projectId));

  for (const c of [admin, user]) {
    const list = (await c.call('GET', '/api/projects/list')).body;
    const text = JSON.stringify(list);
    assert.ok(!text.includes(srv.dataDir) && !ABS.test(text), text);
    assert.ok([...list.localProjects, ...list.sharedProjects].every((p) => p.id && p.root === undefined));
  }
  const shared = (await user.call('GET', '/api/projects/list')).body.sharedProjects;
  assert.strictEqual(shared[0].id, join.body.projectId);
  const open = await user.call('POST', '/api/projects/open', { projectId: join.body.projectId });
  assert.strictEqual(open.status, 200, open.text);
  assert.strictEqual(open.body.projectId, created.projectId);
});
