// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// KI-Chat (#125), Browser-Seite: Streaming, Fehlermeldungen, Timeout, Agent-Schleife, Markdown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../client/src/ai.js'), 'utf8');
const load = () => import('data:text/javascript,' + encodeURIComponent(src));
const S = { baseUrl: 'http://localhost:11434/v1/', model: 'm', apiKey: 'k' };
const realFetch = globalThis.fetch;
test.afterEach(() => (globalThis.fetch = realFetch));

const sse = (chunks) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: c }] })}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
const json = (msg) => Response.json({ choices: [{ message: msg }] });
const call = (name, args, id = 'c1') => ({ tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('chat: Stream mit Text + zerstückeltem Tool-Call, Key als Bearer', async () => {
  const { chat } = await load();
  let seen;
  globalThis.fetch = async (url, o) => {
    seen = { url, o };
    return sse([
      { content: 'Hal' },
      { content: 'lo' },
      { tool_calls: [{ index: 0, id: 'x', function: { name: 'read_', arguments: '{"pa' } }] },
      { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.tex"}' } }] },
    ]);
  };
  const deltas = [];
  const r = await chat(S, [{ role: 'user', content: 'hi' }], { tools: [{}], onDelta: (d) => deltas.push(d) });
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen.o.headers.Authorization, 'Bearer k');
  assert.equal(r.content, 'Hallo');
  assert.deepEqual(deltas, ['Hal', 'lo']);
  assert.equal(r.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.tool_calls[0].function.arguments), { path: 'a.tex' });
});

test('chat: Modell ohne Tools → zweiter Versuch ohne tools; 401/429 verständlich', async () => {
  const { chat } = await load();
  const bodies = [];
  globalThis.fetch = async (url, o) => {
    bodies.push(JSON.parse(o.body));
    return bodies.length === 1 ? new Response('{"error":{"message":"model does not support tools"}}', { status: 400 }) : json({ content: 'ok' });
  };
  const r = await chat(S, [], { tools: [{}] });
  assert.equal(r.noTools, true);
  assert.ok(bodies[0].tools && !bodies[1].tools);
  globalThis.fetch = async () => new Response('nein', { status: 401 });
  await assert.rejects(chat(S, []), /API-Key/);
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(chat(S, []), /Kontingent/);
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(chat(S, []), /nicht erreichbar.*OLLAMA_ORIGINS/);
});

test('chat: Leerlauf-Timeout und Abbruch', async () => {
  const { chat } = await load();
  globalThis.fetch = (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(chat(S, [], { timeoutMs: 50 }), /Timeout/);
  const ac = new AbortController();
  const p = chat(S, [], { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('runAgent: Rückfrage bei create (abgelehnt → nicht ausgeführt), compile_status ohne, Schrittlimit', async () => {
  const { runAgent, needsConfirm } = await load();
  assert.equal(needsConfirm({ name: 'compile_status', perm: 'compile' }), false);
  assert.equal(needsConfirm({ name: 'compile', perm: 'compile' }), true);
  assert.equal(needsConfirm({ name: 'edit_file', perm: 'edit' }), false);
  const tools = [
    { name: 'create_file', perm: 'create', inputSchema: {} },
    { name: 'compile_status', perm: 'compile', inputSchema: {} },
    { name: 'read_file', perm: 'read', inputSchema: {} },
  ];
  const replies = [call('create_file', { path: 'x.tex' }), call('compile_status', {}), { content: 'fertig' }];
  globalThis.fetch = async () => json(replies.shift());
  const calls = [];
  const asked = [];
  const out = await runAgent({
    settings: S,
    messages: [],
    tools,
    confirm: async (name) => (asked.push(name), false),
    callTool: async (name, args, confirmed) => (calls.push([name, confirmed]), { text: 'ok' }),
  });
  assert.deepEqual(asked, ['create_file']);
  assert.deepEqual(calls, [['compile_status', false]]);
  assert.equal(out.find((m) => m.role === 'tool').content, 'Vom Nutzer abgelehnt.');
  assert.equal(out.at(-1).content, 'fertig');

  globalThis.fetch = async () => json(call('read_file', { path: 'a' }));
  const loop = await runAgent({ settings: S, messages: [], tools, maxSteps: 3, callTool: async () => ({ text: 'x' }) });
  assert.match(loop.at(-1).content, /Schrittlimit \(3\)/);
  const unknown = await runAgent({ settings: S, messages: [], tools: [], maxSteps: 1, callTool: async () => assert.fail('nicht erlaubt') });
  assert.match(unknown.find((m) => m.role === 'tool').content, /nicht verfügbar/);
});

test('renderMarkdown: escaped HTML, Code-Blöcke, fett', async () => {
  const { renderMarkdown } = await load();
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)> **a**'), '&lt;img src=x onerror=alert(1)&gt; <strong>a</strong>');
  assert.equal(renderMarkdown('x `\\a<b>`'), 'x <code>\\a&lt;b&gt;</code>');
  assert.equal(renderMarkdown('vor\n```latex\n\\section{<x>}\n```\nnach'), 'vor<br><pre>\\section{&lt;x&gt;}</pre>nach');
});
