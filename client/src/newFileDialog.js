import { api } from './api.js';

import { referencePrefs } from './latexCompletions.js';

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
    create.disabled = true;
    input.addEventListener('input', () => {
      create.disabled = !input.value.trim() || input.value === 'name.tex';
    });
    const doCreate = async () => {
      const name = input.value.trim();
      if (create.disabled) return;
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
    drop.textContent = 'Drop your files here, or select them below.';
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

  function field(text, el) {
    const label = document.createElement('label');
    label.textContent = text;
    label.appendChild(el);
    return label;
  }

  function input(value = '', placeholder = '') {
    const el = document.createElement('input');
    el.value = value;
    el.placeholder = placeholder;
    return el;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'settings-note';
    p.textContent = text;
    return p;
  }

  // Button, der fn() ausführt, danach Dialog schließt und die neue Datei öffnet.
  function actionButton(text, fn) {
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = text;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const { path } = await fn();
        hide();
        onCreated && onCreated(path);
      } catch (e) {
        alert('Fehler: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    };
    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    row.appendChild(btn);
    return row;
  }

  function renderOtherProjectTab() {
    const wrap = document.createElement('div');
    const project = document.createElement('select');
    const file = document.createElement('select');
    const name = input('', 'Dateiname (leer = wie Original)');
    wrap.append(field('Projekt', project), field('Datei', file), field('Name im Projekt', name));
    wrap.appendChild(actionButton('Übernehmen', () => api.importProjectFile(project.value, file.value, targetDir, name.value.trim() || undefined)));
    const loadFiles = async () => {
      file.innerHTML = '';
      if (!project.value) return;
      const { files } = await api.importFiles(project.value);
      for (const f of files) file.add(new Option(f, f));
    };
    project.addEventListener('change', () => loadFiles().catch((e) => alert(e.message)));
    api.importProjects().then(({ projects }) => {
      if (!projects.length) wrap.prepend(note('Keine anderen Projekte, auf die du Zugriff hast.'));
      for (const p of projects) project.add(new Option(p.name, p.id));
      return loadFiles();
    }).catch((e) => alert(e.message));
    return wrap;
  }

  function renderUrlTab() {
    const wrap = document.createElement('div');
    const url = input('', 'https://…');
    const name = input('', 'Dateiname (leer = aus der URL)');
    wrap.append(field('URL', url), field('Name im Projekt', name));
    wrap.appendChild(note('Einmalige Kopie: spätere Änderungen an der Quelle werden nicht nachgeladen.'));
    wrap.appendChild(actionButton('Laden', () => api.importUrl(url.value.trim(), targetDir, name.value.trim())));
    setTimeout(() => url.focus(), 0);
    return wrap;
  }

  function renderReferencesTab() {
    const wrap = document.createElement('div');
    const h = (text) => {
      const el = document.createElement('h4');
      el.textContent = text;
      return el;
    };

    const zName = input('zotero.bib');
    wrap.append(h('Zotero'), field('Dateiname', zName));
    wrap.appendChild(note('Lädt die ganze Bibliothek (Zugang unter Einstellungen ▸ Literatur, Format dort wählbar).'));
    wrap.appendChild(actionButton('Aus Zotero importieren / aktualisieren (ersetzt die Datei)', () => api.importZotero(targetDir, zName.value.trim(), referencePrefs().format)));

    const bibUrl = input('', 'https://…/literatur.bib');
    wrap.append(h('.bib-Datei'), field('URL', bibUrl));
    wrap.appendChild(actionButton('Von URL laden', () => api.importUrl(bibUrl.value.trim(), targetDir, '')));
    const upload = document.createElement('button');
    upload.textContent = '.bib hochladen';
    upload.onclick = () => {
      activeTab = 'upload';
      render();
    };
    wrap.appendChild(upload);
    wrap.appendChild(note('Mendeley / ReadCube Papers: Bibliothek dort als BibTeX (.bib) exportieren und hier hochladen.'));

    const doi = input('', '10.1000/xyz123');
    const dName = input('references.bib');
    wrap.append(h('DOI'), field('DOI', doi), field('An Datei anhängen', dName));
    wrap.appendChild(actionButton('BibTeX holen', () => api.importDoi(doi.value.trim(), targetDir, dName.value.trim())));
    return wrap;
  }

  function render() {
    body.innerHTML = '';
    if (activeTab === 'new') body.appendChild(renderNewTab());
    else if (activeTab === 'upload') body.appendChild(renderUploadTab());
    else if (activeTab === 'other-project') body.appendChild(renderOtherProjectTab());
    else if (activeTab === 'external-url') body.appendChild(renderUrlTab());
    else body.appendChild(renderReferencesTab());
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
