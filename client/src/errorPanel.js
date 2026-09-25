// R1/R6: Die Log-/Fehleransicht ist ein volldeckendes Overlay der PDF-Spalte
// (z-index 11), kein eigener Bereich unter dem Editor und kein schwebendes
// Panel. Der Fehlerzähler sitzt als rotes Badge auf dem "View logs"-Button
// der PDF-Toolbar.
export function setupErrorPanel({ onJumpTo, getFileLines }) {
  const panel = document.getElementById('log-panel');
  const btnToggle = document.getElementById('btn-errors');
  const btnClose = document.getElementById('btn-close-errors');
  const blocksEl = document.getElementById('error-blocks');
  const emptyEl = document.getElementById('error-panel-empty');
  const badgeEl = document.getElementById('error-badge');

  const contextView = document.getElementById('error-context-view');
  const contextTitle = document.getElementById('error-context-title');
  const contextCode = document.getElementById('error-context-code');
  const btnCloseContext = document.getElementById('btn-close-error-context');

  let currentErrors = [];

  function isOpen() {
    return !panel.classList.contains('hidden');
  }

  function show() {
    closeContext(); // list and context view occupy the same screen area - never both at once
    panel.classList.remove('hidden');
  }

  function hide() {
    panel.classList.add('hidden');
    closeContext();
  }

  function toggle() {
    if (isOpen()) hide();
    else show();
  }

  function setErrors(errors) {
    currentErrors = errors || [];
    badgeEl.textContent = String(currentErrors.length);
    badgeEl.classList.toggle('hidden', currentErrors.length === 0);
    btnToggle.classList.toggle('has-errors', currentErrors.length > 0);
    renderBlocks();
  }

  function renderBlocks() {
    blocksEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', currentErrors.length > 0);

    const byFile = new Map();
    for (const e of currentErrors) {
      const key = e.file || '(Datei unbekannt)';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(e);
    }

    for (const [file, items] of byFile) {
      const block = document.createElement('div');
      block.className = 'error-block';

      const header = document.createElement('div');
      header.className = 'error-block-file';
      header.textContent = `${file} (${items.length})`;
      block.appendChild(header);

      for (const e of items) {
        const row = document.createElement('div');
        row.className = 'error-row';
        row.textContent = e.line ? `Zeile ${e.line}: ${e.message}` : e.message;
        if (e.file && e.line) row.addEventListener('click', () => selectError(e));
        else row.classList.add('error-row-noloc');
        block.appendChild(row);
      }
      blocksEl.appendChild(block);
    }
  }

  async function selectError(e) {
    onJumpTo(e.file, e.line);
    panel.classList.add('hidden'); // don't overlap the context view's "back" button
    await showContext(e.file, e.line);
  }

  async function showContext(file, line) {
    const lines = await getFileLines(file);
    if (!lines) return;
    const from = Math.max(1, line - 6);
    const to = Math.min(lines.length, line + 6);
    contextTitle.textContent = `${file} – Zeile ${line}`;
    contextCode.innerHTML = '';
    for (let ln = from; ln <= to; ln++) {
      const row = document.createElement('div');
      row.className = 'error-context-line' + (ln === line ? ' is-error-line' : '');
      const num = document.createElement('span');
      num.className = 'ln';
      num.textContent = String(ln);
      const text = document.createElement('span');
      text.className = 'code';
      text.textContent = lines[ln - 1] ?? '';
      row.appendChild(num);
      row.appendChild(text);
      contextCode.appendChild(row);
    }
    contextView.classList.remove('hidden');
  }

  function closeContext() {
    contextView.classList.add('hidden');
  }

  btnToggle.addEventListener('click', toggle);
  btnClose.addEventListener('click', hide);
  btnCloseContext.addEventListener('click', closeContext);

  return { show, hide, toggle, isOpen, setErrors };
}
