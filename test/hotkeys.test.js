// Globale Hotkeys (#51): im Editor verdrängen sie CodeMirrors eigene Bindung,
// aus Dialogen/Eingabefeldern/Projektübersicht laufen sie nicht.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// keybindings.js hat keine Importe → als data:-Modul laden (client/ ist kein "type": "module").
const src = fs.readFileSync(path.join(__dirname, '../client/src/keybindings.js'), 'utf8');
const load = () => import('data:text/javascript,' + encodeURIComponent(src));

// Minimal-DOM: Ziel kennt seine "Vorfahren" per Selektorliste.
const target = (...sel) => ({ closest: (q) => (q.split(',').some((s) => sel.includes(s.trim())) ? {} : null) });
const doc = ({ modal = false, dashboard = false } = {}) => ({
  querySelectorAll: () => [{ getClientRects: () => (modal ? [1] : []) }],
  getElementById: (id) => (id === 'main' ? { classList: { contains: (c) => c === 'hidden' && dashboard } } : null),
});
const key = (key, mods, tgt, defaultPrevented = false) => ({
  key, ctrlKey: mods.includes('ctrl'), altKey: mods.includes('alt'), shiftKey: mods.includes('shift'),
  metaKey: false, target: tgt, defaultPrevented,
});

test('Strg+Umschalt+K im Editor gilt als global → CodeMirror (deleteLine) läuft nicht', async () => {
  const { isGlobalCombo } = await load();
  assert.equal(isGlobalCombo(key('K', ['ctrl', 'shift'])), true);
  assert.equal(isGlobalCombo(key('Enter', ['ctrl'])), true);
  // Wortweises Markieren gehört dem Editor, nicht dem Tab-Wechsel.
  assert.equal(isGlobalCombo(key('ArrowRight', ['ctrl', 'shift'])), false);
  assert.equal(isGlobalCombo(key('PageDown', ['ctrl', 'alt'])), true);
});

test('globale Aktion: im Editor ja (trotz preventDefault), in Feldern/Dialogen/Übersicht nein', async () => {
  const { globalHotkeyAllowed } = await load();
  const ed = target('.cm-editor');
  assert.equal(globalHotkeyAllowed(key('k', ['ctrl', 'shift'], ed, true), 'toggleComments', doc()), true);
  assert.equal(globalHotkeyAllowed(key('Enter', ['ctrl'], target('textarea')), 'compile', doc()), false);
  assert.equal(globalHotkeyAllowed(key('f', ['ctrl'], target('input')), 'searchInFile', doc()), false);
  assert.equal(globalHotkeyAllowed(key('Enter', ['ctrl'], target(), true), 'compile', doc()), false);
  assert.equal(globalHotkeyAllowed(key('e', ['ctrl', 'shift'], target()), 'toggleErrors', doc({ modal: true })), false);
  assert.equal(globalHotkeyAllowed(key('f', ['ctrl'], target()), 'searchInFile', doc({ dashboard: true })), false);
  assert.equal(globalHotkeyAllowed(key('o', ['ctrl', 'shift'], target()), 'toggleAllProjects', doc({ dashboard: true })), true);
  assert.equal(globalHotkeyAllowed(key('e', ['ctrl', 'shift'], target()), 'toggleErrors', doc()), true);
});
