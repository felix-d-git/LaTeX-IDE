import { snippetCompletion } from '@codemirror/autocomplete';

// Data part: one entry per LaTeX command/environment. Kept separate from the
// source function below so the list can be extended without touching the
// matching logic. `from`/`to` of a completion always cover the full typed
// range INCLUDING the leading backslash (see latexCompletionSource), so every
// `label` and every snippet template here also carries its own backslash -
// otherwise Tab would insert the backslash a second time.

function cmd(name, detail, snippet, { type = 'function', boost = 0 } = {}) {
  return snippetCompletion(snippet, { label: `\\${name}`, type, detail, boost });
}

function env(name, detail, body = '\t${0}', { boost = 0 } = {}) {
  return snippetCompletion(`\\begin{\${1:${name}}}\n${body}\n\\end{\${1:${name}}}`, {
    label: `\\begin{${name}}`,
    type: 'class',
    detail,
    boost,
  });
}

function symbol(name, detail) {
  return { label: `\\${name}`, type: 'constant', detail };
}

const GREEK_LETTERS = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
].map((name) => symbol(name, `griechischer Buchstabe (${name})`));

const COMMANDS = [
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
  cmd('usepackage', 'Paket laden', '\\usepackage{${1:paket}}'),
  cmd('documentclass', 'Dokumentklasse festlegen', '\\documentclass{${1:article}}'),
  cmd('input', 'Datei einbinden (input)', '\\input{${1:datei}}'),
  cmd('include', 'Datei einbinden (include)', '\\include{${1:datei}}'),
  env('document', 'Dokument-Umgebung', '\t${0}'),
  env('center', 'Zentrierter Inhalt', '\t${0}'),
];

export function latexCompletionSource(context) {
  const match = context.matchBefore(/\\[a-zA-Z]*/);
  if (!match) return null;
  return {
    from: match.from,
    to: match.to,
    options: COMMANDS,
    validFor: /^\\[a-zA-Z]*$/,
  };
}
