import { EditorView } from 'codemirror';
import {
  lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine,
} from '@codemirror/view';
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language';
import { defaultKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { getSession, closeSession, listConflicts, conflictField, setConflictsEffect } from './collab.js';
import { EditorState, StateField, StateEffect, Prec, Compartment } from '@codemirror/state';
import { visualMode } from './visualEditor.js';
import { Decoration, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { indentWithTab } from '@codemirror/commands';
import { acceptCompletion, nextSnippetField, hasNextSnippetField } from '@codemirror/autocomplete';
import { search, openSearchPanel } from '@codemirror/search';
import { commentField, setCommentsEffect } from './comments.js';
import { trackChangesField } from './trackChanges.js';
import { tryHandleEditorKey, isGlobalAction } from './keybindings.js';
import { latexCompletionSource } from './latexCompletions.js';

const addFlash = StateEffect.define();
const clearFlash = StateEffect.define();

const flashField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash)) deco = deco.update({ add: e.value, sort: true });
      if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const stexLanguage = StreamLanguage.define(stex);

// codemirror's basicSetup minus history(): undo/redo come from the Yjs
// UndoManager, which only reverts your own edits, never a collaborator's.
const basicSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...yUndoManagerKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

// R5: Editorfläche nach den gemessenen Werten — 12px/19.2px Monospace,
// Zeilen-Padding 0 2px 0 6px, Gutter im Systemgrau statt CodeMirrors
// Fremdton (#f0f0f0/#dcdcdc werden laut R10 bewusst NICHT übernommen),
// "scroll past end" als 50vh statt der gemessenen Konstante 626.806px.
const overleafTheme = EditorView.theme(
  {
    '&': { fontSize: '12px', backgroundColor: 'var(--ol-surface)', color: 'var(--ol-text)' },
    '.cm-scroller': {
      lineHeight: '19.2px',
      fontFamily: 'var(--ol-font-mono)',
    },
    '.cm-content': { padding: '4px 0 50vh' },
    '.cm-line': { padding: '0 2px 0 6px' },
    '.cm-gutters': {
      backgroundColor: 'var(--ol-gutter-bg)',
      color: 'var(--ol-gutter-fg)',
      border: 'none',
      fontSize: '12px',
      lineHeight: '19.2px',
    },
    '.cm-activeLine': { backgroundColor: 'var(--ol-active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--ol-active-gutter)', minWidth: '20px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '1.8px', borderLeftColor: 'var(--ol-text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--ol-selection)',
    },
    '.cm-panels': { backgroundColor: 'var(--ol-surface-alt)', color: 'var(--ol-text)' },
    '.cm-tooltip': {
      border: '0',
      borderRadius: '4px',
      backgroundColor: 'var(--ol-surface)',
      boxShadow: 'var(--ol-shadow)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--ol-accent-bg)',
      color: 'var(--ol-accent-fg)',
    },
  },
  { dark: false }
);

export function createEditorManager(container, { onCommentClick, getInitialComments, onTrackChangeClick, onDocChanged, onSelectionChanged, onDropImages, resolveImage }) {
  const tabs = new Map(); // path -> { state }
  const visualComp = new Compartment();
  let visualOn = false;
  try {
    visualOn = localStorage.getItem('editorMode') === 'visual';
  } catch {}
  const visualExt = () => (visualOn ? visualMode({ resolveImage: resolveImage || (() => null) }) : []);
  const IMAGE_RE = /\.(png|jpe?g|pdf|eps)$/i;
  let activePath = null;

  const view = new EditorView({
    parent: container,
    state: emptyState(),
  });

  function emptyState() {
    return EditorState.create({
      doc: '% Datei aus dem Dateibaum links öffnen…',
      extensions: [overleafTheme],
    });
  }

  // Text lives in the file's Y.Doc (collab.js); the editor state is a view on it.
  function buildState(path) {
    const session = getSession(path);
    const initialComments = getInitialComments ? getInitialComments(path) : [];
    return EditorState.create({
      doc: session.ytext.toString(),
      extensions: [
        basicSetup,
        yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
        conflictField,
        overleafTheme,
        // Suchen/Ersetzen-Leiste am unteren Rand des Editors (Strg+F), arbeitet
        // auf der gerade offenen Datei - die Projektsuche in der Rail sucht
        // dagegen dateiübergreifend und kann nicht ersetzen.
        search({ top: false }),
        // basicSetup's bundled completionKeymap only binds Enter to accept a
        // suggestion, not Tab - so this adds Tab-to-accept plus tab-stop
        // cycling through synced snippet fields (e.g. \begin{name}/\end{name}).
        // Chained explicitly in one command (rather than relying on merge
        // order between separate keymap.of() extensions) so behavior doesn't
        // depend on CM6's internal Prec.highest ordering of its own snippet
        // keymap: acceptCompletion/nextSnippetField each return false when
        // inapplicable, falling through to plain indentWithTab.
        Prec.highest(
          keymap.of([
            {
              key: 'Tab',
              run: (view) => acceptCompletion(view) || (hasNextSnippetField(view.state) && nextSnippetField(view)),
            },
          ])
        ),
        keymap.of([indentWithTab]),
        stexLanguage,
        stexLanguage.data.of({ autocomplete: latexCompletionSource }),
        flashField,
        commentField(initialComments),
        trackChangesField,
        EditorView.domEventHandlers({
          mousedown(event) {
            const commentTarget = event.target.closest && event.target.closest('[data-comment-id]');
            if (commentTarget && onCommentClick) onCommentClick(commentTarget.dataset.commentId);
            const tcTarget = event.target.closest && event.target.closest('[data-tc-id]');
            if (tcTarget && onTrackChangeClick) onTrackChangeClick(tcTarget.dataset.tcId);
          },
          // Bilder aus dem Explorer in den Editor ziehen → Upload + figure-Umgebung.
          dragover(event) {
            if (!onDropImages || !event.dataTransfer?.types.includes('Files')) return false;
            event.preventDefault();
            return true;
          },
          drop(event, v) {
            const files = [...(event.dataTransfer?.files || [])].filter((f) => IMAGE_RE.test(f.name));
            if (!onDropImages || !files.length) return false;
            event.preventDefault();
            // precise=false: liefert auch unterhalb der letzten Zeile eine Position statt null.
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY }, false);
            onDropImages(files, pos);
            return true;
          },
        }),
        visualComp.of(visualExt()),
        // Highest precedence so user-configured editor hotkeys win over
        // basicSetup's bundled default bindings (e.g. lintKeymap's own
        // Mod-Shift-m, defaultKeymap's Mod-Shift-k) when the two collide.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, editorView) {
              if (tryHandleEditorKey(event, editorView)) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              // Kompilieren ist global gebunden: CM-Keymaps nicht laufen lassen
              // (sonst fügt Mod-Enter eine Leerzeile ein), Event bubbelt aber
              // weiter zum globalen Listener, der kompiliert.
              if (isGlobalAction(event, 'compile')) {
                event.preventDefault();
                return true;
              }
              return false;
            },
          })
        ),
        EditorView.lineWrapping,
        // Overleaf: ein getipptes "\" ist ein eigener Undo-Schritt, damit
        // Undo "\" und den folgenden Befehlsnamen getrennt zurücknimmt.
        EditorView.inputHandler.of((v, from, to, text) => {
          if (text === '\\') session.undoManager.stopCapturing();
          return false;
        }),
        EditorView.updateListener.of((update) => {
          // Cursorbewegung ohne Textänderung: nur die Gliederung mitführen
          // (R4 - genau eine Zeile trägt die Hervorhebung).
          if (update.selectionSet && onSelectionChanged) onSelectionChanged();
          if (!update.docChanged) return;
          onDocChanged && onDocChanged(path);
        }),
      ],
    });
  }

  // Requires an open collab session for path (collab.openSession).
  function openFile(path) {
    if (activePath && tabs.has(activePath)) {
      tabs.get(activePath).state = view.state;
    }
    const session = getSession(path);
    const cached = tabs.get(path);
    // An inactive tab's state doesn't receive remote edits (the sync plugin
    // only runs in the view) - rebuild it if the shared text moved on.
    if (!cached || cached.state.doc.toString() !== session.ytext.toString()) {
      tabs.set(path, { state: buildState(path) });
    }
    activePath = path;
    view.setState(tabs.get(path).state);
    refreshConflicts(path);
    view.focus();
  }

  function refreshConflicts(path) {
    if (path === activePath && getSession(path)) view.dispatch({ effects: setConflictsEffect.of(listConflicts(path)) });
  }

  function closeTab(path) {
    closeSession(path);
    tabs.delete(path);
    if (activePath === path) {
      activePath = null;
      view.setState(emptyState());
    }
  }

  function getActivePath() {
    return activePath;
  }

  function isOpen(path) {
    return tabs.has(path);
  }

  // Text changed outside the editor (search/replace, external tool): the
  // content itself arrives via Yjs, here we only flash the changed lines.
  function applyExternalChange(path, content, changedRanges) {
    if (path === activePath) setTimeout(() => flashRanges(changedRanges), 300);
  }

  function flashRanges(changedRanges) {
    if (!changedRanges || !changedRanges.length) return;
    const marks = [];
    const doc = view.state.doc;
    for (const r of changedRanges) {
      const fromLineNo = Math.min(r.fromLine + 1, doc.lines);
      const toLineNo = Math.min(Math.max(r.toLine, r.fromLine + 1), doc.lines);
      for (let ln = fromLineNo; ln <= toLineNo; ln++) {
        const line = doc.line(ln);
        marks.push(Decoration.line({ attributes: { class: 'flash-line' } }).range(line.from));
      }
    }
    if (marks.length) view.dispatch({ effects: addFlash.of(marks) });
    setTimeout(() => view.dispatch({ effects: clearFlash.of(null) }), 3000);
  }

  function getTabs() {
    return [...tabs.keys()];
  }

  function isDirty() {
    return false; // saved continuously via Yjs
  }

  // Öffnet CodeMirrors Suchen/Ersetzen-Leiste unten im Editor (Strg+F,
  // Menü Edit > Find, Lupe in der Formatierungsleiste).
  function openSearch() {
    openSearchPanel(view);
    const input = view.dom.querySelector('.cm-search input[name="search"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function getSelection() {
    const sel = view.state.selection.main;
    return { from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) };
  }

  function jumpToRange(from, to) {
    view.dispatch({ selection: { anchor: from, head: to ?? from }, scrollIntoView: true });
    view.focus();
  }

  // Applied directly to the DOM (not baked into EditorState/extensions),
  // so one call affects every tab immediately - the view/container element
  // is shared across tabs, only its EditorState is swapped on tab switch.
  function setFontSettings({ fontSize, fontFamily, lineHeight }) {
    if (fontSize) view.dom.style.fontSize = fontSize;
    if (lineHeight) view.dom.style.lineHeight = lineHeight;
    const scroller = view.dom.querySelector('.cm-scroller');
    if (fontFamily && scroller) scroller.style.fontFamily = fontFamily;
  }

  // Code/Visual umschalten: aktive Ansicht + alle gecachten Tab-States.
  function setVisual(on) {
    visualOn = !!on;
    try {
      localStorage.setItem('editorMode', visualOn ? 'visual' : 'code');
    } catch {}
    const effects = visualComp.reconfigure(visualExt());
    if (activePath) view.dispatch({ effects });
    for (const [p, t] of tabs) if (p !== activePath) t.state = t.state.update({ effects }).state;
  }

  function isVisual() {
    return visualOn;
  }

  function setSpellcheck({ enabled, lang }) {
    view.contentDOM.spellcheck = !!enabled;
    if (lang) view.contentDOM.lang = lang;
  }

  function refreshCommentsForPath(path, list) {
    if (path === activePath) {
      view.dispatch({ effects: setCommentsEffect.of(list) });
    } else if (tabs.has(path)) {
      // Not the active tab: drop cached state so reopening reseeds decorations from disk.
      tabs.delete(path);
    }
  }

  return {
    openFile,
    refreshConflicts,
    closeTab,
    getActivePath,
    isOpen,
    applyExternalChange,
    getTabs,
    isDirty,
    getSelection,
    openSearch,
    jumpToRange,
    refreshCommentsForPath,
    setFontSettings,
    setSpellcheck,
    setVisual,
    isVisual,
    view,
  };
}
