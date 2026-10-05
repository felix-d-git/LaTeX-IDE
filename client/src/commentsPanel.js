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

// Mehrzeiliges Eingabefeld: Enter = Zeilenumbruch, Strg+Enter / Button = Absenden, Escape = Abbrechen.
function composer(initial, submitLabel, onSubmit, onCancel) {
  const box = document.createElement('div');
  box.className = 'comment-edit';
  box.addEventListener('click', (e) => e.stopPropagation());
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.value = initial;
  const send = () => ta.value.trim() && onSubmit(ta.value.trim());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    if (e.key === 'Escape') onCancel();
  });
  const row = document.createElement('div');
  row.className = 'comment-edit-actions';
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = submitLabel;
  ok.addEventListener('click', send);
  const cancel = document.createElement('button');
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', onCancel);
  row.append(cancel, ok);
  box.append(ta, row);
  setTimeout(() => ta.focus(), 0);
  return box;
}

export function setupCommentsPanel({ commentsManager, editorMgr, currentUser, getActivePath }) {
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
        edit: (text) => commentsManager.editComment(path, c.id, text),
        remove: async () => {
          await commentsManager.removeComment(path, c.id);
          editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
        },
      }));

      if (c.suggestion) {
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
          const doc = editorMgr.view.state.doc;
          const old = c.suggestion.oldText;
          const from = doc.sliceString(c.from, c.to) === old ? c.from : doc.toString().indexOf(old);
          if (from < 0) return alert('Die Textstelle wurde inzwischen geändert - Vorschlag kann nicht mehr angewendet werden.');
          editorMgr.view.dispatch({ changes: { from, to: from + old.length, insert: c.suggestion.newText } });
          await commentsManager.removeComment(path, c.id);
          editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
          renderList();
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
        const box = composer('', 'Antworten', (text) => run(commentsManager.addReply(path, c.id, text)), renderList);
        replyBtn.replaceWith(box);
      });
      item.appendChild(replyBtn);

      item.addEventListener('click', () => {
        editorMgr.jumpToRange(c.from, c.to);
      });
      list.appendChild(item);
    }
  }

  // Aenderung ausfuehren, dann neu zeichnen (Fehler per alert, wie sonst im Panel).
  async function run(promise) {
    try {
      await promise;
    } catch (e) {
      alert(e.message);
    }
    renderList();
  }

  // Eigener Beitrag, Owner/Admin oder Altbestand ohne Autor (der Server prueft verbindlich).
  function mayChange(item) {
    return currentUser.isAdmin || !item.author || item.author.id === currentUser.id;
  }

  // Autor, Zeit, Text (white-space: pre-wrap, nur textContent) + Bearbeiten/Loeschen.
  function entryBlock(item, { edit, remove }) {
    const wrap = document.createElement('div');
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const who = document.createElement('span');
    who.textContent = `${item.author ? item.author.name : 'Unbekannt'} · ${formatTime(item.createdAt)}${item.editedAt ? ' (bearbeitet)' : ''}`;
    meta.appendChild(who);
    const body = document.createElement('div');
    body.className = 'comment-text';
    body.textContent = item.text;
    if (mayChange(item)) {
      const actions = document.createElement('span');
      const ed = document.createElement('button');
      ed.textContent = 'Bearbeiten';
      ed.addEventListener('click', (e) => {
        e.stopPropagation();
        body.replaceWith(composer(item.text, 'Speichern', (text) => run(edit(text)), renderList));
        actions.remove();
      });
      const del = document.createElement('button');
      del.textContent = 'Löschen';
      del.className = 'danger';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        run(remove());
      });
      actions.append(ed, ' ', del);
      meta.appendChild(actions);
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
    pendingSelection = { path, from: sel.from, to: sel.to, text: sel.text };
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
    if (!text || !pendingSelection) return;
    const { path, from, to, text: anchorText } = pendingSelection;
    await commentsManager.addComment(path, from, to, anchorText, text);
    editorMgr.refreshCommentsForPath(path, commentsManager.getForFile(path));
    closeCompose();
    if (isOpen()) renderList();
  }

  btnToggle.addEventListener('click', toggle);
  btnClose.addEventListener('click', hide);
  btnAdd.addEventListener('click', openCompose);
  btnCancelComment.addEventListener('click', closeCompose);
  btnConfirmComment.addEventListener('click', confirmCompose);
  composeText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmCompose();
    if (e.key === 'Escape') closeCompose();
  });

  function triggerAddComment() {
    if (!isOpen()) show();
    openCompose();
  }

  return { show, hide, toggle, renderList, highlightComment, isOpen, triggerAddComment };
}
