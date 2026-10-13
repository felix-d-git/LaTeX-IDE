// P12-G: reine Client-Logik ohne Browser (LanguageTool-Annotation, Lint-Ausnahmen).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const esbuild = require('esbuild');

const load = async (file) => {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../client/src', file)], bundle: true, format: 'esm', write: false, logLevel: 'silent',
  });
  return import('data:text/javascript,' + encodeURIComponent(outputFiles[0].text));
};

test('annotate: ~ ist Leerzeichen, \\ref bleibt Wort, Kommentar-Erkennung zaehlt Backslashes', async () => {
  const { annotate } = await load('languageTool.js');
  const a = annotate(String.raw`Abb.~\ref{x} zeigt \\% Rest` + '\nNeu');
  assert.deepStrictEqual(a.find((p) => p.markup === '~'), { markup: '~', interpretAs: ' ' });
  assert.ok(a.some((p) => p.interpretAs === 'X1'));
  assert.ok(a.some((p) => p.markup && p.markup.startsWith('%'))); // nach \\ ist % ein Kommentar
  const esc = annotate(String.raw`50\% Rabatt`);
  assert.ok(!esc.some((p) => p.markup && p.markup.startsWith('%'))); // \% ist kein Kommentar
});

test('latexSyntaxDiagnostics: url/href/lstinline-Argumente werden nicht geprueft', async () => {
  const { latexSyntaxDiagnostics } = await load('latexLint.js');
  assert.deepStrictEqual(latexSyntaxDiagnostics(String.raw`\url{http://a.b/50%/{x}} ok`), []);
  assert.deepStrictEqual(latexSyntaxDiagnostics(String.raw`\href{http://a.b/%20}{Text}`), []);
  assert.deepStrictEqual(latexSyntaxDiagnostics(String.raw`\lstinline|{ % | ok`), []);
  assert.ok(latexSyntaxDiagnostics(String.raw`\textbf{offen`).length > 0);
});
