import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateField, StateEffect, Annotation, Prec } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { indentWithTab } from '@codemirror/commands';
import { acceptCompletion, nextSnippetField, hasNextSnippetField } from '@codemirror/autocomplete';
import { search, openSearchPanel } from '@codemirror/search';
import { commentField, setCommentsEffect } from './comments.js';
import { trackChangesField } from './trackChanges.js';
import { tryHandleEditorKey } from './keybindings.js';
import { latexCompletionSource } from './latexCompletions.js';

const externalUpdate = Annotation.define();

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

export function createEditorManager(container, { onSave, onDirtyChange, onCommentClick, getInitialComments, onTrackChangeClick, onDocChanged, onSelectionChanged }) {
  const tabs = new Map(); // path -> { state, dirty }
  let activePath = null;
  let saveTimer = null;

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

  function buildState(content, path) {
    const initialComments = getInitialComments ? getInitialComments(path) : [];
    return EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
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
        }),
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
              return false;
            },
          })
        ),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          // Cursorbewegung ohne Textänderung: nur die Gliederung mitführen
          // (R4 - genau eine Zeile trägt die Hervorhebung).
          if (update.selectionSet && onSelectionChanged) onSelectionChanged();
          if (!update.docChanged) return;
          onDocChanged && onDocChanged(path);
          const isExternal = update.transactions.some((t) => t.annotation(externalUpdate));
          if (isExternal) return;
          const tab = tabs.get(path);
          if (tab) tab.dirty = true;
          onDirtyChange && onDirtyChange(path, true);
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const content = view.state.doc.toString();
            onSave(path, content).then(() => {
              const t = tabs.get(path);
              if (t) t.dirty = false;
              onDirtyChange && onDirtyChange(path, false);
            });
          }, 600);
        }),
      ],
    });
  }

  function openFile(path, content) {
    if (activePath && tabs.has(activePath)) {
      tabs.get(activePath).state = view.state;
    }
    if (!tabs.has(path)) {
      tabs.set(path, { state: buildState(content, path), dirty: false });
    }
    activePath = path;
    view.setState(tabs.get(path).state);
    view.focus();
  }

  function closeTab(path) {
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

  function applyExternalChange(path, content, changedRanges) {
    if (path === activePath) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: externalUpdate.of(true),
      });
      flashRanges(changedRanges);
      tabs.get(path).state = view.state;
      tabs.get(path).dirty = false;
      onDirtyChange && onDirtyChange(path, false);
    } else if (tabs.has(path)) {
      // Not the active tab: drop cached state so reopening fetches fresh content.
      tabs.delete(path);
    }
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

  function isDirty(path) {
    return tabs.has(path) ? tabs.get(path).dirty : false;
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
    view,
  };
}
