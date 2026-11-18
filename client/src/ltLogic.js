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
