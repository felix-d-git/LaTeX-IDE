// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// KI-Chat (#125): Werkzeugrechte = Rolle ∩ Modus, Rückfrage bei create/delete/move/compile,
// Agent-Änderungen als Track Change, Sicherung "vor KI" im Verlauf.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { startServer, adminAndUser } = require('./_server');

test('KI-Werkzeuge: Modi, Reviewer-Deckel, Bestätigung, Track Change, Snapshot', async () => {
  const srv = await startServer();
  try {
    const { admin, user } = await adminAndUser(srv);
    const { root } = (await admin.call('POST', '/api/projects/create', { name: 'KiTest' })).body;
    const pid = (await admin.call('POST', '/api/projects/open', { root })).body.projectId;
    const h = { 'X-Project-Id': pid };
    const names = async (c, body, hh = h) => (await c.call('POST', '/api/ai/tools', body, hh)).body.tools.map((t) => t.name);

    const ask = await names(admin, { mode: 'ask' });
    assert.ok(ask.includes('read_file') && !ask.includes('edit_file') && !ask.includes('add_comment'));
    assert.ok(!ask.includes('list_projects'));
    assert.ok((await names(admin, { mode: 'suggest' })).includes('suggest_change'));
    const agent = await names(admin, { mode: 'agent' });
    assert.ok(agent.includes('edit_file') && agent.includes('create_file') && !agent.includes('compile'));
    assert.ok((await names(admin, { mode: 'agent', allowCompile: true })).includes('compile'));
    const t0 = (await admin.call('POST', '/api/ai/tools', { mode: 'ask' }, h)).body.tools[0];
    assert.ok(!('project' in (t0.inputSchema.properties || {})), 'Projekt kommt vom Fenster, nicht vom Modell');

    const tool = (c, body, hh = h) => c.call('POST', '/api/ai/tool', body, hh).then((r) => r.body);
    // Nicht erlaubtes Werkzeug / fehlende Bestätigung
    assert.equal((await tool(admin, { mode: 'ask', name: 'edit_file', arguments: {} })).isError, true);
    const noConfirm = await tool(admin, { mode: 'agent', name: 'create_file', arguments: { path: 'neu.tex', content: 'x' } });
    assert.match(noConfirm.text, /Bestätigung/);
    assert.ok(!fs.existsSync(path.join(root, 'neu.tex')));
    const created = await tool(admin, { mode: 'agent', name: 'create_file', arguments: { path: 'neu.tex', content: 'Hallo Welt' }, confirmed: true });
    assert.equal(created.isError, false, created.text);

    // Agent-Edit = Track Change: Review-Einträge mit KI-Nutzer im Y-Zustand
    const edit = await tool(admin, { mode: 'agent', name: 'edit_file', arguments: { path: 'neu.tex', old_text: 'Welt', new_text: 'KI' } });
    assert.equal(edit.isError, false, edit.text);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, fs.readFileSync(path.join(root, '.latex-ide-yjs', 'neu.tex.ystate')));
    assert.equal(ydoc.getText('content').toString(), 'Hallo KI');
    const entries = [...ydoc.getMap('review').values()];
    assert.deepEqual(entries.map((e) => e.type).sort(), ['delete', 'insert']);
    assert.equal(entries.find((e) => e.type === 'delete').text, 'Welt');
    assert.ok(entries.every((e) => e.user.id.startsWith('ai:') && /KI-Assistent/.test(e.user.name)));
    const abs = (j) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), ydoc).index;
    const ins = entries.find((e) => e.type === 'insert');
    assert.equal(ydoc.getText('content').toString().slice(abs(ins.f), abs(ins.t)), 'KI', 'Markierung deckt genau den neuen Text');

    // Snapshot "vor KI"
    const snap = (await admin.call('POST', '/api/ai/snapshot', { label: 'Mach was' }, h)).body;
    assert.equal(snap.ok, true);
    const hist = (await admin.call('GET', '/api/history', undefined, h)).body.entries;
    assert.ok(hist.some((e) => e.trigger === 'ai' && e.label === 'vor KI: Mach was'));

    // Reviewer: Agent wird zu Vorschlagen, kein Snapshot
    assert.equal((await admin.call('POST', '/api/share', { login: 'bob', role: 'reviewer' }, h)).status, 200);
    const bpid = (await user.call('POST', '/api/projects/open', { root })).body.projectId;
    const bh = { 'X-Project-Id': bpid };
    const rv = (await user.call('POST', '/api/ai/tools', { mode: 'agent' }, bh)).body;
    assert.equal(rv.mode, 'suggest');
    assert.ok(!rv.tools.some((t) => t.name === 'edit_file' || t.name === 'create_file'));
    assert.equal((await tool(user, { mode: 'agent', name: 'edit_file', arguments: { path: 'neu.tex', old_text: 'KI', new_text: 'x' } }, bh)).isError, true);
    assert.equal((await tool(user, { mode: 'ask', name: 'read_file', arguments: { path: 'neu.tex' } }, bh)).isError, false);
    assert.equal((await user.call('POST', '/api/ai/snapshot', { label: 'x' }, bh)).status, 403);
  } finally {
    await srv.stop();
  }
});
