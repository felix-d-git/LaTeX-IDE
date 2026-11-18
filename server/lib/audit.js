// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Append-only security audit log (JSON Lines, #176) in DATA_DIR/audit.log (0600; the vault mirrors it like other
// data files). Never passwords, tokens, cookies or links; e-mail addresses are masked. Optional AUDIT_SYSLOG=udp://host:514.
'use strict';
const fs = require('fs');
const path = require('path');

const file = () => path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..'), 'audit.log');
const MAX_BYTES = Number(process.env.AUDIT_MAX_BYTES) || 5 * 1024 * 1024;
const GENERATIONS = 3; // audit.log + .1 + .2
const SECRET_KEY = /pass|secret|cookie|authorization|token|link|^key$/i;
const EMAIL = /([^\s@"'<>,;:]{1})[^\s@"'<>,;:]*@([^\s@"'<>,;:]+)/g;
const mask = (s) => s.replace(EMAIL, '$1***@$2');
const clip = (v, n = 128) => (v == null ? null : mask(String(v).replace(/[\r\n]/g, ' ').slice(0, n)));

function rotate(f) {
  try {
    if (fs.statSync(f).size < MAX_BYTES) return;
    for (let i = GENERATIONS - 2; i >= 1; i--) { try { fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`); } catch { /* fehlt */ } }
    fs.renameSync(f, `${f}.1`);
  } catch { /* noch keine Datei */ }
}

let sock = null;
function syslog(line) {
  const m = /^udp:\/\/([^:/]+):?(\d+)?$/.exec(process.env.AUDIT_SYSLOG || '');
  if (!m) return;
  try {
    if (!sock) { sock = require('dgram').createSocket('udp4'); sock.on('error', () => { sock = null; }); sock.unref(); }
    sock.send(Buffer.from(`<85>latex-ide: ${line}`), Number(m[2]) || 514, m[1], () => {}); // 85 = authpriv.notice
  } catch { /* nie fatal */ }
}

// extra: flache Felder; Schlüssel, die nach Geheimnis klingen, fallen weg (Absicherung gegen Versehen).
function audit(event, req, extra = {}) {
  try {
    const safe = {};
    for (const [k, v] of Object.entries(extra)) if (!SECRET_KEY.test(k)) safe[k] = typeof v === 'string' ? clip(v, 256) : v;
    const route = req && req.route && req.route.path; // Muster statt konkretem Pfad (Token in der URL)
    const f = file();
    rotate(f);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      event,
      ip: (req && req.ip) || null,
      user: (req && req.user && req.user.id) || null,
      host: clip(req && req.get && req.get('host')),
      method: (req && req.method) || null,
      path: clip(route ? (req.baseUrl || '') + route : req && req.path),
      ...safe,
    });
    fs.appendFileSync(f, line + '\n', { encoding: 'utf8', mode: 0o600 });
    syslog(line);
  } catch { /* Logging darf den Request nie scheitern lassen */ }
}

// Letzte Einträge (neueste zuerst), optional nach Typ.
function recent({ limit = 200, event } = {}) {
  const f = file();
  const out = [];
  for (const p of [`${f}.2`, `${f}.1`, f]) {
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const l of txt.split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (!event || e.event === event) out.push(e); } catch { /* halbe Zeile */ }
    }
  }
  return out.slice(-limit).reverse();
}

const countSince = (event, ms) => recent({ limit: 1e9, event }).filter((e) => Date.parse(e.t) > Date.now() - ms).length;

// Admin-Banner: zu viele fehlgeschlagene Logins pro Stunde oder irgendein Traversal-Versuch.
function warning() {
  const max = Number(process.env.AUDIT_LOGIN_FAIL_THRESHOLD) || 20;
  const fails = countSince('login_fail', 3600e3);
  const trav = countSince('path_traversal_attempt', 3600e3);
  const w = [];
  if (fails >= max) w.push(`${fails} fehlgeschlagene Anmeldungen in der letzten Stunde`);
  if (trav) w.push(`${trav} Pfad-Traversal-Versuch(e) in der letzten Stunde`);
  return w.length ? w.join('; ') : null;
}

const TRAVERSAL = /(^|[\/])\.\.([\/]|$)/;
module.exports = { audit, recent, warning, clip, TRAVERSAL };
