const fs = require('fs');
const path = require('path');
const { isIgnored } = require('./fsTree');

const TRASH_DIRNAME = '.trash';
const ARCHIVE_DIRNAME = '.archive';
const INVALID_NAME_RE = /[\\/:*?"<>|]/;

function getLastModified(dir) {
  let max = 0;
  function walk(d, depth) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (depth < 6) walk(abs, depth + 1);
      } else {
        try {
          const mtimeMs = fs.statSync(abs).mtimeMs;
          if (mtimeMs > max) max = mtimeMs;
        } catch (e) {
          // file vanished mid-walk (e.g. temp file) - ignore
        }
      }
    }
  }
  walk(dir, 0);
  return max;
}

function listEntries(dir, exclude = []) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !exclude.includes(d.name))
    .map((d) => {
      const root = path.join(dir, d.name);
      return { name: d.name, root, lastModified: getLastModified(root) };
    })
    .sort((a, b) => b.lastModified - a.lastModified);
}

function listProjects(projectsDir) {
  return listEntries(projectsDir, [TRASH_DIRNAME, ARCHIVE_DIRNAME]);
}

function listTrash(projectsDir) {
  return listEntries(path.join(projectsDir, TRASH_DIRNAME));
}

function listArchived(projectsDir) {
  return listEntries(path.join(projectsDir, ARCHIVE_DIRNAME));
}

function assertValidName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Projektname darf nicht leer sein.');
  if (INVALID_NAME_RE.test(trimmed)) throw new Error('Projektname enthält ungültige Zeichen (\\ / : * ? " < > |).');
  return trimmed;
}

function createProject(projectsDir, name) {
  const safeName = assertValidName(name);
  const root = path.join(projectsDir, safeName);
  if (fs.existsSync(root)) throw new Error('Ein Projekt mit diesem Namen existiert bereits.');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'main.tex'),
    `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[ngerman]{babel}

\\title{${safeName}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Einleitung}

\\end{document}
`,
    'utf8'
  );
  return root;
}

function uniqueDest(dir, name) {
  let destName = name;
  let dest = path.join(dir, destName);
  let i = 1;
  while (fs.existsSync(dest)) {
    i += 1;
    destName = `${name}_${i}`;
    dest = path.join(dir, destName);
  }
  return dest;
}

function trashProject(projectsDir, name) {
  const src = path.join(projectsDir, name);
  if (!fs.existsSync(src)) throw new Error('Projekt nicht gefunden.');
  const trashDir = path.join(projectsDir, TRASH_DIRNAME);
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = uniqueDest(trashDir, name);
  fs.renameSync(src, dest);
  return dest;
}

function restoreProject(projectsDir, name) {
  const src = path.join(projectsDir, TRASH_DIRNAME, name);
  if (!fs.existsSync(src)) throw new Error('Projekt im Papierkorb nicht gefunden.');
  const dest = uniqueDest(projectsDir, name);
  fs.renameSync(src, dest);
  return dest;
}

function deleteProjectPermanently(projectsDir, name) {
  const target = path.join(projectsDir, TRASH_DIRNAME, name);
  if (!fs.existsSync(target)) throw new Error('Projekt im Papierkorb nicht gefunden.');
  fs.rmSync(target, { recursive: true, force: true });
}

function renameProject(projectsDir, oldName, newName) {
  const safeName = assertValidName(newName);
  const src = path.join(projectsDir, oldName);
  const dest = path.join(projectsDir, safeName);
  if (!fs.existsSync(src)) throw new Error('Projekt nicht gefunden.');
  if (fs.existsSync(dest)) throw new Error('Ein Projekt mit diesem Namen existiert bereits.');
  fs.renameSync(src, dest);
  return dest;
}

// Duplicates a project folder, mirroring Overleaf's "Copy project" action.
// Without an explicit newName, auto-suffixes "<name> (Copy)" / "(Copy 2)" / ...
// (dashboard quick-action); with one (Copy-project modal), uses that name exactly.
function copyProject(projectsDir, name, newName) {
  const src = path.join(projectsDir, name);
  if (!fs.existsSync(src)) throw new Error('Projekt nicht gefunden.');
  let dest;
  if (newName) {
    const safeName = assertValidName(newName);
    dest = path.join(projectsDir, safeName);
    if (fs.existsSync(dest)) throw new Error('Ein Projekt mit diesem Namen existiert bereits.');
  } else {
    let destName = `${name} (Copy)`;
    dest = path.join(projectsDir, destName);
    let i = 1;
    while (fs.existsSync(dest)) {
      i += 1;
      destName = `${name} (Copy ${i})`;
      dest = path.join(projectsDir, destName);
    }
  }
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function archiveProject(projectsDir, name) {
  const src = path.join(projectsDir, name);
  if (!fs.existsSync(src)) throw new Error('Projekt nicht gefunden.');
  const archiveDir = path.join(projectsDir, ARCHIVE_DIRNAME);
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = uniqueDest(archiveDir, name);
  fs.renameSync(src, dest);
  return dest;
}

function unarchiveProject(projectsDir, name) {
  const src = path.join(projectsDir, ARCHIVE_DIRNAME, name);
  if (!fs.existsSync(src)) throw new Error('Projekt im Archiv nicht gefunden.');
  const dest = uniqueDest(projectsDir, name);
  fs.renameSync(src, dest);
  return dest;
}

module.exports = {
  TRASH_DIRNAME,
  ARCHIVE_DIRNAME,
  getLastModified,
  listProjects,
  listTrash,
  listArchived,
  createProject,
  copyProject,
  archiveProject,
  unarchiveProject,
  trashProject,
  restoreProject,
  deleteProjectPermanently,
  renameProject,
};
