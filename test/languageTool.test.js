// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// LanguageTool-Anzeige (#209): Satzgrenzen und Fehlerzähler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../client/src/ltLogic.js'), 'utf8');
const load = () => import('data:text/javascript,' + encodeURIComponent(src));

test('sentenceRange: Satz bis Satzzeichen, ohne Leerraum', async () => {
  const { sentenceRange } = await load();
  const t = 'Erster Satz. Zweiter Satz hier! Dritter?';
  const at = (needle) => sentenceRange(t, t.indexOf(needle));
  assert.deepStrictEqual(at('Erster'), [0, 12]);
  assert.deepStrictEqual(at('hier'), [13, 31]);
  assert.deepStrictEqual(at('Dritter'), [32, 40]);
});

test('sentenceRange: Dezimalzahl trennt nicht, Leerzeile und Befehle schon', async () => {
  const { sentenceRange } = await load();
  assert.deepStrictEqual(sentenceRange('Wert 3.5 ist gut.', 6), [0, 17]);
  const p = 'Absatz eins ohne Punkt\n\nAbsatz zwei.';
  assert.deepStrictEqual(sentenceRange(p, 3), [0, 22]);
  assert.deepStrictEqual(sentenceRange(p, 30), [24, 36]);
  const e = 'Vor dem Text\n\\begin{itemize}\n\\item Eins\n\\end{itemize}';
  assert.deepStrictEqual(sentenceRange(e, 2), [0, 12]);
  assert.strictEqual(e.slice(...sentenceRange(e, e.indexOf('Eins'))), 'Eins');
});

test('sentenceRange: Position in Leerraum zwischen Trennern → null', async () => {
  const { sentenceRange } = await load();
  assert.strictEqual(sentenceRange('A.\n\n\n', 4), null);
});

test('trackResult: Meldung erst nach 2 Fehlschlägen in Folge, Erfolg setzt zurück', async () => {
  const { trackResult } = await load();
  let s = trackResult(0, false);
  assert.deepStrictEqual(s, { fails: 1, show: false, justShown: false });
  s = trackResult(s.fails, false);
  assert.deepStrictEqual(s, { fails: 2, show: true, justShown: true });
  s = trackResult(s.fails, false);
  assert.deepStrictEqual(s, { fails: 3, show: true, justShown: false });
  s = trackResult(s.fails, true);
  assert.deepStrictEqual(s, { fails: 0, show: false, justShown: false });
  s = trackResult(0, false);
  assert.strictEqual(s.show, false); // Erfolg dazwischen → wieder bei 1
});

test('Timeout 60 s an allen Stellen', async () => {
  const { LT_TIMEOUT_MS } = await load();
  assert.strictEqual(LT_TIMEOUT_MS, 60000);
  for (const f of ['../server/index.js', '../server/desktop.js']) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const i = code.indexOf("'/v2/check'");
    assert.match(code.slice(i, i + 400), /AbortSignal\.timeout\(60000\)/);
  }
});
