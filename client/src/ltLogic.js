// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Reine Logik für die LanguageTool-Anzeige (#209), ohne Imports, damit testbar.

// Satzende (Satzzeichen bleibt im Satz) bzw. Trenner (Leerzeile, Struktur-Befehle; gehören zu keinem Satz).
const SEP_RE = /([.!?]+["')\]]*)(?=\s|$)|\n[ \t]*\n+|\\(?:begin|end|part|chapter|section|subsection|subsubsection|paragraph|caption)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?|\\(?:item|par)\b|\\\\/g;

// [from, to] des Satzes, der Position pos enthält (ohne umgebende Leerzeichen); leerer Satz → null.
export function sentenceRange(text, pos) {
  let start = 0;
  const bounds = [];
  for (const m of text.matchAll(SEP_RE)) {
    if (m[1]) { bounds.push([start, m.index + m[0].length]); start = m.index + m[0].length; }
    else { bounds.push([start, m.index]); start = m.index + m[0].length; }
  }
  bounds.push([start, text.length]);
  for (const [a, b] of bounds) {
    if (pos < a || pos > b) continue;
    const seg = text.slice(a, b);
    const lead = seg.length - seg.trimStart().length;
    const from = a + lead;
    const to = b - (seg.length - seg.trimEnd().length);
    return to > from ? [from, to] : null;
  }
  return null;
}

// Fehlerzähler: Meldung erst ab 2 aufeinanderfolgenden Fehlschlägen, Erfolg setzt zurück.
export const FAILS_BEFORE_ERROR = 2;
export function trackResult(fails, ok) {
  const n = ok ? 0 : fails + 1;
  return { fails: n, show: n >= FAILS_BEFORE_ERROR, justShown: n === FAILS_BEFORE_ERROR };
}

export const LT_TIMEOUT_MS = 60000;

// LanguageTool-Treffer → Lint-Diagnosen: Rechtschreibung (rot, Wort), alles andere = Grammatik/Stil
// (gelb, ganzer Satz). Wörter der persönlichen Wortliste (#213) werden nicht markiert.
export function buildDiagnostics(text, matches, dictionary = [], onAddWord) {
  const dict = new Set(dictionary);
  const out = [];
  const sentences = new Map(); // "von-bis" → gelber Satz mit allen Treffern
  for (const m of matches || []) {
    const word = text.slice(m.offset, m.offset + m.length);
    const spelling = m.rule && m.rule.issueType === 'misspelling';
    if (spelling && dict.has(word)) continue;
    const label = (r) => (spelling ? r.value || '∅' : `${word} → ${r.value || '∅'}`);
    const actions = (m.replacements || []).slice(0, 3).map((r) => ({
      name: label(r),
      apply: (view) => view.dispatch({ changes: { from: m.offset, to: m.offset + m.length, insert: r.value } }),
    }));
    if (spelling && onAddWord) actions.push({ name: 'Zum Wörterbuch', apply: () => onAddWord(word) });
    if (spelling) {
      out.push({ from: m.offset, to: m.offset + m.length, severity: 'error', markClass: 'cm-lt-spell', message: m.message, source: 'LanguageTool', actions });
      continue;
    }
    const range = sentenceRange(text, m.offset) || [m.offset, m.offset + Math.max(m.length, 1)];
    const k = range.join('-');
    const s = sentences.get(k);
    if (s) {
      s.message += '\n' + m.message;
      s.actions.push(...actions);
    } else {
      const d = { from: range[0], to: range[1], severity: 'warning', markClass: 'cm-lt-sentence', message: m.message, source: 'LanguageTool', actions };
      sentences.set(k, d);
      out.push(d);
    }
  }
  return out;
}
