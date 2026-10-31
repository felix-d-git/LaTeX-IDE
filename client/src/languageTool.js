// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Grammatik/Rechtschreibung über einen selbst betriebenen LanguageTool-Server
// (LANGUAGETOOL_URL in der Server-.env; ohne Eintrag liefert /api/languagetool 501).
import { api } from './api.js';

// LaTeX-Markup als "markup" annotieren: LanguageTool prüft nur den Text,
// Offsets der Treffer beziehen sich trotzdem auf das Original.
const MARKUP_RE = new RegExp(
  [
    String.raw`(?<=(?:^|[^\\])(?:\\\\)*)%[^\n]*`, // Kommentar (gerade Zahl Backslashes davor, also auch nach \\)
    '~', // geschuetztes Leerzeichen
    String.raw`\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)`, // Mathe
    String.raw`\\(?:begin|end|label|ref|eqref|autoref|cref|Cref|pageref|cite\w*|parencite|textcite|autocite|footcite|usepackage|documentclass|includegraphics|input|include|bibliography\w*|addbibresource|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}`,
    String.raw`\\[a-zA-Z@]+\*?|\\.`, // übrige Befehle
    String.raw`[{}]`,
  ].join('|'),
  'g'
);

const REF_RE = /^\\(?:ref|eqref|autoref|cref|Cref|pageref|cite\w*|parencite|textcite|autocite|footcite)\*?[\[{]/;

// Platzhalter statt Leerstring: "siehe \ref{x}" bleibt ein Satz mit Wort, "~" ist ein Leerzeichen.
function interpretAs(m) {
  if (m === '~') return ' ';
  if (m.startsWith('\\begin') || m.startsWith('\\end')) return '\n\n';
  return REF_RE.test(m) ? 'X1' : '';
}

export function annotate(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MARKUP_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ markup: m[0], interpretAs: interpretAs(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

let disabled = false; // Server ohne LanguageTool → nicht bei jedem Tastendruck neu fragen

let failed = false; // letzter Versuch schlug fehl → genau ein Hinweis, bis es wieder klappt
let retryAt = 0;
let noProxy = false; // kein /api/languagetool-local (Web-Server) → Browser fragt direkt

// "localhost:8081" ohne Schema wäre für fetch() das URL-Schema "localhost:" → http:// ergänzen;
// eine mit eingefügte API-Endung (/v2/check, /v2) fällt weg.
export function normalizeLtUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u.replace(/^\/+/, '');
  return u.replace(/\/+$/, '').replace(/\/v2(\/check)?$/i, '').replace(/\/+$/, '');
}

// POST /v2/check, Felder als x-www-form-urlencoded (so erwartet es LanguageTool).
export function checkRequest(url, data, language) {
  return [
    normalizeLtUrl(url) + '/v2/check',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data, language }) },
  ];
}

// Eigener LanguageTool (z. B. http://localhost:8081): Desktop-App über ihren Proxy (kein CORS),
// im Web direkt aus dem Browser (LT braucht dann --allow-origin).
async function checkLocal(url, data, language) {
  url = normalizeLtUrl(url);
  if (!noProxy) {
    try {
      return await api.languageToolLocal(url, data, language);
    } catch (e) {
      if (e.status !== 404) throw e;
      noProxy = true;
    }
  }
  const [u, opts] = checkRequest(url, data, language);
  let r;
  try {
    r = await fetch(u, { ...opts, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // Der Browser verrät nicht, ob CORS, Mixed Content oder ein gestoppter Server schuld ist.
    if (e && e.name === 'TimeoutError') throw new Error('keine Antwort innerhalb von 20 s');
    throw new Error('keine Verbindung (läuft der Server? mit --allow-origin gestartet? Browser-Zugriff auf lokale Geräte erlaubt?)');
  }
  if (!r.ok) throw new Error(`LanguageTool antwortet mit ${r.status}.`);
  return r.json();
}

// Einstellungen → „Verbindung testen": ein Satz mit bekanntem Fehler.
export async function testLanguageTool(url, lang = 'de') {
  const language = lang === 'en' ? 'en-US' : 'de-DE';
  const text = lang === 'en' ? 'This is an tset.' : 'Das ist ein Tset.';
  const data = JSON.stringify({ annotation: [{ text }] });
  const { matches } = url ? await checkLocal(url, data, language) : await api.languageTool(data, language);
  return (matches || []).length;
}

function toastOnce(msg) {
  if (typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;max-width:90vw;padding:10px 14px;border-radius:6px;background:#b3261e;color:#fff;font-size:13px;box-shadow:0 2px 8px #0006;cursor:pointer';
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

// Letztes Ergebnis; veraltete Treffer werden nur behalten, solange der Text an ihrer Stelle gleich ist.
let cache = { key: '', text: '', out: [] };
let inflight = null;

// Antwortet sofort (Cache) und fragt LanguageTool im Hintergrund; onFresh() = neu linten, wenn die Antwort da ist.
let lastUrl = null;
export function grammarDiagnostics(text, prefs, onAddWord, onFresh) {
  if (prefs.ltUrl !== lastUrl) {
    // Neue Adresse: alte Sperre/Fehlermeldung gelten nicht mehr.
    lastUrl = prefs.ltUrl;
    retryAt = 0;
    failed = false;
  }
  const key = JSON.stringify([text, prefs.lang, prefs.ltUrl, prefs.dictionary]);
  if (cache.key !== key && !inflight && !(prefs.ltUrl ? false : disabled) && text.trim() && Date.now() >= retryAt) {
    inflight = fetchDiagnostics(text, prefs, onAddWord)
      .then((out) => {
        if (!out) return; // Fehler: kein Cache, nach retryAt neu versuchen
        cache = { key, text, out };
        if (onFresh) onFresh();
      })
      .finally(() => { inflight = null; });
  }
  return cache.out.filter((d) => d.to <= text.length && text.slice(d.from, d.to) === cache.text.slice(d.from, d.to));
}

async function fetchDiagnostics(text, { lang, dictionary = [], ltUrl = '' }, onAddWord) {
  let matches;
  const language = lang === 'en' ? 'en-US' : 'de-DE';
  const data = JSON.stringify({ annotation: annotate(text) });
  try {
    ({ matches } = ltUrl ? await checkLocal(ltUrl, data, language) : await api.languageTool(data, language));
    failed = false;
  } catch (e) {
    if (e.status === 501) disabled = true;
    else {
      retryAt = Date.now() + 30000; // nicht bei jedem Tastendruck neu versuchen
      if (!failed) toastOnce(ltUrl ? `LanguageTool nicht erreichbar (${ltUrl}): ${e.message}. Start mit --allow-origin '*', siehe Einstellungen → Rechtschreibung.` : `LanguageTool des Servers nicht erreichbar: ${e.message}.`);
      failed = true;
    }
    return null;
  }
  const dict = new Set(dictionary);
  const out = [];
  for (const m of matches || []) {
    const word = text.slice(m.offset, m.offset + m.length);
    const spelling = m.rule && m.rule.issueType === 'misspelling';
    if (spelling && dict.has(word)) continue;
    const actions = (m.replacements || []).slice(0, 3).map((r) => ({
      name: r.value || '∅',
      apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: r.value } }),
    }));
    if (spelling && onAddWord) actions.push({ name: 'Zum Wörterbuch', apply: () => onAddWord(word) });
    out.push({ from: m.offset, to: m.offset + m.length, severity: spelling ? 'error' : 'warning', message: m.message, source: 'LanguageTool', actions });
  }
  return out;
}
