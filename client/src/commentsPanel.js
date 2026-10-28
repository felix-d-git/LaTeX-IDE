// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
function snippetOf(text, max = 80) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

// Mehrzeiliges Eingabefeld: Enter / Button = Absenden, Umschalt+Enter = Zeilenumbruch, Escape = Abbrechen.
// Entwuerfe ueberleben ein Neuzeichnen der Liste (z. B. wenn jemand anderes kommentiert).
const drafts = new Map();

function composer(initial, submitLabel, onSubmit, onCancel, draftKey) {
  const box = document.createElement('div');
  box.className = 'comment-edit';
  box.addEventListener('click', (e) => e.stopPropagation());
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = drafts.has(draftKey) ? drafts.get(draftKey) : initial;
  if (draftKey) {
    drafts.set(draftKey, ta.value);
    ta.addEventListener('input', () => drafts.set(draftKey, ta.value));
  }
  const send = () => ta.value.trim() && onSubmit(ta.value.trim());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') cancelIt();
  });
  const row = document.createElement('div');
  row.className = 'comment-edit-actions';
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = submitLabel;
  ok.addEventListener('click', send);
  const cancel = document.createElement('button');
  cancel.textContent = 'Abbrechen';
  const cancelIt = () => {
    drafts.delete(draftKey);
    onCancel();
  };
  cancel.addEventListener('click', cancelIt);
  row.append(cancel, ok);
  box.append(ta, row);
  setTimeout(() => ta.focus(), 0);
  return box;
}

export function setupCommentsPanel({ commentsManager, editorMgr, currentUser, getActivePath, getRole = () => 'owner' }) {
  const panel = document.getElementById('comments-panel');
  const fileLabel = document.getElementById('comments-file-label');
  const list = document.getElementById('comments-list');
  const btnToggle = document.getElementById('btn-comments');
  const btnClose = document.getElementById('btn-close-comments');
  const btnAdd = document.getElementById('btn-add-comment');

  const compose = document.getElementById('comment-compose');
  const composeSnippet = document.getElementById('comment-compose-snippet');
  const composeText = document.getElementById('comment-compose-text');
  const btnCancelComment = document.getElementById('btn-cancel-comment');
  const btnConfirmComment = document.getElementById('btn-confirm-comment');

  let pendingSelection = null;
  let busy = false;

  function isOpen() {
    return !panel.classList.contains('hidden');
  }

  function show() {
    panel.classList.remove('hidden');
    renderList();
  }

  function hide() {
    panel.classList.add('hidden');
  }

  function toggle() {
    if (isOpen()) hide();
    else show();
  }

  function renderList() {
    const path = getActivePath();
    fileLabel.textContent = path ? `– ${path.split('/').pop()}` : '';
    list.innerHTML = '';
    if (!path) {
      list.innerHTML = '<div class="comments-empty">Keine Datei geöffnet.</div>';
      return;
    }
    const items = commentsManager.getForFile(path);
    if (items.length === 0) {
      list.innerHTML = '<div class="comments-empty">Noch keine Kommentare in dieser Datei.</div>';
      return;
    }
    for (const c of [...items].sort((a, b) => a.from - b.from)) {
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.dataset.commentId = c.id;

      const quote = document.createElement('div');
      quote.className = 'comment-quote';
      quote.textContent = snippetOf(c.anchorText || '');
      item.appendChild(quote);

      item.appendChild(entryBlock(c, {
        key: 'edit:' + c.id,
        edit: (text) => commentsManager.editComment(path, c.id, text),
        remove: async () => {
          await commentsManager.removeComment(path, c.id);
          editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
        },
      }));

      if (c.suggestion && !editorMgr.view.state.readOnly) {
        // Change proposed by an external AI tool (MCP review token): nothing is applied until accepted here.
        const diff = document.createElement('div');
        diff.className = 'comment-text';
        diff.textContent = `Vorschlag: „${snippetOf(c.suggestion.oldText, 120)}“ → „${snippetOf(c.suggestion.newText, 120)}“`;
        item.appendChild(diff);
        const bar = document.createElement('div');
        bar.className = 'comment-meta';
        const accept = document.createElement('button');
        accept.textContent = 'Annehmen';
        accept.className = 'primary';
        accept.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (accept.disabled) return;
          accept.disabled = true;
          try {
            // Aktuelle Position ueber den Anker, kein Suchen im ganzen Dokument.
            const cur = commentsManager.getForFile(path).find((x) => x.id === c.id);
            const old = c.suggestion.oldText;
            const doc = editorMgr.view.state.doc;
            if (!cur || cur.to > doc.length || doc.sliceString(cur.from, cur.to) !== old) {
              alert('Die Textstelle wurde inzwischen geändert - Vorschlag kann nicht mehr angewendet werden.');
              return;
            }
            // Erst Kommentar entfernen (Server prueft die Berechtigung), dann Text aendern.
            await commentsManager.removeComment(path, c.id);
            editorMgr.view.dispatch({ changes: { from: cur.from, to: cur.to, insert: c.suggestion.newText } });
            editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
          } catch (err) {
            alert(err.message);
          } finally {
            renderList();
          }
        });
        const reject = document.createElement('button');
        reject.textContent = 'Ablehnen';
        reject.className = 'danger';
        reject.addEventListener('click', async (e) => {
          e.stopPropagation();
          await commentsManager.removeComment(path, c.id);
          editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
          renderList();
        });
        bar.append(accept, ' ', reject);
        item.appendChild(bar);
      }

      for (const r of c.replies || []) {
        const rb = entryBlock(r, {
          key: 'edit:' + c.id + ':' + r.id,
          edit: (text) => commentsManager.editReply(path, c.id, r.id, text),
          remove: () => commentsManager.removeReply(path, c.id, r.id),
        });
        rb.classList.add('comment-reply');
        item.appendChild(rb);
      }

      const replyBtn = document.createElement('button');
      replyBtn.className = 'comment-reply-btn';
      replyBtn.textContent = 'Antworten';
      replyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        replyBtn.replaceWith(replyBox());
      });
      const replyKey = 'reply:' + c.id;
      const replyBox = () => composer('', 'Antworten', (text) => run(commentsManager.addReply(path, c.id, text), replyKey), renderList, replyKey);
      item.appendChild(drafts.has(replyKey) ? replyBox() : replyBtn);

      item.addEventListener('click', () => {
        const cur = commentsManager.getForFile(path).find((x) => x.id === c.id) || c;
        const len = editorMgr.view.state.doc.length;
        editorMgr.jumpToRange(Math.min(cur.from, len), Math.min(cur.to, len));
      });
      list.appendChild(item);
    }
  }

  // Aenderung ausfuehren, dann neu zeichnen (Fehler per alert, wie sonst im Panel).
  async function run(promise, draftKey) {
    try {
      await promise;
      drafts.delete(draftKey);
    } catch (e) {
      alert(e.message);
    }
    renderList();
  }

  // Eigener Beitrag, Owner/Admin oder Altbestand ohne Autor (der Server prueft verbindlich).
  // Server: Bearbeiten nur Autor/Verwalter, Loeschen zusaetzlich bei Altbestand ohne Autor.
  function mayChange(item, forDelete) {
    return currentUser.isAdmin || getRole() === 'owner' || (item.author ? item.author.id === currentUser.id : !!forDelete);
  }

  // Autor, Zeit, Text (white-space: pre-wrap, nur textContent) + Bearbeiten/Loeschen.
  function entryBlock(item, { key, edit, remove }) {
    const wrap = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const who = document.createElement('span');
    who.textContent = `${item.author ? item.author.name : 'Unbekannt'} · ${formatTime(item.createdAt)}${item.editedAt ? ' (bearbeitet)' : ''}`;
    meta.appendChild(who);
    const body = document.createElement('div');
    body.className = 'comment-text';
    body.textContent = item.text;
    if (mayChange(item, true)) {
      const actions = document.createElement('span');
      const ed = document.createElement('button');
      ed.textContent = 'Bearbeiten';
      const openEdit = () => {
        body.replaceWith(composer(item.text, 'Speichern', (text) => run(edit(text), key), renderList, key));
        actions.remove();
      };
      ed.addEventListener('click', (e) => {
        e.stopPropagation();
        openEdit();
      });
      const del = document.createElement('button');
      del.textContent = 'Löschen';
      del.className = 'danger';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        run(remove());
      });
      if (mayChange(item)) actions.append(ed, ' ');
      actions.append(del);
      meta.appendChild(actions);
      wrap.append(meta, body);
      if (drafts.has(key) && mayChange(item)) openEdit();
      return wrap;
    }
    wrap.append(meta, body);
    return wrap;
  }

  function highlightComment(id) {
    if (!isOpen()) show();
    renderList();
    const node = list.querySelector(`[data-comment-id="${id}"]`);
    if (!node) return;
    node.classList.add('highlighted');
    node.scrollIntoView({ block: 'nearest' });
    setTimeout(() => node.classList.remove('highlighted'), 1500);
  }

  function openCompose() {
    const path = getActivePath();
    if (!path) {
      alert('Bitte zuerst eine Datei öffnen.');
      return;
    }
    const sel = editorMgr.getSelection();
    if (sel.from === sel.to) {
      alert('Bitte zuerst Text im Editor markieren, zu dem ein Kommentar hinzugefügt werden soll.');
      return;
    }
    pendingSelection = { path, from: sel.from, to: sel.to, text: sel.text, cap: commentsManager.captureRange(path, sel.from, sel.to) };
    composeSnippet.textContent = '„' + snippetOf(sel.text) + '“';
    composeText.value = '';
    compose.classList.remove('hidden');
    composeText.focus();
  }

  function closeCompose() {
    compose.classList.add('hidden');
    pendingSelection = null;
  }

  async function confirmCompose() {
    const text = composeText.value.trim();
    if (!text || !pendingSelection || busy) return;
    const { path, cap, text: anchorText } = pendingSelection;
    busy = true;
    btnConfirmComment.disabled = true;
    try {
      const r = commentsManager.resolveRange(path, cap, { from: pendingSelection.from, to: pendingSelection.to });
      if (!r) {
        alert('Der markierte Text wurde inzwischen gelöscht.');
        return;
      }
      await commentsManager.addComment(path, r.from, r.to, anchorText, text);
      editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
      closeCompose();
      if (isOpen()) renderList();
    } catch (e) {
      alert(e.message); // Dialog und Text bleiben erhalten
    } finally {
      busy = false;
      btnConfirmComment.disabled = false;
    }
  }

  btnToggle.addEventListener('click', toggle);
  btnClose.addEventListener('click', hide);
  btnAdd.addEventListener('click', openCompose);
  btnCancelComment.addEventListener('click', closeCompose);
  btnConfirmComment.addEventListener('click', confirmCompose);
  composeText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); confirmCompose(); }
    if (e.key === 'Escape') closeCompose();
  });

  function triggerAddComment() {
    if (!isOpen()) show();
    openCompose();
  }

  return { show, hide, toggle, renderList, highlightComment, isOpen, triggerAddComment };
}
