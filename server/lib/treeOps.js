const fs = require('fs');
const path = require('path');
const { safeResolve } = require('./fsTree');

const INVALID_NAME_RE = /[\\/:*?"<>|]/;

function assertValidName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Name darf nicht leer sein.');
  if (INVALID_NAME_RE.test(trimmed)) throw new Error('Name enthält ungültige Zeichen (\\ / : * ? " < > |).');
  return trimmed;
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// Appends "_2", "_3", ... before the extension until a free name is found -
// used for uploads so dropping a same-named file never silently overwrites.
function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dest = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(dest)) {
    i += 1;
    dest = path.join(dir, `${base}_${i}${ext}`);
  }
  return dest;
}

function createFolder(root, relPath) {
  const abs = safeResolve(root, relPath);
  if (fs.existsSync(abs)) throw new Error('Ordner existiert bereits.');
  fs.mkdirSync(abs, { recursive: true });
  return toRel(root, abs);
}

function createFile(root, relPath) {
  const abs = safeResolve(root, relPath);
  if (fs.existsSync(abs)) throw new Error('Datei existiert bereits.');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '', 'utf8');
  return toRel(root, abs);
}

function renamePath(root, relPath, newName) {
  const safeName = assertValidName(newName);
  const abs = safeResolve(root, relPath);
  if (!fs.existsSync(abs)) throw new Error('Nicht gefunden.');
  const dest = path.join(path.dirname(abs), safeName);
  if (fs.existsSync(dest)) {
    // Case-only rename on a case-insensitive FS: dest is the same entry as abs -> go via a temp name.
    if (dest === abs || dest.toLowerCase() !== abs.toLowerCase()) throw new Error('Am Ziel existiert bereits eine Datei/ein Ordner mit diesem Namen.');
    const tmp = abs + '.tmp-rename';
    fs.renameSync(abs, tmp);
    fs.renameSync(tmp, dest);
    return toRel(root, dest);
  }
  fs.renameSync(abs, dest);
  return toRel(root, dest);
}

// Moves a file/folder into a different directory within the same project
// (drag&drop within the file tree). Distinct from renamePath, which only
// renames in place. Throws a conflict error (caller maps it to HTTP 409) if
// the destination already has an entry with that name and overwrite isn't
// set, so the client can ask "cancel or overwrite" before resubmitting.
function movePath(root, relPath, targetDir, overwrite) {
  const abs = safeResolve(root, relPath);
  if (!fs.existsSync(abs)) throw new Error('Nicht gefunden.');
  const destDirAbs = safeResolve(root, targetDir || '');
  if (!fs.existsSync(destDirAbs) || !fs.statSync(destDirAbs).isDirectory()) {
    throw new Error('Zielordner nicht gefunden.');
  }
  const dest = path.join(destDirAbs, path.basename(abs));
  if (path.dirname(abs) === destDirAbs) return toRel(root, abs); // already there - no-op
  if (fs.statSync(abs).isDirectory()) {
    const absWithSep = abs + path.sep;
    if (destDirAbs === abs || destDirAbs.startsWith(absWithSep)) {
      throw new Error('Ein Ordner kann nicht in sich selbst oder einen eigenen Unterordner verschoben werden.');
    }
  }
  if (fs.existsSync(dest)) {
    if (!overwrite) {
      const err = new Error('Am Ziel existiert bereits eine Datei/ein Ordner mit diesem Namen.');
      err.conflict = true;
      throw err;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(abs, dest);
  return toRel(root, dest);
}

function deletePath(root, relPath) {
  const abs = safeResolve(root, relPath);
  if (!fs.existsSync(abs)) throw new Error('Nicht gefunden.');
  fs.rmSync(abs, { recursive: true, force: true });
}

// Desktop sync deletes land in the project's .trash (hidden, not synced/compiled via isIgnored):
// a sync gone wrong must not destroy files for all members, binaries have no history.
// ponytail: .trash is never emptied - add a cleanup when it grows noticeably.
function trashPath(root, relPath) {
  const abs = safeResolve(root, relPath);
  if (!fs.existsSync(abs) || abs === path.resolve(root)) throw new Error('Nicht gefunden.');
  const dir = path.dirname(safeResolve(path.join(root, '.trash'), toRel(root, abs)));
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(abs, uniqueDest(dir, path.basename(abs)));
}

// Used both by drag&drop upload from the OS and by (future) file-picker upload.
// contentBase64 is the raw file bytes, base64-encoded client-side. overwrite:
// replace a same-named file (user chose so in the conflict dialog), else "_2".
function uploadFile(root, relDir, name, contentBase64, overwrite = false) {
  const dirAbs = safeResolve(root, relDir || '');
  fs.mkdirSync(dirAbs, { recursive: true });
  const safeName = assertValidName(name);
  const exact = path.join(dirAbs, safeName);
  const dest = overwrite && !(fs.existsSync(exact) && fs.statSync(exact).isDirectory()) ? exact : uniqueDest(dirAbs, safeName);
  fs.writeFileSync(dest, Buffer.from(contentBase64, 'base64'));
  return toRel(root, dest);
}

module.exports = { createFolder, createFile, renamePath, movePath, deletePath, trashPath, uploadFile };
