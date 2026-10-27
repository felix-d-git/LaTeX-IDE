const fs = require('fs');
const path = require('path');
const { isIgnored, sameEntry } = require('./fsTree');
const { extractZip } = require('./unzip');

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

// exclude: zusätzliche Ordner, die schon VOR der (teuren) lastModified-Berechnung wegfallen (z. B. 'users' beim Admin).
function listProjects(projectsDir, exclude = []) {
  return listEntries(projectsDir, [TRASH_DIRNAME, ARCHIVE_DIRNAME, ...exclude]);
}

// key: label key, distinct from an active project of the same name.
function listTrash(projectsDir) {
  return listEntries(path.join(projectsDir, TRASH_DIRNAME)).map((p) => ({ ...p, key: `${TRASH_DIRNAME}/${p.name}` }));
}

function listArchived(projectsDir) {
  return listEntries(path.join(projectsDir, ARCHIVE_DIRNAME)).map((p) => ({ ...p, key: `${ARCHIVE_DIRNAME}/${p.name}` }));
}

function assertValidName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Projektname darf nicht leer sein.');
  if (INVALID_NAME_RE.test(trimmed)) throw new Error('Projektname enthält ungültige Zeichen (\\ / : * ? " < > |).');
  // Punkt-Ordner sind intern (.trash/.archive), 'users' ist der Konten-Ordner des Admins.
  if (trimmed.startsWith('.') || trimmed.toLowerCase() === 'users') throw new Error('Dieser Projektname ist reserviert (kein führender Punkt, nicht "users").');
  if (trimmed.endsWith('.')) throw new Error('Projektname darf nicht mit einem Punkt enden.');
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

// Neues Projekt aus Zip-Bytes; Name = Zip-Name ohne .zip, bei Kollision Suffix _2, _3 ...
function importZip(projectsDir, zipName, buf) {
  const base = (zipName || '').replace(/\.zip$/i, '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim() || 'Import';
  const root = uniqueDest(projectsDir, base);
  fs.mkdirSync(root, { recursive: true });
  try {
    extractZip(buf, root);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return root;
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

function trashArchivedProject(projectsDir, name) {
  const src = path.join(projectsDir, ARCHIVE_DIRNAME, name || '');
  if (!name || path.basename(name) !== name || !fs.existsSync(src)) throw new Error('Projekt im Archiv nicht gefunden.');
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
  // Nur Groß-/Kleinschreibung geändert: dest = src auf case-insensitiven Dateisystemen.
  if (fs.existsSync(dest) && !sameEntry(src, dest)) throw new Error('Ein Projekt mit diesem Namen existiert bereits.');
  fs.renameSync(src, dest);
  return dest;
}

// Duplicates a project folder ("Copy project" action).
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
  // Build-Ausgaben (aller Nutzer), Verlauf, Collab-Zustand und Papierkorb gehören nicht in die Kopie.
  const skip = new Set(['.latex-ide-out', '.latex-ide-history', '.latex-ide-yjs', '.trash']);
  fs.cpSync(src, dest, { recursive: true, filter: (from) => !(path.dirname(from) === src && skip.has(path.basename(from))) });
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
  importZip,
  archiveProject,
  unarchiveProject,
  trashProject,
  trashArchivedProject,
  restoreProject,
  deleteProjectPermanently,
  renameProject,
};
