import { snippetCompletion } from '@codemirror/autocomplete';
import { api } from './api.js';

// Data part: one entry per LaTeX command/environment. Kept separate from the
// source function below so the list can be extended without touching the
// matching logic. `from`/`to` of a completion always cover the full typed
// range INCLUDING the leading backslash (see latexCompletionSource), so every
// `label` and every snippet template here also carries its own backslash -
// otherwise Tab would insert the backslash a second time.

function cmd(name, detail, snippet, { type = 'function', boost = 0 } = {}) {
  // Overleaf zeigt rechts grau den Typ (cmd/env); die Beschreibung steht im Info-Feld.
  return snippetCompletion(snippet, { label: `\\${name}`, type, detail: 'cmd', info: detail, boost });
}

function env(name, detail, body = '\t${0}', { boost = 0 } = {}) {
  return snippetCompletion(`\\begin{\${1:${name}}}\n${body}\n\\end{\${1:${name}}}`, {
    label: `\\begin{${name}}`,
    type: 'class',
    detail: 'env',
    info: detail,
    boost,
  });
}

function symbol(name, detail) {
  return { label: `\\${name}`, type: 'constant', detail: 'cmd', info: detail };
}

const GREEK_LETTERS = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
].map((name) => symbol(name, `griechischer Buchstabe (${name})`));

const COMMANDS = [
  // Overleaf-Reihenfolge: \usepackage{}, \begin{}, \end{} ganz oben.
  cmd('usepackage', 'Paket laden', '\\usepackage{${1:paket}}', { boost: 10 }),
  cmd('begin', 'Umgebung beginnen', '\\begin{${1}}', { boost: 9 }),
  cmd('end', 'Umgebung beenden', '\\end{${1}}', { boost: 8 }),

  // Gliederung
  cmd('section', 'Abschnitt', '\\section{${1:Titel}}', { boost: 2 }),
  cmd('subsection', 'Unterabschnitt', '\\subsection{${1:Titel}}'),
  cmd('subsubsection', 'Unterunterabschnitt', '\\subsubsection{${1:Titel}}'),
  cmd('chapter', 'Kapitel', '\\chapter{${1:Titel}}'),
  cmd('paragraph', 'Paragraph', '\\paragraph{${1:Titel}}'),

  // Referenzen
  cmd('label', 'Label setzen', '\\label{${1:key}}', { boost: 3 }),
  cmd('ref', 'Referenz einfügen', '\\ref{${1:key}}', { boost: 3 }),
  cmd('pageref', 'Seitenreferenz einfügen', '\\pageref{${1:key}}'),
  cmd('cite', 'Literaturzitat einfügen', '\\cite{${1:key}}'),
  cmd('footnote', 'Fußnote einfügen', '\\footnote{${1:Text}}'),

  // Textformatierung
  cmd('textbf', 'Fett formatieren', '\\textbf{${1:Text}}', { boost: 3 }),
  cmd('textit', 'Kursiv formatieren', '\\textit{${1:Text}}'),
  cmd('underline', 'Unterstreichen', '\\underline{${1:Text}}'),
  cmd('emph', 'Hervorheben', '\\emph{${1:Text}}'),
  cmd('texttt', 'Nichtproportionalschrift', '\\texttt{${1:Text}}'),

  // Listen
  cmd('item', 'Listeneintrag', '\\item ${0}', { type: 'keyword', boost: 3 }),
  env('itemize', 'Ungeordnete Liste', '\t\\item ${0}'),
  env('enumerate', 'Geordnete Liste', '\t\\item ${0}'),
  env('description', 'Beschreibungsliste', '\t\\item[${2:Begriff}] ${0}'),

  // Mathe
  cmd('frac', 'Bruch', '\\frac{${1:Zähler}}{${2:Nenner}}'),
  cmd('sqrt', 'Wurzel', '\\sqrt{${1:x}}'),
  cmd('sum', 'Summenzeichen', '\\sum_{${1:i=1}}^{${2:n}} ${0}'),
  cmd('int', 'Integralzeichen', '\\int_{${1:a}}^{${2:b}} ${0}'),
  ...GREEK_LETTERS,
  env('equation', 'Nummerierte Gleichung', '\t${1:a} = ${2:b}'),
  env('align', 'Mehrzeilige, ausgerichtete Gleichungen', '\t${1:a} &= ${2:b}'),

  // Gleitobjekte
  env('figure', 'Abbildung (Gleitobjekt)', '\t\\centering\n\t\\includegraphics[width=${2:0.8\\textwidth}]{${3:pfad}}\n\t\\caption{${4:Beschriftung}}\n\t\\label{fig:${5:label}}'),
  env('table', 'Tabelle (Gleitobjekt)', '\t\\centering\n\t${0}\n\t\\caption{${2:Beschriftung}}\n\t\\label{tab:${3:label}}'),
  cmd('includegraphics', 'Bild einfügen', '\\includegraphics[width=${1:0.8\\textwidth}]{${2:pfad}}', { boost: 1 }),
  cmd('caption', 'Beschriftung setzen', '\\caption{${1:Text}}'),

  // Sonstiges
  cmd('newcommand', 'Neuen Befehl definieren', '\\newcommand{\\${1:name}}{${2:Definition}}'),
  cmd('documentclass', 'Dokumentklasse festlegen', '\\documentclass{${1:article}}'),
  cmd('input', 'Datei einbinden (input)', '\\input{${1:datei}}'),
  cmd('include', 'Datei einbinden (include)', '\\include{${1:datei}}'),
  env('document', 'Dokument-Umgebung', '\t${0}'),
  env('center', 'Zentrierter Inhalt', '\t${0}'),
];

// Umgebungsnamen für das Popup direkt nach "\begin{" (wie Overleaf).
const ENV_NAMES = [...new Set([
  ...COMMANDS.filter((c) => c.label.startsWith('\\begin{')).map((c) => c.label.slice(7, -1)),
  'abstract', 'tabular', 'minipage', 'verbatim', 'quote', 'array', 'gather', 'multline',
  'align*', 'equation*', 'theorem', 'proof', 'lstlisting', 'thebibliography', 'titlepage',
])];

// Labels/Bib-Keys kurz cachen, damit nicht jeder Tastendruck den Server fragt.
let refsCache = null;
let refsAt = 0;
export async function getRefs() {
  if (!refsCache || Date.now() - refsAt > 5000) {
    refsCache = await api.refs().catch(() => ({ labels: [], bibKeys: [] }));
    refsAt = Date.now();
  }
  return refsCache;
}

export const REFERENCES_KEY = 'latex-ide-references-v1';
export function referencePrefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(REFERENCES_KEY)) || {};
  } catch {}
  return { search: 'advanced', format: 'bibtex', bibFiles: [], ...p };
}

const REF_RE =/\\(ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\{[^}]*/;
const CITE_RE = /\\(cite|citep|citet|parencite|textcite|autocite|footcite|nocite)(\[[^\]]*\])*\{[^}]*/;

// Die von closeBrackets eingefügte "}" erst beim Übernehmen mitersetzen, sonst
// entsteht "}}". Nicht über result.to: CodeMirror filtert nach from..to, mit "}"
// darin passt keine Option mehr.
const closeTo = (state, to) => (state.sliceDoc(to, to + 1) === '}' ? to + 1 : to);
const eatBrace = (c) => {
  const apply = c.apply;
  return {
    ...c,
    apply: (view, completion, from, to) =>
      typeof apply === 'function'
        ? apply(view, completion, from, closeTo(view.state, to))
        : view.dispatch({
            changes: { from, to: closeTo(view.state, to), insert: apply },
            selection: { anchor: from + apply.length },
            userEvent: 'input.complete',
          }),
  };
};

async function argumentSource(context) {
  const env = context.matchBefore(/\\(begin|end)\{[a-zA-Z*]*/);
  if (env) {
    const isBegin = env.text.startsWith('\\begin');
    return {
      from: env.from + env.text.indexOf('{') + 1,
      to: env.to,
      options: ENV_NAMES.map((name) =>
        eatBrace(
          isBegin
            ? snippetCompletion(`${name}}\n\t\${0}\n\\end{${name}}`, { label: name, type: 'class', detail: 'env' })
            : { label: name, apply: `${name}}`, type: 'class', detail: 'env' }
        )
      ),
      validFor: /^[a-zA-Z*]*$/,
    };
  }
  const ref = context.matchBefore(REF_RE);
  const cite = !ref && context.matchBefore(CITE_RE);
  const m = ref || cite;
  if (!m) return null;
  // Bei \cite{a,b nur den letzten Key ersetzen.
  const from = m.from + Math.max(m.text.lastIndexOf('{'), m.text.lastIndexOf(',')) + 1;
  const { labels, bibKeys } = await getRefs();
  if (ref) return { from, to: m.to, options: labels.map((l) => ({ label: l, type: 'variable', detail: 'label' })), validFor: /^[^},]*$/ };
  // Einstellungen ▸ Literatur: nur gewählte .bib-Dateien; "erweitert" sucht auch in Titel/Autor.
  const prefs = referencePrefs();
  // Auswahl gilt global: nur Dateien zählen, die es in diesem Projekt gibt (sonst leer -> alle)
  const chosen = prefs.bibFiles.filter((f) => bibKeys.some((b) => b.file === f));
  const keys = bibKeys.filter((b) => !chosen.length || chosen.includes(b.file));
  const option = (b) => ({ label: b.key, type: 'variable', detail: (b.author || 'bib').split(/\s+and\s+/)[0], info: b.title || undefined });
  if (prefs.search !== 'advanced') return { from, to: m.to, options: keys.map(option), validFor: /^[^},]*$/ };
  const q = context.state.sliceDoc(from, m.to).toLowerCase();
  const hits = keys.filter((b) => `${b.key} ${b.title} ${b.author}`.toLowerCase().includes(q));
  return { from, to: m.to, options: hits.map(option), filter: false };
}

export function latexCompletionSource(context) {
  if (context.matchBefore(/\{[^}\\]*/)) return argumentSource(context);
  const match = context.matchBefore(/\\[a-zA-Z]*/);
  if (!match) return null;
  return {
    from: match.from,
    to: match.to,
    options: COMMANDS,
    validFor: /^\\[a-zA-Z]*$/,
  };
}
