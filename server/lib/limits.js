// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Resource limits (#158): env = default, admin overrides (auth-data.json settings.limits) win and
// apply without restart.
const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
// key: [env, default, max]
const SPEC = {
  zipLimitMb: ['ZIP_LIMIT', 50, 500],
  userQuotaMb: ['USER_QUOTA_MB', 300, 10485760],
  commentMaxChars: ['COMMENT_MAX_CHARS', 20000, 200000],
  labelMaxChars: ['LABEL_MAX_CHARS', 100, 1000],
  maxLabeledEntries: ['MAX_LABELED_ENTRIES', 50, 10000],
  freeReserveMb: ['FREE_RESERVE_MB', 200, 10485760],
};

let overrides = {};

function envOrDefault(key) {
  const [env, def] = SPEC[key];
  const n = Number(process.env[env]);
  return Number.isInteger(n) && n > 0 ? n : def;
}

function get(key) {
  return overrides[key] || envOrDefault(key);
}

// Throws (status 400) on unknown keys or anything but positive integers up to the key's maximum.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Ungültige Limits.'), { status: 400 });
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!SPEC[k]) throw Object.assign(new Error(`Unbekanntes Limit: ${k}`), { status: 400 });
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 1 || n > SPEC[k][2]) throw Object.assign(new Error(`${k}: ganze Zahl von 1 bis ${SPEC[k][2]} erforderlich.`), { status: 400 });
    out[k] = n;
  }
  return out;
}

function setOverrides(o) {
  overrides = { ...o };
}

function all() {
  const out = {};
  for (const k of Object.keys(SPEC)) out[k] = { value: get(k), default: envOrDefault(k), max: SPEC[k][2] };
  return out;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(abs);
      else if (e.isFile()) total += fs.statSync(abs).size;
    } catch { /* vanished mid-walk */ }
  }
  return total;
}

// 413 when the user's projects dir plus addBytes exceeds the quota (admins are exempt).
function checkQuota(user, userDir, addBytes) {
  if (user.isAdmin) return;
  const quota = get('userQuotaMb') * MB;
  if (dirSize(userDir) + addBytes > quota) {
    throw Object.assign(new Error(`Speicherkontingent überschritten (max. ${get('userQuotaMb')} MB pro Konto). Bitte Projekte oder Dateien löschen.`), { status: 413 });
  }
}

// 507 when less than the reserve would stay free on the volume holding dir.
function checkFree(dir, addBytes = 0) {
  let st;
  try { st = fs.statfsSync(dir); } catch { return; } // volume not measurable -> no check
  if (st.bavail * st.bsize - addBytes < get('freeReserveMb') * MB) {
    throw Object.assign(new Error('Auf dem Server ist zu wenig freier Speicherplatz. Bitte später erneut versuchen oder den Admin informieren.'), { status: 507 });
  }
}

module.exports = { MB, get, validate, setOverrides, all, dirSize, checkQuota, checkFree };
