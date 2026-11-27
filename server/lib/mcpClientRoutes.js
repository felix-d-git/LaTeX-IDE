// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Routen des MCP-Clients (#126): Server je Nutzer verwalten + Werkzeuge im KI-Chat aufrufen.
const mc = require('./mcpClient');

function register(app, { auth, limitAi, ah }) {
  const list = (req) => structuredClone(req.user.mcpServers || []);
  const save = (req, l) => auth.setMcpServers(req.user.id, l);
  const find = (l, id) => l.find((s) => s.id === String(id));
  const fail = (res, e) => res.status(e.mcp ? 400 : 500).json({ error: e.mcp ? e.message : 'Interner Fehler.' });

  async function refresh(s) {
    try {
      mc.applyTools(s, await mc.listTools(s));
      s.status = 'verbunden';
    } catch (e) {
      s.status = `Fehler: ${e.mcp ? e.message : 'nicht erreichbar'}`.slice(0, 200);
    }
  }

  app.get('/api/mcp-client/servers', (req, res) => res.json({ servers: list(req).map(mc.publicServer) }));

  app.post('/api/mcp-client/servers', limitAi, ah(async (req, res) => {
    const l = list(req);
    try {
      const s = mc.newServer(l, req.body || {});
      await refresh(s);
      save(req, l.concat(s));
      res.json({ server: mc.publicServer(s) });
    } catch (e) {
      fail(res, e);
    }
  }));

  app.post('/api/mcp-client/import', limitAi, ah(async (req, res) => {
    const l = list(req);
    try {
      const { added, skipped } = mc.parseDesktopConfig(String((req.body || {}).config || ''), l);
      await Promise.all(added.map(refresh)); // alle Tools "ask" (applyTools-Default)
      save(req, l.concat(added));
      res.json({ added: added.map(mc.publicServer), skipped });
    } catch (e) {
      fail(res, e);
    }
  }));

  app.patch('/api/mcp-client/servers/:id', limitAi, (req, res) => {
    const l = list(req);
    const s = find(l, req.params.id);
    if (!s) return res.status(404).json({ error: 'Server nicht gefunden.' });
    const { enabled, perms } = req.body || {};
    if (typeof enabled === 'boolean') s.enabled = enabled;
    if (perms && typeof perms === 'object') {
      for (const [t, p] of Object.entries(perms)) if (mc.PERMS.includes(p) && s.tools.some((x) => x.name === t)) s.perms[t] = p;
    }
    save(req, l);
    res.json({ server: mc.publicServer(s) });
  });

  app.post('/api/mcp-client/servers/:id/refresh', limitAi, ah(async (req, res) => {
    const l = list(req);
    const s = find(l, req.params.id);
    if (!s) return res.status(404).json({ error: 'Server nicht gefunden.' });
    await refresh(s);
    save(req, l);
    res.json({ server: mc.publicServer(s) });
  }));

  app.delete('/api/mcp-client/servers/:id', (req, res) => {
    save(req, list(req).filter((s) => s.id !== req.params.id));
    res.json({ ok: true });
  });

  // KI-Chat: Fremd-Werkzeuge (nur aktive Server, ohne blockierte Tools).
  app.post('/api/ai/mcp-tools', limitAi, (req, res) => res.json({ tools: mc.chatTools(list(req)) }));
  app.post('/api/ai/mcp-call', limitAi, ah(async (req, res) => {
    const b = req.body || {};
    res.json(await mc.callByName(list(req), String(b.name || ''), b.arguments, b.confirmed === true));
  }));
}

module.exports = { register };
