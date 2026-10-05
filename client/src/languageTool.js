// Grammatik/Rechtschreibung über einen selbst betriebenen LanguageTool-Server
// (LANGUAGETOOL_URL in der Server-.env; ohne Eintrag liefert /api/languagetool 501).
import { api } from './api.js';

// LaTeX-Markup als "markup" annotieren: LanguageTool prüft nur den Text,
// Offsets der Treffer beziehen sich trotzdem auf das Original.
const MARKUP_RE = new RegExp(
  [
    String.raw`(?<!\\)%[^\n]*`, // Kommentar
    String.raw`\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)`, // Mathe
    String.raw`\\(?:begin|end|label|ref|eqref|autoref|cref|Cref|pageref|cite\w*|parencite|textcite|autocite|footcite|usepackage|documentclass|includegraphics|input|include|bibliography\w*|addbibresource|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}`,
    String.raw`\\[a-zA-Z@]+\*?|\\.`, // übrige Befehle
    String.raw`[{}]`,
  ].join('|'),
  'g'
);

export function annotate(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MARKUP_RE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ markup: m[0], interpretAs: m[0].startsWith('\\begin') || m[0].startsWith('\\end') ? '\n\n' : '' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

let disabled = false; // Server ohne LanguageTool → nicht bei jedem Tastendruck neu fragen

let warned = false; // Hinweis „eigener LanguageTool nicht erreichbar“ nur einmal pro Sitzung

function warnOnce(url) {
  if (warned) return;
  warned = true;
  const d = document.createElement('div');
  d.textContent = `LanguageTool unter ${url} nicht erreichbar (läuft er mit --allow-origin '*'?). Grammatikprüfung pausiert.`;
  d.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;max-width:80vw;padding:8px 14px;border-radius:6px;background:#333;color:#fff;font-size:13px;opacity:.92;cursor:pointer';
  d.addEventListener('click', () => d.remove());
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 10000);
}

export async function grammarDiagnostics(text, { lang, dictionary = [], ltUrl = '' }, onAddWord) {
  const local = (ltUrl || '').trim().replace(/\/+$/, ''); // eigener Rechner: direkt aus dem Browser
  if ((disabled && !local) || !text.trim()) return [];
  const language = lang === 'en' ? 'en-US' : 'de-DE';
  const data = JSON.stringify({ annotation: annotate(text) });
  let matches;
  try {
    if (local) {
      const r = await fetch(local + '/v2/check', { method: 'POST', body: new URLSearchParams({ data, language }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`LanguageTool antwortet mit ${r.status}.`);
      ({ matches } = await r.json());
    } else {
      ({ matches } = await api.languageTool(data, language));
    }
  } catch (e) {
    if (local) warnOnce(local);
    else if (e.status === 501) disabled = true;
    return [];
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
