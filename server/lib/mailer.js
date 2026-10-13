const fs = require('fs');
const path = require('path');

const OUTBOX_PATH = path.join((process.env.DATA_DIR || path.join(__dirname, '..', '..')), 'mail-outbox.log');

// No real SMTP configured yet (local test setup) -> log the link instead of
// sending mail, so the admin can copy it manually. Setting SMTP_HOST etc.
// switches this to real delivery without touching call sites.
const smtpConfigured = !!process.env.SMTP_HOST;

let transporter = null;
function getTransporter() {
  if (!smtpConfigured) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
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
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
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

module.exports = { sendMail, sendMailSafe, smtpConfigured };
