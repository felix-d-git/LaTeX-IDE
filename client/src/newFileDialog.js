import { api } from './api.js';

const STUB_TABS = {
  'other-project': 'Datei aus einem anderen Projekt übernehmen (bräuchte projektübergreifende Auswahl-UI) ist noch nicht umgesetzt.',
  'external-url': 'Datei von einer externen URL laden ist noch nicht umgesetzt.',
  zotero: 'Zotero/Mendeley/ReadCube-Anbindung ist noch nicht umgesetzt (siehe Account-Tab in den Einstellungen).',
};

export function setupNewFileDialog({ onCreated, onUpload }) {
  const modal = document.getElementById('new-file-dialog');
  const tabsBar = document.getElementById('new-file-tabs');
  const body = document.getElementById('new-file-tab-body');
  const btnClose = document.getElementById('btn-close-new-file');

  let activeTab = 'new';
  let targetDir = '';

  function show(dir = '', initialTab = 'new') {
    targetDir = dir || '';
    activeTab = initialTab;
    modal.classList.remove('hidden');
    render();
  }

  function hide() {
    modal.classList.add('hidden');
  }

  function renderNewTab() {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = 'File Name';
    const input = document.createElement('input');
    input.value = 'name.tex';
    label.appendChild(input);
    wrap.appendChild(label);
    // Mirrors Overleaf: only "name" is pre-selected so typing immediately replaces it, ".tex" stays untouched.
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(0, input.value.lastIndexOf('.'));
    }, 0);

    const buttons = document.createElement('div');
    buttons.className = 'dialog-buttons';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = hide;
    const create = document.createElement('button');
    create.className = 'primary';
    create.textContent = 'Create';
    const doCreate = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        const relPath = targetDir ? `${targetDir}/${name}` : name;
        const { path } = await api.createFile(relPath);
        hide();
        onCreated && onCreated(path);
      } catch (e) {
        alert('Fehler beim Anlegen: ' + e.message);
      }
    };
    create.onclick = doCreate;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
    });
    buttons.appendChild(cancel);
    buttons.appendChild(create);
    wrap.appendChild(buttons);
    return wrap;
  }

  function renderUploadTab() {
    const wrap = document.createElement('div');
    const drop = document.createElement('div');
    drop.id = 'new-file-drop-zone';
    drop.textContent = 'Drop or paste your files here, or select them below.';
    wrap.appendChild(drop);

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'hidden';
    wrap.appendChild(input);

    const selectBtn = document.createElement('button');
    selectBtn.textContent = 'Select files';
    selectBtn.className = 'primary';
    selectBtn.onclick = () => input.click();
    wrap.appendChild(selectBtn);

    const finishUpload = async (files) => {
      if (files.length === 0) return;
      await onUpload(targetDir, files.map((f) => ({ relPath: f.name, file: f })));
      hide();
    };

    input.addEventListener('change', () => finishUpload(Array.from(input.files || [])));
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('drop-target');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drop-target'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drop-target');
      finishUpload(Array.from(e.dataTransfer.files || []));
    });
    return wrap;
  }

  function renderStubTab(key) {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = '🚧 ' + STUB_TABS[key];
    wrap.appendChild(p);
    return wrap;
  }

  function render() {
    body.innerHTML = '';
    if (activeTab === 'new') body.appendChild(renderNewTab());
    else if (activeTab === 'upload') body.appendChild(renderUploadTab());
    else body.appendChild(renderStubTab(activeTab));
    for (const btn of tabsBar.querySelectorAll('.tab-btn')) {
      btn.classList.toggle('active', btn.dataset.nfTab === activeTab);
    }
  }

  tabsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nf-tab]');
    if (!btn) return;
    activeTab = btn.dataset.nfTab;
    render();
  });
  btnClose.addEventListener('click', hide);

  return { show, hide };
}

export function setupNewFolderDialog({ onCreated }) {
  const modal = document.getElementById('new-folder-dialog');
  const input = document.getElementById('new-folder-name-input');
  const btnClose = document.getElementById('btn-close-new-folder');
  const btnCancel = document.getElementById('btn-cancel-new-folder');
  const btnConfirm = document.getElementById('btn-confirm-new-folder');

  let targetDir = '';

  function show(dir = '') {
    targetDir = dir || '';
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 0);
  }

  function hide() {
    modal.classList.add('hidden');
  }

  async function confirm() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const relPath = targetDir ? `${targetDir}/${name}` : name;
      await api.createFolder(relPath);
      hide();
      onCreated && onCreated();
    } catch (e) {
      alert('Fehler beim Anlegen: ' + e.message);
    }
  }

  btnClose.addEventListener('click', hide);
  btnCancel.addEventListener('click', hide);
  btnConfirm.addEventListener('click', confirm);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') hide();
  });

  return { show, hide };
}
