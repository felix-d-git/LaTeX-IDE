// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const STORAGE_KEY = 'latex-ide-hotkeys-v1';

// Scopes are how duplicate bindings stay non-interfering: 'editor' combos are
// only ever looked up from inside CodeMirror's own keydown handler (which
// stopPropagation()s on a match), 'global' combos are only looked up from the
// document-level listener below. The same combo can be bound to one action of
// each scope at once without either firing the other, because only one of the
// two listeners is ever "in the room" for a given keystroke - if focus is
// inside the editor, the editor's own handler intercepts it before it can
// bubble to document; if focus is elsewhere, only the global listener sees it.
export const DEFAULT_BINDINGS = {
  compile: { label: 'Kompilieren', scope: 'global', combos: ['ctrl+enter', 'ctrl+s'] },
  toggleAllProjects: { label: 'Alle Projekte umschalten', scope: 'global', combos: ['ctrl+shift+o'] },
  toggleComments: { label: 'Kommentare umschalten', scope: 'global', combos: ['ctrl+shift+k'] },
  toggleErrors: { label: 'Fehler umschalten', scope: 'global', combos: ['ctrl+shift+e'] },
  // Strg+F gehört wieder der Suchen/Ersetzen-Leiste unten IM Editor (arbeitet
  // auf der offenen .tex-Datei). Sie ist in beiden Scopes gebunden, damit sie
  // auch greift, wenn der Fokus gerade nicht im Editor liegt.
  searchInFile: { label: 'In Datei suchen/ersetzen', scope: 'global', combos: ['ctrl+f'] },
  searchInFileEditor: { label: 'In Datei suchen/ersetzen (im Editor)', scope: 'editor', combos: ['ctrl+f'] },
  // Die projektweite Suche (Rail-Panel links) liegt dafür auf Strg+Umschalt+F.
  toggleSearch: { label: 'Projektsuche umschalten', scope: 'global', combos: ['ctrl+shift+f'] },
  toggleHistory: { label: 'Verlauf umschalten', scope: 'global', combos: ['ctrl+shift+h'] },
  closeTab: { label: 'Aktiven Tab schließen', scope: 'global', combos: ['ctrl+alt+w'] },
  // Nicht Strg+Umschalt+Pfeil: das markiert im Editor wortweise.
  nextTab: { label: 'Nächster Tab', scope: 'global', combos: ['ctrl+alt+pagedown'] },
  prevTab: { label: 'Vorheriger Tab', scope: 'global', combos: ['ctrl+alt+pageup'] },
  addComment: { label: 'Kommentar zur Auswahl hinzufügen', scope: 'editor', combos: ['ctrl+shift+m'] },
  syncToPdf: { label: 'Cursor-Position im PDF anzeigen', scope: 'editor', combos: ['ctrl+shift+j'] },
};

function loadUserBindings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveUserBindings(overrides) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

let userOverrides = loadUserBindings();
const handlers = {}; // actionId -> function

export function getEffectiveBindings() {
  const out = {};
  for (const [id, def] of Object.entries(DEFAULT_BINDINGS)) {
    out[id] = { ...def, combos: userOverrides[id] ? [...userOverrides[id]] : [...def.combos] };
  }
  return out;
}

export function setCombosForAction(actionId, combos) {
  userOverrides = { ...userOverrides, [actionId]: combos };
  saveUserBindings(userOverrides);
}

export function resetAction(actionId) {
  const next = { ...userOverrides };
  delete next[actionId];
  userOverrides = next;
  saveUserBindings(userOverrides);
}

export function resetAllBindings() {
  userOverrides = {};
  saveUserBindings(userOverrides);
}

export function registerAction(actionId, handler) {
  handlers[actionId] = handler;
}

// A combo string is normalized as "ctrl+alt+shift+meta+<key>" (only the
// modifiers actually held, in that fixed order, then the key name lowercased).
const KEY_NAME_MAP = {
  ' ': 'space',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
};

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

export function comboFromEvent(event) {
  const parts = [];
  // macOS: Cmd verhält sich wie Strg der Defaults (Cmd+S, Cmd+Enter, ...)
  if (event.ctrlKey || (IS_MAC && event.metaKey)) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey && !IS_MAC) parts.push('meta');
  const rawKey = event.key.toLowerCase();
  if (['control', 'alt', 'shift', 'meta'].includes(rawKey)) return null; // modifier alone isn't a combo
  parts.push(KEY_NAME_MAP[rawKey] || rawKey);
  return parts.join('+');
}

export function requiresModifier(combo) {
  return /(^|\+)(ctrl|alt|meta)(\+|$)/.test(combo);
}

function findAction(combo, scope) {
  const bindings = getEffectiveBindings();
  for (const [id, def] of Object.entries(bindings)) {
    if (def.scope === scope && def.combos.includes(combo)) return id;
  }
  return null;
}

// Called from CodeMirror's own domEventHandlers.keydown. Returns true if it
// matched and ran an 'editor'-scope action, so the caller can preventDefault
// + stopPropagation (stopping it from ever reaching the global listener below).
export function tryHandleEditorKey(event, view) {
  const combo = comboFromEvent(event);
  if (!combo) return false;
  const actionId = findAction(combo, 'editor');
  if (!actionId || !handlers[actionId]) return false;
  handlers[actionId](view);
  return true;
}

// Global gebundene Kombination im Editor: CodeMirrors eigene Bindung darf
// nicht zusätzlich laufen (Strg+Umschalt+K = deleteLine, Strg+Enter =
// insertBlankLine). Der Aufrufer ruft preventDefault, das Event bubbelt aber
// weiter zum globalen Listener, der die Aktion ausführt.
export function isGlobalCombo(event) {
  const combo = comboFromEvent(event);
  return !!combo && !!findAction(combo, 'global');
}

// Globale Aktionen nicht aus Dialogen, Eingabefeldern oder bei sichtbarer
// Projektübersicht/Verlaufsansicht (dort nur deren Umschalter), sonst laufen sie im
// verdeckten Editor bzw. zusätzlich zur Taste im Feld (Strg+Enter im
// Kommentarfeld). Im Editor setzt CodeMirror-Handler selbst preventDefault.
export function globalHotkeyAllowed(event, actionId, doc = document) {
  const t = event.target;
  const inEditor = !!t?.closest?.('.cm-editor');
  if (event.defaultPrevented && !inEditor) return false;
  if ([...doc.querySelectorAll('.modal-backdrop')].some((b) => b.getClientRects().length)) return false;
  if (!inEditor && t?.closest?.('input, textarea, select, [contenteditable="true"]')) return false;
  if (doc.getElementById('main')?.classList.contains('hidden')) return actionId === 'toggleAllProjects' || actionId === 'toggleHistory';
  return true;
}

let globalListenerAttached = false;

export function initGlobalHotkeys() {
  if (globalListenerAttached) return;
  globalListenerAttached = true;
  document.addEventListener('keydown', (event) => {
    const combo = comboFromEvent(event);
    if (!combo) return;
    const actionId = findAction(combo, 'global');
    if (!actionId || !handlers[actionId]) return;
    if (!globalHotkeyAllowed(event, actionId)) return;
    event.preventDefault();
    handlers[actionId](event);
  });
}
