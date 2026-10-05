// Heuristischer "Vermutlicher Fix" aus Fehlertext (+ Quellzeile, falls bekannt).
// ponytail: reine Regex-Tabelle, keine Syntaxanalyse; sonst leer -> keine Zeile.
const count = (s, c) => s.split(c).length - 1;
const FIXES = [
  [/Missing \} inserted|Extra \}|Runaway argument|Paragraph ended before/, (m, src) =>
    src && count(src, '{') < count(src, '}') ? 'In dieser Zeile steht wahrscheinlich eine `}` zu viel.' : 'Es fehlt wahrscheinlich eine schließende `}` (Klammern prüfen).'],
  [/Missing \{ inserted/, () => 'Es fehlt wahrscheinlich eine öffnende `{`.'],
  [/Undefined control sequence/, (m, src) => {
    const cmd = src.match(/(\\[a-zA-Z@]+)\s*$/);
    return `Befehl${cmd ? ' ' + cmd[1] : ''} unbekannt – Tippfehler oder fehlendes \\usepackage.`;
  }],
  [/Environment (\S+) undefined/, (m) => `Umgebung ${m[1]} unbekannt – Tippfehler oder Paket mit \\usepackage laden.`],
  [/\\begin\{([^}]*)\}.*ended by \\end\{([^}]*)\}/, (m) => `\\end{${m[1]}} fehlt (stattdessen steht \\end{${m[2]}}).`],
  [/Missing \$ inserted/, () => 'Mathe-Modus: Formel mit $…$ umschließen oder _ / ^ mit \\ escapen.'],
  [/File `([^']*)' not found/, (m) => `Datei/Paket ${m[1]} fehlt – Name prüfen oder Paket installieren.`],
];

export function fixHint(message, src) {
  for (const [re, f] of FIXES) {
    const m = (message || '').match(re);
    if (m) return f(m, src || '');
  }
  return '';
}
