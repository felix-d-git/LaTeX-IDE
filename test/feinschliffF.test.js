// P12-F Feinschliff Client: Hotkey-Defaults/macOS und .bib-Auswahl.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(path.join(__dirname, '../client/src/keybindings.js'), 'utf8');
const load = (tag, platform) => {
  Object.defineProperty(globalThis, 'navigator', { value: { platform }, configurable: true, writable: true });
  return import('data:text/javascript,' + encodeURIComponent(src + '\n//' + tag));
};
const ev = (key, o = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });

test('macOS: Cmd+S/Cmd+Enter lösen "kompilieren" aus, Windows: Meta bleibt eigene Taste', async () => {
  const mac = await load('mac', 'MacIntel');
  assert.equal(mac.comboFromEvent(ev('s', { metaKey: true })), 'ctrl+s');
  assert.equal(mac.comboFromEvent(ev('Enter', { metaKey: true })), 'ctrl+enter');
  const win = await load('win', 'Win32');
  assert.equal(win.comboFromEvent(ev('s', { metaKey: true })), 'meta+s');
});

test('Standard "Tab schließen" nutzt keine vom Browser reservierte Kombination', async () => {
  const { DEFAULT_BINDINGS } = await load('def', 'Win32');
  assert.ok(!DEFAULT_BINDINGS.closeTab.combos.includes('ctrl+shift+w'));
});
