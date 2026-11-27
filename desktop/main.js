// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Electron-Shell der Desktop-App (#212). Startet den vorhandenen Server im selben Prozess:
//  - mit Server-Adresse (REMOTE_URL / server.json): server/desktop.js (Proxy + lokale Kopie + Sync)
//  - ohne Server-Adresse: server/index.js im LOCAL_MODE (alles lokal)
// Fenster lädt nur den eigenen Ursprung http://localhost:<PORT>; Start-Schlüssel (#163) wird als Cookie gesetzt.
const { app, BrowserWindow, dialog, session, shell } = require('electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fileArg } = require('./lib/args');
const { WEB_PREFERENCES, isOwnOrigin, externalTarget } = require('./lib/security');

const ROOT = path.join(__dirname, '..');
const launchKey = require(path.join(ROOT, 'server', 'lib', 'launchKey'));
const PORT = Number(process.env.PORT) || 3178;
const DATA = process.env.LATEX_IDE_DATA || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'LatexIDE', 'data') : path.join(app.getPath('userData'), 'data'));

function readServerJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}
const REMOTE = String(process.env.REMOTE_URL || readServerJson().remoteUrl || '').replace(/\/+$/, '');

let win = null;
let server = null; // exports of server/desktop.js (nur mit Server)
let quitting = false;
let pendingFile = fileArg(process.argv.slice(1), process.cwd());

if (!app.requestSingleInstanceLock()) {
  app.quit(); // laufende Instanz bekommt Datei per second-instance
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const f = fileArg(argv.slice(1), cwd);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) openFile(f);
    } else if (f) pendingFile = f;
  });
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('LaTeX-IDE', String(e && e.message || e));
    app.exit(1);
  });
}

// macOS: Doppelklick / "Öffnen mit"
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) openFile(p);
  else pendingFile = p;
});
app.on('window-all-closed', () => app.quit());

function openFile(f) {
  if (win) win.loadURL(`http://localhost:${PORT}/?open=${encodeURIComponent(f)}`);
}

function waitFor(fn, ms = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const v = await fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('Der lokale Server ist nicht gestartet.'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

const portOpen = () => new Promise((r) => net.connect(PORT, '127.0.0.1').once('connect', function () { this.destroy(); r(true); }).once('error', () => r(false)));

async function startServer() {
  process.env.PORT = String(PORT);
  process.env.LATEX_IDE_DATA = DATA;
  process.env.LOCAL_NO_BROWSER = '1';
  process.env.LIDE_ELECTRON = '1';
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    process.env.PATH = `${path.join(process.env.LOCALAPPDATA, 'LatexIDE', 'texlive', '2025', 'bin', 'windows')};${process.env.PATH}`;
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.rmSync(path.join(DATA, '.launch-key'), { force: true }); // sonst Schlüssel eines früheren Starts
  if (REMOTE) {
    process.env.REMOTE_URL = REMOTE;
    server = require(path.join(ROOT, 'server', 'desktop.js'));
  } else {
    process.env.LOCAL_MODE = '1';
    process.env.DATA_DIR = DATA;
    require(path.join(ROOT, 'server', 'index.js'));
  }
  await waitFor(portOpen);
  return waitFor(() => launchKey.read(DATA));
}

function lockDown(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    const t = externalTarget(url);
    if (t) shell.openExternal(t);
    return { action: 'deny' };
  });
  const guard = (e, url) => {
    if (isOwnOrigin(url, PORT)) return;
    e.preventDefault();
    const t = externalTarget(url);
    if (t) shell.openExternal(t); // z. B. Anmeldung beim Server im Standardbrowser
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}

async function start() {
  const key = await startServer();
  await session.defaultSession.cookies.set({ url: `http://localhost:${PORT}`, name: 'lideLocal', value: key, httpOnly: true, sameSite: 'strict' });
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  app.on('web-contents-created', (_e, wc) => lockDown(wc));
  win = new BrowserWindow({ width: 1400, height: 900, title: 'LaTeX-IDE', autoHideMenuBar: true, webPreferences: WEB_PREFERENCES });
  win.on('close', onClose);
  win.on('closed', () => (win = null));
  // Anmeldung im Systembrowser abgeschlossen -> Fenster neu laden
  process.on('lide-login', () => win && win.loadURL(`http://localhost:${PORT}/`));
  await win.loadURL(`http://localhost:${PORT}/${pendingFile ? `?open=${encodeURIComponent(pendingFile)}` : ''}`);
  pendingFile = null;
  if (!REMOTE) checkGithubUpdate().catch(() => {});
}

// Fenster schließen: erst alle lokalen Änderungen zum Server, dann komplett beenden (kein Tray, kein Hintergrundprozess).
// Offline/Fehler: Änderungen bleiben lokal und werden beim nächsten Start abgeglichen, nichts geht verloren.
async function onClose(e) {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  const prog = new BrowserWindow({ width: 420, height: 160, parent: win, modal: true, frame: false, resizable: false, show: false, webPreferences: { ...WEB_PREFERENCES, preload: undefined } });
  const html = '<meta charset="utf-8"><body style="font:15px system-ui;padding:28px"><b>LaTeX-IDE wird beendet</b><p id="t">Änderungen werden mit dem Server abgeglichen …</p>';
  await prog.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  prog.show();
  const say = (t) => prog.isDestroyed() || prog.webContents.executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(t)}`).catch(() => {});
  try {
    const r = await server.flushForQuit((p) => p.total && say(`Synchronisiere ${p.done + 1 > p.total ? p.total : p.done + 1} von ${p.total}: ${p.name}`));
    if (!r.ok) {
      await say(r.offline ? 'Kein Server erreichbar - Änderungen bleiben lokal und werden beim nächsten Start abgeglichen.' : `Nicht abgeglichen (bleibt lokal bis zum nächsten Start): ${r.pending.join(', ')}`);
      await new Promise((res) => setTimeout(res, 2500));
    }
  } catch (err) {
    await say('Abgleich fehlgeschlagen - Änderungen bleiben lokal.');
    await new Promise((res) => setTimeout(res, 2500));
  }
  app.exit(0);
}

// Ohne eigenen Server: Updates aus GitHub-Releases, Prüfsumme aus dem SHA256SUMS-Asset (Windows).
async function checkGithubUpdate() {
  if (process.platform !== 'win32') return;
  const { updateSource, githubLatest, githubDownload } = require(path.join(ROOT, 'server', 'lib', 'desktopAssets'));
  const src = updateSource({ remote: REMOTE });
  if (src.kind !== 'github') return;
  const rel = await githubLatest(src.repo, fetch);
  const cur = require(path.join(ROOT, 'package.json')).version;
  const num = (v) => String(v).replace(/^v/, '').split('.').map(Number);
  const [a, b] = [num(rel.version), num(cur)];
  const newer = ((a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])) > 0;
  if (!newer || !rel.windows) return;
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Jetzt aktualisieren', 'Später'], message: `Version ${rel.version} ist verfügbar.` });
  if (response !== 0) return;
  const buf = await githubDownload(rel, 'windows', fetch);
  const exe = path.join(os.tmpdir(), `LatexIDE-Setup-${rel.version}.exe`);
  fs.writeFileSync(exe, buf);
  spawn(exe, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  app.exit(0);
}
