// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Visual-Modus: Parser für tabular/\newcommand/\graphicspath; wiederverwendete Dekorationen
// müssen exakt dem entsprechen, was ein frischer Neuaufbau liefert.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'bundle.mjs');
  await esbuild.build({
    stdin: {
      contents: `export * from './client/src/visualEditor.js'; export { EditorState } from '@codemirror/state';`,
      resolveDir: path.join(__dirname, '..'),
    },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: 'pdfjs', namespace: 'stub' }));
        b.onResolve({ filter: /\/api\.js$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const withPid = (u) => u; export const getDocument = () => {};' }));
      },
    }],
  });
  return import(pathToFileURL(out).href);
}

const DOC = String.raw`\documentclass{article}
\newcommand{\R}{\mathbb{R}}
\begin{document}
Normaler Text hier.
Noch eine Zeile.

\textbf{fett} und $x \in \R$ danach.
\begin{itemize}
\item Eintrag
fortgesetzte Zeile
\end{itemize}
\begin{tabular}{lc}
a & $b$ \\
\end{tabular}
\[
y = 1
\]
\end{document}
`;

test('Parser: tabular, Makros, graphicspath', async () => {
  const { _forTests: t } = await load();
  const rows = t.parseTabular('|l|*{1}{c}|r|', String.raw`\hline
a \% & $x & y$ & \textbf{c} \\ \hline
\multicolumn{2}{c}{Kopf} & 3 \\[2pt]
\bottomrule`);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0].map((c) => c.align), ['left', 'center', 'right']);
  assert.deepStrictEqual(rows[0][0].parts, [{ text: 'a %' }]);
  assert.deepStrictEqual(rows[0][1].parts, [{ math: 'x & y' }]);
  assert.deepStrictEqual(rows[0][2].parts, [{ text: 'c' }]);
  assert.strictEqual(rows[1][0].span, 2);
  assert.strictEqual(rows[1][0].align, 'center');
  assert.strictEqual(rows[1][1].align, 'right');
  assert.deepStrictEqual(t.parseTabular('p{3cm}c', 'a & b')[0].map((c) => c.align), ['left', 'center']);

  assert.deepStrictEqual(
    t.parseMacros(String.raw`\newcommand{\R}{\mathbb{R}} \renewcommand*\foo[2]{#1{#2}} \newcommand{\opt}[1][x]{#1}`),
    { '\\R': '\\mathbb{R}', '\\foo': '#1{#2}' }
  );
  assert.deepStrictEqual(t.parseGraphicspath(String.raw`\graphicspath{{bilder/}{../img/}}`), ['bilder/', '../img/']);
  assert.deepStrictEqual(t.parseGraphicspath('nichts'), []);
});

function dump(deco) {
  const out = [];
  for (const it = deco.iter(); it.value; it.next()) {
    out.push([it.from, it.to, JSON.stringify(it.value.spec.class ?? null), JSON.stringify(it.value.spec.attributes ?? null),
      it.value.spec.widget ? it.value.spec.widget.constructor.name + JSON.stringify(it.value.spec.widget) : '']);
  }
  return out;
}

test('Wiederverwendete Dekorationen = frischer Neuaufbau', async () => {
  const { visualMode, EditorState } = await load();
  const opts = { resolveImage: () => null };
  const ext = visualMode(opts);
  const field = ext[0];
  const start = (doc, anchor) => EditorState.create({ doc, selection: { anchor }, extensions: ext });
  const assertFresh = (st) => {
    const fresh = EditorState.create({ doc: st.doc, selection: st.selection, extensions: ext });
    assert.deepStrictEqual(dump(st.field(field).deco), dump(fresh.field(field).deco));
  };
  const at = (needle) => DOC.indexOf(needle);
  const step = (st, spec) => {
    const next = st.update(spec).state;
    assertFresh(next);
    return next;
  };

  // Tippen in reinem Text, am Zeilenanfang, in einer Listenzeile, Sonderzeichen, neue Zeile, Löschen, Fernänderung.
  let st = start(DOC, at('Normaler') + 3);
  const kept = st.field(field).deco;
  const moved = st.update({ selection: { anchor: at('Normaler') + 5 } }).state;
  assert.strictEqual(moved.field(field).deco, kept, 'Cursorbewegung ohne Berührung baut nicht neu');
  assertFresh(moved);

  const typed = st.update({ changes: { from: at('Normaler') + 3, insert: 'x' }, selection: { anchor: at('Normaler') + 4 } }).state;
  assert.notStrictEqual(typed.field(field).deco, kept);
  assert.strictEqual(typed.field(field).bodyFrom, st.field(field).bodyFrom);
  assertFresh(typed);

  st = step(st, { changes: { from: at('Noch'), insert: 'y' } });
  st = step(start(DOC, at('Normaler')), { changes: { from: at('fortgesetzte'), insert: 'z' } });
  st = step(start(DOC, at('fortgesetzte') + 2), { changes: { from: at('fortgesetzte') + 2, insert: 'z' } });
  st = step(start(DOC, at('Noch') + 2), { changes: { from: at('Noch') + 2, insert: '$' } });
  st = step(start(DOC, at('Noch') + 2), { changes: { from: at('Noch') + 2, insert: '\n' } });
  st = step(start(DOC, at('Noch') + 2), { changes: { from: at('Noch'), to: at('Noch') + 2 } });
  st = step(start(DOC, at('Noch') + 2), { changes: { from: at('Normaler'), to: at('Noch') + 2 } });
  // Fernänderung in einer mehrzeiligen Formel: Widget muss die neue Quelle zeigen.
  st = step(start(DOC, at('Normaler')), { changes: { from: at('y = 1'), insert: 'z' } });
  // Cursor läuft in eine Formel und wieder heraus.
  st = start(DOC, at('Normaler'));
  st = step(st, { selection: { anchor: at('x \\in') } });
  st = step(st, { selection: { anchor: at('a & $b$') } });
  step(st, { selection: { anchor: at('Normaler') } });
});

test('Tabelle wird Widget, Inhalt nicht weiter zerlegt; Kapiteldatei nutzt Makros der Hauptdatei', async () => {
  const { visualMode, EditorState } = await load();
  const ext = visualMode({ resolveImage: (raw, paths) => paths.join(',') + raw, getPreamble: () => String.raw`\newcommand{\R}{\mathbb{R}}
% \newcommand{\weg}{x}
\graphicspath{{bilder/}}` });
  const doc = String.raw`Text
\begin{tabular}{l}
$a$ \\
\end{tabular}
$\R$ \includegraphics{k}
`;
  const widgets = dump(EditorState.create({ doc, extensions: ext }).field(ext[0]).deco).map((d) => d[4]).filter(Boolean);
  assert.strictEqual(widgets.length, 3);
  assert.match(widgets[0], /^TableWidget/);
  assert.match(widgets[1], /^MathWidget.*mathbb/);
  assert.ok(!widgets[1].includes('weg'));
  assert.match(widgets[2], /^ImageWidget.*bilder\/k/);
});
