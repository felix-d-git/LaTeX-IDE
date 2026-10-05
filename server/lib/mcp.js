// MCP server (Model Context Protocol, Streamable HTTP, stateless, JSON replies) so external
// AI tools (Claude Desktop/Code, Cursor) can work on projects with a per-user token.
// JSON-RPC 2.0 by hand - the handful of methods needed don't justify the SDK.
// Token level: read < review (comments + suggestions) < edit (changes the text).
// Access to a project is always bounded by the user's own access (owner/admin/shared member).
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const collab = require('./collab');
const comments = require('./comments');
const projects = require('./projects');
const treeOps = require('./treeOps');
const { buildTree, isTextFile, safeResolve, isIgnored } = require('./fsTree');
const { searchProject } = require('./search');
const { findMainCandidate } = require('./compile');

const MAX_LINES = 400;
const LEVEL_RANK = { read: 0, review: 1, edit: 2 };
const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)/;

const S = (type, description, extra) => ({ type, description, ...extra });
const PROJECT = S('string', 'Projekt-ID aus list_projects (bei projektgebundenem Token optional)');
const FILE = S('string', 'Dateipfad relativ zum Projekt, z. B. "chapters/intro.tex"');
const tool = (name, level, description, properties, required, run) => ({
  name,
  level,
  description,
  inputSchema: { type: 'object', properties: { project: PROJECT, ...properties }, required },
  run,
});

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const cap = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

// Only whole text files inside the project, never the IDE's own bookkeeping.
function textPath(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('path fehlt.');
  safeResolve(root, rel);
  if (rel.split(/[\\/]/).some((seg) => isIgnored(seg) || seg.startsWith('.latex-ide'))) throw new Error('Pfad nicht erlaubt.');
  if (!isTextFile(rel)) throw new Error('Keine Textdatei (.tex, .bib, .sty, .cls, .bst, .txt, .md, .cfg).');
  return rel.replace(/\\/g, '/');
}

function readText(root, rel) {
  try {
    return collab.readText(root, rel);
  } catch (e) {
    throw new Error(e.notFound ? `Datei nicht gefunden: ${rel}` : e.message);
  }
}

// old_text must match exactly once, otherwise the agent gets told how to disambiguate.
function uniqueIndex(text, old) {
  if (!old) throw new Error('old_text darf nicht leer sein.');
  const first = text.indexOf(old);
  if (first < 0) throw new Error('old_text nicht gefunden (exakter Treffer inkl. Leerzeichen/Zeilenumbrüche nötig).');
  const second = text.indexOf(old, first + 1);
  if (second >= 0) throw new Error(`old_text kommt mehrfach vor (Zeilen ${lineOf(text, first)}, ${lineOf(text, second)}, …) - mehr Kontext angeben.`);
  return first;
}

function flatten(nodes, out = []) {
  for (const n of nodes) (n.type === 'dir' ? flatten(n.children, out) : out.push(n.path));
  return out;
}

function summarize(result) {
  const fmt = (e) => `${e.file || '?'}:${e.line || '?'}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
  const part = (title, list) => (list.length ? `\n${title} (${list.length}):\n` + list.slice(0, 25).map(fmt).join('\n') + (list.length > 25 ? '\n…' : '') : '');
  const head = result.success ? 'Kompilierung erfolgreich.' : result.pdfPath ? 'Kompiliert mit Fehlern/Warnungen (PDF vorhanden).' : 'Kompilierung fehlgeschlagen.';
  return head + part('Fehler', result.errors || []) + part('Warnungen', result.warnings || []) + (!(result.errors || []).length && !result.success ? '\nLog-Ende:\n' + result.log.split('\n').slice(-15).join('\n') : '');
}

function createMcp(ctx) {
  const lastCompile = new Map(); // root -> compact text of the last compile

  // Token's project binding + the user's own access, both enforced per call.
  function resolveRoot(a, args) {
    const id = args.project || a.project;
    if (!id) throw new Error('project fehlt (siehe list_projects).');
    if (a.project && a.project !== id) throw new Error('Dieser Token ist auf ein anderes Projekt beschränkt.');
    const root = path.resolve(ctx.PROJECTS_DIR, String(id));
    const inside = root.startsWith(path.resolve(ctx.PROJECTS_DIR) + path.sep);
    if (!inside || !fs.existsSync(root) || !fs.statSync(root).isDirectory() || !ctx.canAccessRoot(a.user, root)) throw new Error('Projekt nicht gefunden.');
    return root;
  }

  const TOOLS = [
    tool('list_projects', 'read', 'Projekte, auf die dieser Token Zugriff hat (Projekt-ID für die anderen Werkzeuge).', {}, [], async (a) => {
      const own = projects.listProjects(ctx.userProjectsDir(a.user)).filter((p) => !(a.user.isAdmin && p.name === 'users'));
      const shared = ctx.state.sharedRootsFor(a.user.id).filter((r) => fs.existsSync(r));
      const roots = [...own.map((p) => p.root), ...shared].map((r) => ({ id: ctx.projectIdOf(r), name: path.basename(r), shared: shared.includes(r) }));
      const list = roots.filter((p) => !a.project || p.id === a.project);
      return list.length ? list.map((p) => `${p.id}  (${p.name}${p.shared ? ', geteilt' : ''})`).join('\n') : 'Keine Projekte.';
    }),

    tool('project_tree', 'read', 'Dateien des Projekts mit Größe und Zeilenzahl (nur Pfade, kein Inhalt).', {}, [], async (a, args) => {
      const root = resolveRoot(a, args);
      collab.flushRoot(root);
      const files = flatten(buildTree(root));
      const rows = files.slice(0, 500).map((f) => {
        const abs = path.join(root, f);
        const size = fs.statSync(abs).size;
        const lines = isTextFile(f) ? ` ${fs.readFileSync(abs, 'utf8').split('\n').length} Zeilen` : '';
        return `${f}  ${size} B${lines}`;
      });
      return rows.join('\n') + (files.length > 500 ? `\n… (${files.length - 500} weitere)` : '');
    }),

    tool('outline', 'read', 'Gliederung (\\section …) und \\label-Stellen aller .tex-Dateien mit Zeilennummern.', { path: S('string', 'Optional: nur diese Datei') }, [], async (a, args) => {
      const root = resolveRoot(a, args);
      collab.flushRoot(root);
      const files = args.path ? [textPath(root, args.path)] : flatten(buildTree(root)).filter((f) => f.toLowerCase().endsWith('.tex'));
      const out = [];
      for (const f of files) {
        readText(root, f).split('\n').forEach((line, i) => {
          const m = SECTION_RE.exec(line);
          if (m) out.push(`${f}:${i + 1}  ${m[1]}: ${m[2]}`);
          for (const l of line.matchAll(/\\label\{([^}]+)\}/g)) out.push(`${f}:${i + 1}  label: ${l[1]}`);
        });
      }
      return out.slice(0, 300).join('\n') + (out.length > 300 ? `\n… (${out.length - 300} weitere)` : '') || 'Keine Gliederung gefunden.';
    }),

    tool(
      'read_file',
      'read',
      `Textdatei lesen, mit Zeilennummern, max. ${MAX_LINES} Zeilen pro Aufruf.`,
      { path: FILE, start_line: S('integer', 'Erste Zeile (1-basiert, Standard 1)'), end_line: S('integer', `Letzte Zeile (Standard start+${MAX_LINES - 1})`) },
      ['path'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const lines = readText(root, textPath(root, args.path)).split('\n');
        const start = Math.max(1, args.start_line | 0 || 1);
        const end = Math.min(lines.length, args.end_line | 0 || start + MAX_LINES - 1, start + MAX_LINES - 1);
        if (start > lines.length) throw new Error(`Datei hat nur ${lines.length} Zeilen.`);
        const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
        return `${args.path} Zeilen ${start}-${end} von ${lines.length}\n${body}`;
      }
    ),

    tool(
      'search',
      'read',
      'Text/Regex im ganzen Projekt suchen -> datei:zeile + Zeile (max. 50 Treffer).',
      { query: S('string', 'Suchtext oder Regex'), regex: S('boolean', 'query ist Regex'), case_sensitive: S('boolean', 'Groß-/Kleinschreibung beachten') },
      ['query'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        collab.flushRoot(root);
        const res = searchProject(root, String(args.query || ''), { regex: !!args.regex, caseSensitive: !!args.case_sensitive });
        const rows = res.slice(0, 50).map((r) => `${r.file}:${r.line}: ${cap(r.lineText.trim())}`);
        return rows.length ? rows.join('\n') + (res.length > 50 ? `\n… (${res.length - 50} weitere Zeilen)` : '') : 'Keine Treffer.';
      }
    ),

    tool('compile', 'read', 'Projekt kompilieren (Hauptdatei) und Fehler/Warnungen kompakt zurückgeben. Kann bis zu einigen Minuten dauern.', {}, [], async (a, args) => {
      const root = resolveRoot(a, args);
      const main = ctx.state.getMainFile(root) || findMainCandidate(root);
      if (!main) throw new Error('Keine .tex-Hauptdatei gefunden.');
      const text = summarize(await ctx.runCompile(root, main, a.user.id));
      lastCompile.set(root, text);
      return text;
    }),

    tool('get_errors', 'read', 'Fehler/Warnungen des letzten compile-Laufs erneut abrufen.', {}, [], async (a, args) => lastCompile.get(resolveRoot(a, args)) || 'Noch nicht kompiliert - zuerst compile aufrufen.'),

    tool(
      'add_comment',
      'review',
      'Kommentar an einer Zeile oder Textstelle hinzufügen (erscheint im Kommentar-Panel der IDE).',
      { path: FILE, line: S('integer', 'Zeile (1-basiert)'), quote: S('string', 'Alternativ: exakte Textstelle (muss einmal vorkommen)'), text: S('string', 'Kommentartext') },
      ['path', 'text'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const rel = textPath(root, args.path);
        const text = readText(root, rel);
        let from, to;
        if (args.quote) {
          from = uniqueIndex(text, args.quote);
          to = from + args.quote.length;
        } else {
          const lines = text.split('\n');
          const ln = args.line | 0;
          if (ln < 1 || ln > lines.length) throw new Error('line oder quote angeben (Zeile außerhalb der Datei?).');
          from = lines.slice(0, ln - 1).reduce((n, l) => n + l.length + 1, 0);
          to = from + lines[ln - 1].length;
        }
        if (!String(args.text || '').trim()) throw new Error('text fehlt.');
        comments.add(root, rel, { from, to, anchorText: text.slice(from, to), text: String(args.text).trim(), author: { id: a.user.id, name: a.name } });
        ctx.broadcast(root, { type: 'commentsChanged', path: rel });
        return `Kommentar bei Zeile ${lineOf(text, from)} hinzugefügt.`;
      }
    ),

    tool(
      'suggest_change',
      'review',
      'Änderung vorschlagen: erscheint im Kommentar-Panel der IDE mit Annehmen/Ablehnen, der Text bleibt bis dahin unverändert.',
      { path: FILE, old_text: S('string', 'Zu ersetzender Text (exakt, genau einmal vorhanden)'), new_text: S('string', 'Neuer Text'), reason: S('string', 'Optionale Begründung') },
      ['path', 'old_text', 'new_text'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const rel = textPath(root, args.path);
        const text = readText(root, rel);
        const from = uniqueIndex(text, args.old_text);
        if (typeof args.new_text !== 'string') throw new Error('new_text fehlt.');
        comments.add(root, rel, {
          from,
          to: from + args.old_text.length,
          anchorText: args.old_text,
          text: String(args.reason || '').trim() || 'Änderungsvorschlag',
          suggestion: { oldText: args.old_text, newText: args.new_text },
          author: { id: a.user.id, name: a.name },
        });
        ctx.broadcast(root, { type: 'commentsChanged', path: rel });
        return `Vorschlag bei Zeile ${lineOf(text, from)} gespeichert (wartet auf Annehmen/Ablehnen in der IDE).`;
      }
    ),

    tool(
      'edit_file',
      'edit',
      'Text ersetzen: old_text muss genau einmal vorkommen. Geöffnete Editoren sehen die Änderung live.',
      { path: FILE, old_text: S('string', 'Zu ersetzender Text (exakt, genau einmal)'), new_text: S('string', 'Neuer Text') },
      ['path', 'old_text', 'new_text'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const rel = textPath(root, args.path);
        if (typeof args.new_text !== 'string') throw new Error('new_text fehlt.');
        let line;
        try {
          collab.editText(root, rel, (text) => {
            const i = uniqueIndex(text, args.old_text);
            line = lineOf(text, i);
            return text.slice(0, i) + args.new_text + text.slice(i + args.old_text.length);
          });
        } catch (e) {
          throw e.notFound ? new Error(`Datei nicht gefunden: ${rel}`) : e;
        }
        return `${rel} geändert (ab Zeile ${line}).`;
      }
    ),

    tool('create_file', 'edit', 'Neue Textdatei anlegen (Ordner werden bei Bedarf erstellt).', { path: FILE, content: S('string', 'Inhalt (Standard leer)') }, ['path'], async (a, args) => {
      const root = resolveRoot(a, args);
      const rel = treeOps.createFile(root, textPath(root, args.path));
      if (args.content) collab.editText(root, rel, () => String(args.content));
      return `${rel} angelegt.`;
    }),
  ];

  async function callTool(a, params) {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) throw Object.assign(new Error(`Unbekanntes Werkzeug: ${params && params.name}`), { rpc: -32602 });
    if (LEVEL_RANK[a.level] < LEVEL_RANK[t.level]) return { isError: true, content: [{ type: 'text', text: `Dieser Token (${a.level}) darf ${t.name} nicht ausführen (nötig: ${t.level}).` }] };
    try {
      // Reviewer im Projekt: Token darf hoechstens kommentieren/vorschlagen.
      if (t.level === 'edit' && ctx.roleOf(a.user, resolveRoot(a, (params && params.arguments) || {})) === 'reviewer') throw new Error('Im Projekt nur Reviewer-Rechte: bitte suggest_change verwenden.');
      return { content: [{ type: 'text', text: await t.run(a, (params && params.arguments) || {}) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  }

  async function rpc(a, msg) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) return null; // notification (e.g. notifications/initialized)
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    try {
      if (method === 'initialize') {
        return ok({
          protocolVersion: (params && params.protocolVersion) || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'latex-web-ide', version: ctx.version },
          instructions: 'LaTeX-Projekte lesen/prüfen/bearbeiten. Erst list_projects, dann gezielt outline/search/read_file statt ganze Dateien zu lesen.',
        });
      }
      if (method === 'ping') return ok({});
      if (method === 'tools/list') {
        return ok({ tools: TOOLS.filter((t) => LEVEL_RANK[a.level] >= LEVEL_RANK[t.level]).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      }
      if (method === 'tools/call') return ok(await callTool(a, params));
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Methode nicht unterstützt: ${method}` } };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: e.rpc || -32603, message: e.message } };
    }
  }

  return async function handle(req, res) {
    const h = req.headers.authorization || '';
    const t = auth.findMcpToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
    if (!t) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Ungültiger oder widerrufener Token.' });
    const body = req.body;
    if (Array.isArray(body) ? !body.length : !body || typeof body !== 'object') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Ungültige Anfrage.' } });
    const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => rpc(t, m)))).filter(Boolean);
    if (!replies.length) return res.status(202).end();
    res.json(Array.isArray(body) ? replies : replies[0]);
  };
}

module.exports = { createMcp };
