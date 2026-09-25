const fs = require('fs');
const path = require('path');

const OUTBOX_PATH = path.join(__dirname, '..', '..', 'mail-outbox.log');

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
    });
  }
  return transporter;
}

function logToOutbox(subject, to, text) {
  const entry = `\n--- ${new Date().toISOString()} ---\nAn: ${to}\nBetreff: ${subject}\n${text}\n`;
  console.log(`[mailer] Kein SMTP konfiguriert - Link/Nachricht wird nur geloggt:${entry}`);
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

module.exports = { sendMail, smtpConfigured };
