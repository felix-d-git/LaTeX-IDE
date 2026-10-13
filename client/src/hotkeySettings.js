import {
  getEffectiveBindings,
  setCombosForAction,
  resetAction,
  comboFromEvent,
  requiresModifier,
} from './keybindings.js';

function comboLabel(combo) {
  return combo
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join(' + ');
}

// Feste CodeMirror-Kürzel (nicht über die Hotkey-Einstellungen änderbar).
const EDITOR_DEFAULTS = {
  Editor: [
    ['Rückgängig', 'ctrl+z'], ['Wiederholen', 'ctrl+y'], ['Alles auswählen', 'ctrl+a'],
    ['Zeile kommentieren', 'ctrl+/'],
    ['Einrücken / Ausrücken', 'tab', 'shift+tab'], ['Gehe zu Zeile', 'ctrl+alt+g'],
  ],
  Autovervollständigung: [
    ['Vorschläge öffnen', 'ctrl+space'], ['Vorschlag übernehmen', 'enter', 'tab'],
    ['Nächstes Platzhalterfeld', 'tab'], ['Schließen', 'escape'],
  ],
};

// Help > Keyboard shortcuts: read-only Übersicht, 3-spaltig mit Kbd-Pills.
export function setupShortcutsReference() {
  const modal = document.getElementById('shortcuts-dialog');
  const grid = document.getElementById('shortcuts-grid');
  document.getElementById('btn-close-shortcuts').addEventListener('click', () => modal.classList.add('hidden'));

  const kbd = (combo) => combo.split('+').map((k) => `<kbd>${comboLabel(k)}</kbd>`).join('+');
  const section = (title, rows) =>
    `<section><h4>${title}</h4>${rows
      .map(([label, ...combos]) => `<div class="shortcut-row"><span>${label}</span><span>${combos.map(kbd).join(' / ')}</span></div>`)
      .join('')}</section>`;

  function show() {
    const bindings = Object.values(getEffectiveBindings()).filter((b) => b.combos.length);
    grid.innerHTML =
      section('Allgemein', bindings.filter((b) => b.scope === 'global').map((b) => [b.label, ...b.combos])) +
      section('Editor', [...bindings.filter((b) => b.scope === 'editor').map((b) => [b.label, ...b.combos]), ...EDITOR_DEFAULTS.Editor]) +
      section('Autovervollständigung', EDITOR_DEFAULTS.Autovervollständigung);
    modal.classList.remove('hidden');
  }

  return { show };
}

export function setupHotkeySettings() {
  const modal = document.getElementById('hotkey-settings');
  const btnClose = document.getElementById('btn-close-hotkeys');
  const list = document.getElementById('hotkey-list');

  let capturingFor = null;

  function show() {
    modal.classList.remove('hidden');
    render();
  }

  function hide() {
    modal.classList.add('hidden');
    capturingFor = null;
  }

  function render() {
    const bindings = getEffectiveBindings();
    list.innerHTML = '';
    for (const [id, def] of Object.entries(bindings)) {
      const row = document.createElement('div');
      row.className = 'hotkey-row';

      const label = document.createElement('div');
      label.className = 'hotkey-label';
      label.textContent = def.label;
      const scopeTag = document.createElement('span');
      scopeTag.className = 'hotkey-scope';
      scopeTag.textContent = def.scope === 'editor' ? 'Editor' : 'Global';
      label.appendChild(scopeTag);
      row.appendChild(label);

      const combosEl = document.createElement('div');
      combosEl.className = 'hotkey-combos';
      for (const combo of def.combos) {
        const chip = document.createElement('span');
        chip.className = 'hotkey-chip';
        chip.textContent = comboLabel(combo);
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.title = 'Entfernen';
        remove.addEventListener('click', () => {
          setCombosForAction(id, def.combos.filter((c) => c !== combo));
          render();
        });
        chip.appendChild(remove);
        combosEl.appendChild(chip);
      }

      const addBtn = document.createElement('button');
      addBtn.className = 'hotkey-add';
      addBtn.dataset.actionId = id;
      addBtn.textContent = capturingFor === id ? 'Taste drücken…' : '+ Hotkey';
      addBtn.addEventListener('click', () => {
        capturingFor = id;
        render();
        // render() just replaced the whole list, so `addBtn` above is now a
        // detached node - re-query the freshly rendered button to focus it.
        list.querySelector(`.hotkey-add[data-action-id="${id}"]`)?.focus();
      });
      combosEl.appendChild(addBtn);
      row.appendChild(combosEl);

      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'Zurücksetzen';
      resetBtn.addEventListener('click', () => {
        resetAction(id);
        render();
      });
      row.appendChild(resetBtn);

      list.appendChild(row);
    }
  }

  list.addEventListener('keydown', (e) => {
    if (!capturingFor) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      capturingFor = null;
      render();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // just a bare modifier key, keep waiting
    if (!requiresModifier(combo)) {
      alert('Hotkeys benötigen mindestens eine Modifikatortaste (Strg/Alt/Cmd), damit normales Tippen nicht blockiert wird.');
      return;
    }
    const bindings = getEffectiveBindings();
    const def = bindings[capturingFor];
    const clash = Object.entries(bindings).find(([id, d]) => id !== capturingFor && d.scope === def.scope && d.combos.includes(combo));
    if (clash && !confirm(`„${combo}" ist schon „${clash[1].label}" zugeordnet. Dort entfernen und hier verwenden?`)) {
      capturingFor = null;
      render();
      return;
    }
    if (clash) setCombosForAction(clash[0], clash[1].combos.filter((c) => c !== combo));
    if (!def.combos.includes(combo)) {
      setCombosForAction(capturingFor, [...def.combos, combo]);
    }
    capturingFor = null;
    render();
  });

  btnClose.addEventListener('click', hide);

  return { show, hide };
}
