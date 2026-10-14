// MCP server (Model Context Protocol, Streamable HTTP, stateless, JSON replies) so external
// AI tools (Claude Desktop/Code, Cursor) can work on projects with a per-user token.
// JSON-RPC 2.0 by hand - the handful of methods needed don't justify the SDK.
// Token rights (single switches): read, comment, edit, create, delete, move, compile - for all projects or per selected project.
// Access to a project is always bounded by the user's own access (owner/admin/shared member); reviewers get at most read+comment.
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const collab = require('./collab');
const comments = require('./comments');
const treeOps = require('./treeOps');
const { buildTree, isTextFile, safeResolve, isIgnored, canonRel } = require('./fsTree');
const { searchProject } = require('./search');
const { findMainCandidate } = require('./compile');
const legal = require('./legal');

const MAX_LINES = 400;
const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)/;

const S = (type, description, extra) => ({ type, description, ...extra });
const PROJECT = S('string', 'Projekt-ID aus list_projects (bei Token für genau ein Projekt optional)');
const FILE = S('string', 'Dateipfad relativ zum Projekt, z. B. "chapters/intro.tex"');
const tool = (name, perm, description, properties, required, run) => ({
  name,
  perm,
  description,
  inputSchema: { type: 'object', properties: { project: PROJECT, ...properties }, required },
  run,
});

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const cap = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

// Any path inside the project (traversal blocked), never the IDE's own bookkeeping.
function anyPath(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('path fehlt.');
  // Canonical form ('./x.tex', 'a//b.tex' -> same file, same collab doc); the project root itself is no target.
  const canon = path.relative(path.resolve(root), safeResolve(root, canonRel(rel))).split(path.sep).join('/');
  if (!canon) throw new Error('Die Projektwurzel ist kein gültiges Ziel.');
  if (canon.split('/').some((seg) => isIgnored(seg) || seg.startsWith('.latex-ide'))) throw new Error('Pfad nicht erlaubt.');
  return canon;
}

// Only whole text files.
function textPath(root, rel) {
  const canon = anyPath(root, rel);
  if (!isTextFile(canon)) throw new Error('Keine Textdatei (.tex, .bib, .sty, .cls, .bst, .txt, .md, .cfg).');
  return canon;
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
  const jobs = new Map(); // root -> compile job (one at a time per project)

  const secs = (ms) => `${Math.round(ms / 1000)} s`;

  // Mean of the last 5 stored durations; without history rough guess from project size.
  function estimate(root) {
    const times = ctx.state.getCompileTimes(root).filter((t) => t.ms >= 1000).slice(-5); // failed 0-ms runs would give 'geschätzt 0 s'
    if (times.length) return { ms: Math.max(1000, Math.round(times.reduce((n, t) => n + t.ms, 0) / times.length)), basis: `Mittel der letzten ${times.length} Läufe` };
    const bytes = flatten(buildTree(root)).reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
    return { ms: Math.min(600000, Math.max(10000, 10000 + bytes / 100)), basis: 'Schätzung aus Projektgröße, noch keine Laufzeiten gespeichert' };
  }

  function jobStatus(job) {
    if (!job.done) {
      const elapsed = Date.now() - job.startedAt;
      return `Läuft: ${Math.min(99, Math.floor((100 * elapsed) / job.estimateMs))} % (${secs(elapsed)} von geschätzt ${secs(job.estimateMs)}, ${job.basis}).`;
    }
    const total = job.actualMs !== undefined ? job.actualMs : job.endedAt - job.startedAt;
    const diff = total - job.estimateMs;
    const dev = `Dauer ${secs(total)}, geschätzt ${secs(job.estimateMs)}, Abweichung ${diff >= 0 ? '+' : '-'}${secs(Math.abs(diff))} (${diff >= 0 ? '+' : '-'}${Math.round((100 * Math.abs(diff)) / job.estimateMs)} %).`;
    return `Fertig (100 %). ${dev}\n${job.text}`;
  }

  // Token's project scope + the user's own access, both enforced per call.
  function resolveRoot(a, args) {
    const ids = a.projects ? Object.keys(a.projects) : [];
    const id = args.project || (ids.length === 1 ? ids[0] : '');
    if (!id) throw new Error('project fehlt (siehe list_projects).');
    const root = path.resolve(ctx.PROJECTS_DIR, String(id));
    const inside = root.startsWith(path.resolve(ctx.PROJECTS_DIR) + path.sep);
    if ((a.projects && !a.projects[id]) || !inside || !fs.existsSync(root) || !fs.statSync(root).isDirectory() || !ctx.canAccessRoot(a.user, root)) throw new Error('Projekt nicht gefunden.');
    return root;
  }

  // Rights of the token in one project, capped by the user's role there.
  function permsAt(a, root) {
    const list = (a.projects ? a.projects[ctx.projectIdOf(root)] : a.perms) || [];
    return ctx.roleOf(a.user, root) === 'reviewer' ? list.filter((p) => p === 'read' || p === 'comment') : list;
  }

  const anyPerms = (a) => new Set(a.projects ? Object.values(a.projects).flat() : a.perms);

  const TOOLS = [
    tool('list_projects', null, 'Projekte, auf die dieser Token Zugriff hat, mit den Rechten des Tokens dort (Projekt-ID für die anderen Werkzeuge).', {}, [], async (a) => {
      const list = ctx.mcpProjects(a.user).map((p) => ({ ...p, perms: permsAt(a, path.join(ctx.PROJECTS_DIR, p.id)) })).filter((p) => p.perms.length);
      return list.length ? list.map((p) => `${p.id}  (${p.name}${p.shared ? ', geteilt' : ''})  Rechte: ${p.perms.join(', ')}`).join('\n') : 'Keine Projekte.';
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

    tool(
      'compile',
      'compile',
      'Projekt kompilieren (Hauptdatei). Startet den Lauf im Hintergrund und antwortet sofort mit geschätzter Dauer; Fortschritt/Ergebnis (Fehler/Warnungen) mit compile_status abfragen. ACHTUNG: Kompilieren dauert lange und belastet den Server stark - nur selten kompilieren (z. B. einmal nach einer Reihe von Änderungen), nicht nach jeder Kleinigkeit und nicht in kurzen Abständen nachfragen.',
      {},
      [],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const running = jobs.get(root);
        if (running && !running.done) return 'Es läuft bereits ein Lauf für dieses Projekt.\n' + jobStatus(running);
        const main = ctx.state.getMainFile(root) || findMainCandidate(root);
        if (!main) throw new Error('Keine .tex-Hauptdatei gefunden.');
        const est = estimate(root);
        const job = { startedAt: Date.now(), estimateMs: est.ms, basis: est.basis, done: false };
        jobs.set(root, job);
        ctx.runCompile(root, main, a.user.id, { estimateMs: est.ms, via: 'mcp' }).then(
          (result) => Object.assign(job, { result, text: summarize(result), actualMs: result.durationMs }),
          (e) => Object.assign(job, { text: `Kompilierung abgebrochen: ${e.message}` })
        ).finally(() => {
          job.done = true;
          job.endedAt = Date.now();
          if (job.text) lastCompile.set(root, job.text);
        });
        return `Kompilierung gestartet (läuft im Hintergrund, evtl. erst nach wartenden Läufen anderer). Geschätzte Dauer: ${secs(est.ms)} (${est.basis}). Ergebnis mit compile_status abrufen.`;
      }
    ),

    tool('compile_status', 'compile', 'Fortschritt (in %, bis zum Ende höchstens 99 %) bzw. Ergebnis des letzten compile-Laufs inkl. Abweichung von der Schätzung.', {}, [], async (a, args) => {
      const job = jobs.get(resolveRoot(a, args));
      return job ? jobStatus(job) : 'Kein Compile-Job für dieses Projekt - zuerst compile aufrufen.';
    }),

    tool('get_errors', 'read', 'Fehler/Warnungen des letzten compile-Laufs erneut abrufen.', {}, [], async (a, args) => lastCompile.get(resolveRoot(a, args)) || 'Noch nicht kompiliert - zuerst compile aufrufen.'),

    tool(
      'add_comment',
      'comment',
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
      'comment',
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

    tool(
      'create_file',
      'create',
      'Datei anlegen/hochladen (Ordner werden bei Bedarf erstellt, bestehende Dateien werden nicht überschrieben). Text: content als Klartext; Binärdatei (Bild, PDF …): encoding "base64".',
      { path: FILE, content: S('string', 'Inhalt (Standard leer)'), encoding: S('string', '"utf8" (Standard) oder "base64" für Binärdateien') },
      ['path'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const rel = anyPath(root, args.path);
        if (args.encoding === 'base64') {
          const abs = safeResolve(root, rel);
          if (fs.existsSync(abs)) throw new Error('Datei existiert bereits.');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, Buffer.from(String(args.content || ''), 'base64'));
          return `${rel} hochgeladen (${fs.statSync(abs).size} B).`;
        }
        if (args.encoding && args.encoding !== 'utf8') throw new Error('encoding: "utf8" oder "base64".');
        textPath(root, rel);
        treeOps.createFile(root, rel);
        if (args.content) collab.editText(root, rel, () => String(args.content));
        return `${rel} angelegt.`;
      }
    ),

    tool('delete_file', 'delete', 'Datei oder Ordner (samt Inhalt) endgültig löschen.', { path: S('string', 'Pfad relativ zum Projekt') }, ['path'], async (a, args) => {
      const root = resolveRoot(a, args);
      const rel = anyPath(root, args.path);
      collab.flushRoot(root);
      treeOps.deletePath(root, rel);
      ctx.pathMoved(root, rel, null);
      return `${rel} gelöscht.`;
    }),

    tool(
      'move_file',
      'move',
      'Datei oder Ordner umbenennen/verschieben (new_path = vollständiger Zielpfad, Zielordner werden bei Bedarf erstellt, nichts wird überschrieben).',
      { path: S('string', 'Bisheriger Pfad'), new_path: S('string', 'Neuer Pfad relativ zum Projekt') },
      ['path', 'new_path'],
      async (a, args) => {
        const root = resolveRoot(a, args);
        const from = anyPath(root, args.path);
        const to = anyPath(root, args.new_path);
        const absFrom = safeResolve(root, from);
        const absTo = safeResolve(root, to);
        if (!fs.existsSync(absFrom)) throw new Error('Nicht gefunden.');
        if (fs.existsSync(absTo)) throw new Error('Am Ziel existiert bereits eine Datei/ein Ordner.');
        if (absTo.startsWith(absFrom + path.sep)) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden.');
        collab.flushRoot(root);
        fs.mkdirSync(path.dirname(absTo), { recursive: true });
        fs.renameSync(absFrom, absTo);
        ctx.pathMoved(root, from, to);
        return `${from} -> ${to} verschoben.`;
      }
    ),
  ];

  async function callTool(a, params) {
    const t = TOOLS.find((x) => x.name === (params && params.name));
    if (!t) throw Object.assign(new Error(`Unbekanntes Werkzeug: ${params && params.name}`), { rpc: -32602 });
    const denied = (why) => ({ isError: true, content: [{ type: 'text', text: `Keine Berechtigung für ${t.name} (nötig: ${t.perm})${why}.` }] });
    if (t.perm && !anyPerms(a).has(t.perm)) return denied(' - dieser Token hat das Recht nicht');
    try {
      const args = (params && params.arguments) || {};
      // Per project: the token's rights there, reviewers at most read+comment.
      if (t.perm && !permsAt(a, resolveRoot(a, args)).includes(t.perm)) return denied(' in diesem Projekt');
      return { content: [{ type: 'text', text: await t.run(a, args) }] };
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
          serverInfo: {
            name: 'latex-web-ide',
            title: 'LatexIDE',
            version: ctx.version,
            description: `AGPL-3.0-only. Quellcode: ${legal.SOURCE_LINK}`,
            websiteUrl: legal.SOURCE_URL,
          },
          instructions: 'LaTeX-Projekte lesen/prüfen/bearbeiten. Erst list_projects, dann gezielt outline/search/read_file statt ganze Dateien zu lesen. Kompilieren (compile) ist teuer und läuft asynchron - nur selten nutzen.',
        });
      }
      if (method === 'ping') return ok({});
      if (method === 'tools/list') {
        return ok({ tools: TOOLS.filter((t) => !t.perm || anyPerms(a).has(t.perm)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
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
