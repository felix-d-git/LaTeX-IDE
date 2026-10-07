// Live-Syntaxprüfung beim Tippen (ohne Kompilieren): Klammern {} und \begin/\end.
// ponytail: zeichenweiser Scan, kennt nur Kommentare, \verb und verbatim-artige Umgebungen;
// \iffalse-Blöcke, catcode-Tricks oder Makros mit unbalancierten Argumenten melden ggf. falsch.
const VERBATIM = /^(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|filecontents\*?)$/;

export function latexSyntaxDiagnostics(text) {
  const out = [];
  const braces = []; // Positionen offener {
  const envs = []; // { name, from, to }
  const err = (from, to, message) => out.push({ from, to, severity: 'error', message, source: 'Syntax' });
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === '%') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '\\') {
      const m = /^\\(begin|end)\s*\{([^}\n]*)\}/.exec(text.slice(i, i + 80));
      if (m) {
        const [whole, kind, name] = m;
        const to = i + whole.length;
        if (kind === 'begin') {
          if (VERBATIM.test(name)) {
            const end = text.indexOf(`\\end{${name}}`, to);
            if (end === -1) err(i, to, `\\begin{${name}} ohne \\end{${name}}`);
            i = end === -1 ? n : end + `\\end{${name}}`.length - 1;
            continue;
          }
          envs.push({ name, from: i, to });
        } else {
          const top = envs[envs.length - 1];
          if (!top) err(i, to, `\\end{${name}} ohne passendes \\begin`);
          else if (top.name !== name) {
            err(i, to, `\\end{${name}} schließt \\begin{${top.name}}`);
            if (envs.some((e) => e.name === name)) while (envs.length && envs.pop().name !== name);
          } else envs.pop();
        }
        i = to - 1;
      } else if (text.startsWith('\\verb', i) && /[^a-zA-Z]/.test(text[i + 5] || '')) {
        const d = text[i + 5] === '*' ? i + 6 : i + 5; // \verb*|…|
        const close = text.indexOf(text[d], d + 1);
        i = close === -1 ? d : close;
      } else i++; // \{ \} \% usw. überspringen
    } else if (c === '{') braces.push(i);
    else if (c === '}') {
      if (braces.length) braces.pop();
      else err(i, i + 1, '`}` ohne öffnende `{`');
    }
  }
  for (const p of braces) err(p, p + 1, '`{` wird nicht geschlossen');
  for (const e of envs) err(e.from, e.to, `\\begin{${e.name}} ohne \\end{${e.name}}`);
  return out;
}

// Selbsttest (package.json ist CommonJS): als .mjs kopieren und mit node starten
if (typeof process !== 'undefined' && /latexLint\.mjs$/.test(process.argv?.[1] || '')) {
  const msgs = (t) => latexSyntaxDiagnostics(t).map((d) => d.message);
  const assert = (ok, what) => { if (!ok) { console.error('FAIL', what); process.exit(1); } };
  assert(msgs('\\begin{a}\\textbf{x}\\end{a} % {').length === 0, 'sauber');
  assert(msgs('\\section{x').join() === '`{` wird nicht geschlossen', 'offene {');
  assert(msgs('x}').join() === '`}` ohne öffnende `{`', 'extra }');
  assert(msgs('\\begin{itemize}\n\\item a').join() === '\\begin{itemize} ohne \\end{itemize}', 'kein end');
  assert(msgs('\\begin{a}\\begin{b}\\end{a}').length === 1, 'falsch verschachtelt');
  assert(msgs('\\begin{verbatim}{ \\begin{x}\\end{verbatim}\\verb|}| \\verb*|{| \\{').length === 0, 'verbatim');
  console.log('latexLint OK');
}
