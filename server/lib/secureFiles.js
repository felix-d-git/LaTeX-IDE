// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Restrictive file permissions for secret-bearing files (#168). POSIX only; no-op on Windows.
const fs = require('fs');
const path = require('path');

const POSIX = process.platform !== 'win32';
const SECRET_FILES = ['auth-data.json', 'workspace.json', '.session-secret', 'mail-outbox.log', 'config.json'];

// Call first thing at startup: everything the process creates afterwards is owner-only.
function applyUmask() {
  if (POSIX) process.umask(0o077);
}

// One-time chmod 0600 of existing secret files (and .sessions/*) + warning when the data dir is world-readable.
function tightenSecrets(dir, log = console) {
  if (!POSIX) return;
  const fix = (f) => {
    try { fs.chmodSync(f, 0o600); } catch (e) { if (e.code !== 'ENOENT') log.warn(`[perm] chmod ${f}: ${e.message}`); }
  };
  for (const n of SECRET_FILES) fix(path.join(dir, n));
  try {
    const sdir = path.join(dir, '.sessions');
    for (const n of fs.readdirSync(sdir)) fix(path.join(sdir, n));
  } catch (_) { /* no sessions yet */ }
  try {
    if (fs.statSync(dir).mode & 0o007) log.warn(`[perm] ${dir} ist für "other" les-/zugreifbar; empfohlen: chmod 700.`);
  } catch (_) { /* best effort */ }
}

module.exports = { applyUmask, tightenSecrets, SECRET_FILES };
