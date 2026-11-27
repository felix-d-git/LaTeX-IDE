// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Sicherheitsoptionen der Electron-Fenster (#212). Test: test/desktopElectron.test.js
const path = require('path');

const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  preload: path.join(__dirname, '..', 'preload.js'),
};

// Nur der eigene lokale Ursprung darf im Fenster geladen werden.
function isOwnOrigin(url, port) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && Number(u.port) === Number(port);
  } catch {
    return false;
  }
}

// Externe Links: nur http(s)/mailto an den Standardbrowser, sonst nichts.
function externalTarget(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

module.exports = { WEB_PREFERENCES, isOwnOrigin, externalTarget };
