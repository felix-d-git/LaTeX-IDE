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
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      // An unreachable SMTP server must not keep requests hanging for minutes.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

function logToOutbox(subject, to, text, reason = 'Kein SMTP konfiguriert') {
  const entry = `\n--- ${new Date().toISOString()} ---\nAn: ${to}\nBetreff: ${subject}\n${text}\n`;
  console.log(`[mailer] ${reason} - Link/Nachricht wird nur geloggt:${entry}`);
  try {
    fs.appendFileSync(OUTBOX_PATH, entry, 'utf8');
  } catch (e) {
    // best-effort log file, console output above is the source of truth
  }
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    logToOutbox(subject, to, text);
    return { delivered: false };
  }
  await t.sendMail({
    from: getConfig().from || getConfig().user,
    to,
    subject,
    text,
  });
  return { delivered: true };
}

// Never throws: a failed delivery is logged (and the text kept in the outbox,
// so the admin can still hand out the link) instead of failing the request.
async function sendMailSafe(opts) {
  try {
    return await sendMail(opts);
  } catch (e) {
    console.error('[mailer] Versand fehlgeschlagen:', e.message);
    logToOutbox(opts.subject, opts.to, opts.text, 'Versand fehlgeschlagen');
    return { delivered: false, error: e };
  }
}

module.exports = { sendMail, sendMailSafe, isConfigured, configSource, getConfig, setSmtp };
