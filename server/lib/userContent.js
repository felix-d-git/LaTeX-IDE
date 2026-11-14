// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Project/user files are served from the app's own origin (server and desktop app). An uploaded
// SVG or HTML file must never run script there: opened directly (link, new tab) it would act with
// the viewer's session and could read the CSRF cookie (#113).
const path = require('path');

// Inline preview types of /api/raw; everything else is a plain download.
const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// No scripts, own (opaque) origin; <img src> and inline SVG styles keep working.
const USER_CONTENT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

const rawMime = (file) => RAW_MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
const isPdf = (contentType) => /^application\/pdf\b/i.test(String(contentType || ''));

// nosniff for every user file; the sandbox CSP for everything but PDFs: `sandbox` blocks the
// browser's built-in PDF viewer (preview iframe, native PDF view). A PDF served as application/pdf
// with nosniff runs no script in our origin (the viewers sandbox PDF JavaScript themselves).
function setUserContentHeaders(res, contentType) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isPdf(contentType)) res.setHeader('Content-Security-Policy', USER_CONTENT_CSP);
}

module.exports = { RAW_MIME, USER_CONTENT_CSP, rawMime, isPdf, setUserContentHeaders };
