// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// KI-Chat (#125): ein Adapter für OpenAI-kompatible /chat/completions (OpenAI, Mistral, OpenRouter,
// Groq, Ollama, LM Studio …) mit Streaming und Tool-Calling, plus die Agent-Schleife.
// Keine Importe: die Tests laden die Datei direkt (wie keybindings.js).
// Der API-Key liegt nur im localStorage dieses Geräts – nie im Projekt, im Yjs-Dokument oder beim Server.

export const AI_KEY = 'latex-ide-ai-v1';
export const DEFAULT_AI = { baseUrl: '', apiKey: '', model: '', contextChars: 24000, mode: 'suggest', allowCompile: false };
export const MODES = { ask: 'Fragen', suggest: 'Vorschlagen', agent: 'Agent' };
export const CONFIRM_PERMS = new Set(['create', 'delete', 'move', 'compile']);
const WRITE_PERMS = new Set(['edit', 'create', 'delete', 'move']);
// compile_status fragt nur den Fortschritt ab, das braucht keine Rückfrage.
export const needsConfirm = (t) => CONFIRM_PERMS.has(t.perm) && t.name !== 'compile_status';

export function loadAi() {
  try {
    return { ...DEFAULT_AI, ...(JSON.parse(localStorage.getItem(AI_KEY)) || {}) };
  } catch (e) {
    return { ...DEFAULT_AI };
  }
}
export function saveAi(patch) {
  const next = { ...loadAi(), ...patch };
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(next));
  } catch (e) {}
  window.dispatchEvent(new CustomEvent('lide-ai-settings', { detail: next }));
  return next;
}
export const isConfigured = (s) => !!(s && s.baseUrl && s.model);

const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
const csrf = () => {
  const m = typeof document !== 'undefined' && document.cookie.match(/(?:^|; )csrfToken=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
};
// Desktop-App: Cloud-Anbieter über ihren lokalen Proxy (die CSP lässt den Browser nur localhost erreichen).
let desktop = null;
const isDesktop = () =>
  (desktop =
    desktop ||
    fetch('/api/desktop/info')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => !!d.desktop)
      .catch(() => false));

async function request(s, path, body, signal) {
  const url = s.baseUrl.trim().replace(/\/+$/, '') + path;
  if (!isLocalUrl(url) && (await isDesktop())) {
    return fetch('/api/ai-local', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ url, key: s.apiKey, body }), signal });
  }
  return fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

// Verständliche Meldung statt "Failed to fetch" / rohem JSON.
export function providerError(status, detail = '') {
  const d = detail ? ` (${String(detail).slice(0, 200)})` : '';
  if (status === 401 || status === 403) return `Der Anbieter lehnt den API-Key ab (${status}). Key unter Einstellungen → KI prüfen${d}.`;
  if (status === 404) return `Adresse oder Modell nicht gefunden (404). Basis-URL (endet meist auf /v1) und Modellname prüfen${d}.`;
  if (status === 429) return `Zu viele Anfragen oder Kontingent erschöpft (429). Kurz warten bzw. Guthaben beim Anbieter prüfen${d}.`;
  if (status >= 500) return `Fehler beim Anbieter (${status}), später erneut versuchen${d}.`;
  return `Anfrage abgelehnt (${status})${d}.`;
}
const unreachable = () =>
  `Anbieter nicht erreichbar. Läuft er? Ollama im Browser braucht OLLAMA_ORIGINS=${typeof location !== 'undefined' ? location.origin : '<Adresse der IDE>'}; Cloud-Anbieter im Browser müssen in CSP_CONNECT_SRC des Servers stehen und CORS erlauben (die Desktop-App braucht beides nicht).`;

async function errorText(res) {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t);
    return (j.error && (j.error.message || j.error)) || j.message || t;
  } catch (e) {
    return t;
  }
}

// One /chat/completions call. Streams text via onDelta, returns { content, tool_calls, noTools }.
// timeoutMs = Leerlauf: so lange darf zwischen zwei Teilen der Antwort nichts kommen.
export async function chat(s, messages, { tools, signal, onDelta, timeoutMs = 90000 } = {}) {
  const ac = new AbortController();
  let timedOut = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
  };
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    signal.addEventListener('abort', onAbort);
  }
  const fail = (e) => {
    if (timedOut) return new Error(`Keine Antwort vom Anbieter innerhalb von ${Math.round(timeoutMs / 1000)} s (Timeout).`);
    if (ac.signal.aborted) return Object.assign(new Error('Abgebrochen.'), { name: 'AbortError' });
    return e instanceof TypeError ? new Error(unreachable()) : e;
  };
  try {
    arm();
    const body = { model: s.model, messages, stream: true, ...(tools && tools.length ? { tools } : {}) };
    let res = await request(s, '/chat/completions', body, ac.signal);
    let noTools = false;
    if (res.status === 400 && body.tools) {
      const t = await errorText(res);
      if (!/tool|function/i.test(t)) throw new Error(providerError(400, t));
      // Modell ohne Tool-Calling: nur mit dem vorab eingefügten Kontext antworten.
      delete body.tools;
      noTools = true;
      res = await request(s, '/chat/completions', body, ac.signal);
    }
    if (!res.ok) throw new Error(providerError(res.status, await errorText(res)));
    const out = { content: '', tool_calls: [], noTools };
    const take = (msg) => {
      if (!msg) return;
      if (msg.content) {
        out.content += msg.content;
        onDelta && onDelta(msg.content, out.content);
      }
      for (const tc of msg.tool_calls || []) {
        const i = tc.index !== undefined ? tc.index : out.tool_calls.length;
        const cur = (out.tool_calls[i] = out.tool_calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.function.name += tc.function.name;
        if (tc.function && tc.function.arguments) cur.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
    };
    if (!/event-stream/.test(res.headers.get('content-type') || '') || !res.body) {
      const j = await res.json();
      take(j.choices && j.choices[0] && j.choices[0].message);
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = line.match(/^data:\s?(.*)$/);
          if (!m || m[1].trim() === '[DONE]' || !m[1].trim()) continue;
          let j;
          try {
            j = JSON.parse(m[1]);
          } catch (e) {
            continue;
          }
          if (j.error) throw new Error(providerError(j.error.code || 500, j.error.message || j.error));
          take(j.choices && j.choices[0] && j.choices[0].delta);
        }
      }
    }
    out.tool_calls = out.tool_calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    return out;
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function listModels(s) {
  const res = await request(s, '/models').catch((e) => {
    throw e instanceof TypeError ? new Error(unreachable()) : e;
  });
  if (!res.ok) throw new Error(providerError(res.status, await errorText(res)));
  const j = await res.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// Agent-Schleife: Modell antwortet → tool_calls ausführen → Ergebnisse zurück → bis Endantwort.
// tools: [{ name, perm, description, inputSchema }] (vom Server, schon nach Modus/Rolle gefiltert).
// callTool(name, args, confirmed) → { text, isError }; confirm(name, args) → Promise<boolean>.
// onEvent({ type: 'delta'|'assistant'|'tool', … }). Gibt die neuen Nachrichten zurück.
export async function runAgent({ settings, messages, tools = [], callTool, confirm, onEvent = () => {}, signal, maxSteps = 15, maxWrites = 20, timeoutMs }) {
  const spec = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const added = [];
  let writes = 0;
  for (let step = 0; step < maxSteps; step++) {
    const res = await chat(settings, messages.concat(added), { tools: spec, signal, timeoutMs, onDelta: (d, all) => onEvent({ type: 'delta', delta: d, text: all }) });
    const msg = { role: 'assistant', content: res.content || '', ...(res.tool_calls.length ? { tool_calls: res.tool_calls } : {}) };
    added.push(msg);
    onEvent({ type: 'assistant', message: msg, noTools: res.noTools });
    if (!res.tool_calls.length) return added;
    for (const call of res.tool_calls) {
      if (signal && signal.aborted) throw Object.assign(new Error('Abgebrochen.'), { name: 'AbortError' });
      const name = call.function.name;
      const t = byName.get(name);
      let args = {};
      let result;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        result = { isError: true, text: 'Ungültige Argumente (kein JSON).' };
      }
      if (!result && !t) result = { isError: true, text: `Werkzeug ${name} ist in diesem Modus nicht verfügbar.` };
      if (!result && WRITE_PERMS.has(t.perm) && ++writes > maxWrites) result = { isError: true, text: `Schreibgrenze dieses Laufs (${maxWrites} Änderungen) erreicht – Nutzer fragen, ob weitergemacht werden soll.` };
      let confirmed = false;
      if (!result && needsConfirm(t)) {
        confirmed = !!(await confirm(name, args));
        if (!confirmed) result = { isError: true, text: 'Vom Nutzer abgelehnt.' };
      }
      if (!result) {
        try {
          result = await callTool(name, args, confirmed);
        } catch (e) {
          result = { isError: true, text: e.message };
        }
      }
      onEvent({ type: 'tool', name, args, perm: t && t.perm, result });
      added.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }
  const stop = { role: 'assistant', content: `Schrittlimit (${maxSteps}) erreicht – angehalten. Mit einer neuen Nachricht geht es weiter.` };
  added.push(stop);
  onEvent({ type: 'assistant', message: stop, limit: true });
  return added;
}

// Mini-Markdown für Antworten: erst alles escapen, dann ```-Blöcke, `code`, **fett**. Kein HTML aus der Antwort.
export function renderMarkdown(text) {
  const esc = (x) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return String(text || '')
    .split(/```[^\n]*\n?/)
    .map((part, i) =>
      i % 2
        ? `<pre>${esc(part.replace(/\n$/, ''))}</pre>`
        : esc(part)
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>')
    )
    .join('');
}

