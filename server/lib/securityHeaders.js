// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Security headers on every answer of server/index.js and server/desktop.js (#115): CSP as a
// second line of defence against XSS, no framing by other sites (clickjacking), no MIME
// sniffing, no Referer with ?pid=/tokens to external sites.
// CSP_REPORT_ONLY=1 sends the CSP as Content-Security-Policy-Report-Only (staged rollout): the
// browser only reports violations (console + POST /csp-report -> server log), blocks nothing.
// A route may still set its own, stricter Content-Security-Policy (e.g. a sandbox for /api/raw).
const express = require('express');

const REPORT_PATH = '/csp-report';
// Embedded by the IDE itself: PDF viewer "Browser" (/api/pdf) and PDF file preview (/api/raw).
const SAME_ORIGIN_FRAMES = new Set(['/api/pdf', '/api/raw']);

const envFlag = (v) => /^(1|true)$/i.test(String(v || '').trim());

// Extra connect-src sources (CSP_CONNECT_SRC, e.g. a LanguageTool on another machine): plain
// scheme/host sources only, no keywords and nothing that could end the directive (; , quotes).
function parseSources(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((s) => {
      const ok = /^[a-z0-9.*:/_[\]-]+$/i.test(s);
      if (!ok) console.warn(`[csp] CSP_CONNECT_SRC: ungültige Quelle ignoriert: ${s}`);
      return ok;
    });
}

function contentSecurityPolicy({ frameAncestors = "'none'", connectSrc = [] } = {}) {
  return [
    "default-src 'self'",
    // pdf.js decodes JPEG 2000/JBIG2, manages colours and compiles PDF functions as WebAssembly.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", // CodeMirror and KaTeX set inline styles
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // ws:/wss: Yjs and /ws ('self' does not cover WebSockets in every browser). Loopback: own
    // LanguageTool (Settings > Spelling), queried by the browser directly in the web version.
    ['connect-src', "'self'", 'ws:', 'wss:', 'http://localhost:*', 'http://127.0.0.1:*', ...connectSrc].join(' '),
    "worker-src 'self' blob:", // pdf.js worker
    "frame-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${REPORT_PATH}`,
  ].join('; ');
}

function securityHeaders({ reportOnly = envFlag(process.env.CSP_REPORT_ONLY), connectSrc = process.env.CSP_CONNECT_SRC } = {}) {
  const extra = parseSources(connectSrc);
  const cspHeader = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  const policy = contentSecurityPolicy({ connectSrc: extra });
  const framedPolicy = contentSecurityPolicy({ frameAncestors: "'self'", connectSrc: extra });
  return (req, res, next) => {
    const framed = SAME_ORIGIN_FRAMES.has(req.path);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Not part of the report-only rollout: clickjacking protection is on from the start.
    res.setHeader('X-Frame-Options', framed ? 'SAMEORIGIN' : 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(cspHeader, framed ? framedPolicy : policy);
    next();
  };
}

// Violation reports (report-uri): one log line per distinct violation, at most MAX_LOGGED per
// hour, so the unauthenticated endpoint cannot flood the log; the window restarts every hour so
// spam cannot hide real violations until the next restart. Query strings are cut off
// (?pid=, reset/verify tokens).
const MAX_LOGGED = 200;
const LOG_WINDOW_MS = 60 * 60 * 1000;
const clean = (v) => String(v ?? '?').replace(/[?#].*$/s, '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

function cspReportHandler(log = (line) => console.warn(line), { now = Date.now } = {}) {
  let seen = new Set();
  let windowStart = now();
  let suppressed = false;
  return [
    express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
    (req, res) => {
      const body = req.body;
      const reports = Array.isArray(body) ? body.map((r) => r && r.body) : [body && body['csp-report']];
      for (const r of reports.slice(0, 20)) {
        if (!r || typeof r !== 'object') continue;
        const directive = clean(r['effective-directive'] || r.effectiveDirective || r['violated-directive']);
        const blocked = clean(r['blocked-uri'] || r.blockedURL);
        const doc = clean(r['document-uri'] || r.documentURL);
        const file = r['source-file'] || r.sourceFile;
        const where = file ? ` in ${clean(file)}:${Number(r['line-number'] || r.lineNumber) || 0}` : '';
        const mode = (r.disposition || '') === 'report' ? 'gemeldet' : 'blockiert';
        const line = `[csp] ${mode}: ${directive} ${blocked} (Seite ${doc}${where})`;
        if (now() - windowStart >= LOG_WINDOW_MS) {
          seen = new Set();
          windowStart = now();
          suppressed = false;
        }
        if (seen.has(line)) continue;
        if (seen.size >= MAX_LOGGED) {
          if (!suppressed) log(`[csp] mehr als ${MAX_LOGGED} verschiedene Meldungen in dieser Stunde, weitere unterdrückt`);
          suppressed = true;
          continue;
        }
        seen.add(line);
        log(line);
      }
      res.status(204).end();
    },
  ];
}

module.exports = { securityHeaders, cspReportHandler, contentSecurityPolicy, parseSources, REPORT_PATH, SAME_ORIGIN_FRAMES, MAX_LOGGED, LOG_WINDOW_MS };
