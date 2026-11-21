// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const fs = require('fs');
const path = require('path');

const OUTBOX_PATH = path.join((process.env.DATA_DIR || path.join(__dirname, '..', '..')), 'mail-outbox.log');

// UI settings (set from index.js via setSmtp) win over .env; neither -> log to outbox
// instead of sending, so the admin can copy the link manually.
let override = null;
let transporter = null;
function getConfig() {
  if (override && override.host) return override;
  if (!process.env.SMTP_HOST) return null;
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}
const isConfigured = () => !!getConfig();
const configSource = () => (override && override.host ? 'ui' : process.env.SMTP_HOST ? 'env' : 'none');
function setSmtp(cfg) {
  override = cfg && cfg.host ? cfg : null;
  transporter = null;
}

function getTransporter() {
  const c = getConfig();
  if (!c) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: c.host,
      port: Number(c.port) || 587,
      secure: !!c.secure,
      // STARTTLS Pflicht (sonst kann ein Angreifer es entfernen und AUTH im Klartext mitlesen); Opt-out nur per Env.
      requireTLS: !c.secure && process.env.SMTP_ALLOW_PLAIN !== 'true',
      tls: { minVersion: 'TLSv1.2' },
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      // An unreachable SMTP server must not keep requests hanging for minutes.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

// nodemailer: 'Message failed: ... STARTTLS' bzw. code ESOCKET/ECONNECTION when the server has no STARTTLS.
function explain(e) {
  return /STARTTLS/i.test(e.message || '') ? 'Der SMTP-Server bietet kein STARTTLS an (Port 587 setzt STARTTLS voraus; Port 465 mit SSL/TLS). Nur für lokale Tests: SMTP_ALLOW_PLAIN=true.' : e.message;
}

const OUTBOX_MAX_AGE_MS = 48 * 3600 * 1000;
const maskAddr = (to) => String(to || '').replace(/^(.)[^@]*@/, '$1***@');

// stdout: only masked recipient + subject. The file (links!) is 0600, atomically replaced, entries > 48 h pruned.
function logToOutbox(subject, to, text, reason = 'Kein SMTP konfiguriert') {
  console.log(`[mailer] ${reason} - An: ${maskAddr(to)}, Betreff: ${subject} (Nachricht nur in mail-outbox.log)`);
  try {
    let old = '';
    try { old = fs.readFileSync(OUTBOX_PATH, 'utf8'); } catch (e) { /* none yet */ }
    const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
    const kept = old.split(/(?=\n--- \d{4}-\d\d-\d\dT)/)
      .filter((e) => { const m = /^\n--- (\S+) ---\n/.exec(e); return m && Date.parse(m[1]) >= cutoff; }).join('');
    const entry = `
--- ${new Date().toISOString()} ---
An: ${to}
Betreff: ${subject}
${text}
`;
    const tmp = `${OUTBOX_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept + entry, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, OUTBOX_PATH);
  } catch (e) {
    // best-effort log file
  }
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    logToOutbox(subject, to, text);
    return { delivered: false };
  }
  try {
    await t.sendMail({
      from: getConfig().from || getConfig().user,
      to,
      subject,
      text,
    });
  } catch (e) {
    e.message = explain(e);
    throw e;
  }
  return { delivered: true };
}

// Never throws: a failed delivery is logged instead of failing the request.
async function sendMailSafe(opts) {
  try {
    return await sendMail(opts);
  } catch (e) {
    console.error(`[mailer] Versand an ${maskAddr(opts.to)} fehlgeschlagen:`, explain(e));
    return { delivered: false, error: e };
  }
}

module.exports = { sendMail, sendMailSafe, isConfigured, configSource, getConfig, setSmtp };
