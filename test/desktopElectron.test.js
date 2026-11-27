// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Desktop-App als Electron-App (#212): Sync vor dem Beenden, "nur lokal", Starthinweis, Update-Quelle,
// Datei-Argument, Electron-Sicherheitsoptionen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { syncTargets, flushAll, staleNotice } = require('../server/lib/localSync');
const { updateSource, sumFor, githubLatest, githubDownload } = require('../server/lib/desktopAssets');
const { fileArg } = require('../desktop/lib/args');
const { WEB_PREFERENCES, isOwnOrigin, externalTarget } = require('../desktop/lib/security');

const REPO = path.join(__dirname, '..');
const owned = [
  { projectId: 'a', name: 'Alpha' },
  { projectId: 'b', name: 'Beta' },
  { projectId: 'c', name: 'Gamma' },
];

// --- Sync vor dem Beenden ---

test('flushAll: online synchronisiert alle Ziele', async () => {
  const seen = [];
  const r = await flushAll(owned, async (p) => seen.push(p.name));
  assert.deepStrictEqual(seen, ['Alpha', 'Beta', 'Gamma']);
  assert.deepStrictEqual(r, { ok: true, offline: false, synced: ['Alpha', 'Beta', 'Gamma'], pending: [] });
});

test('flushAll: offline ruft nichts auf, Änderungen bleiben lokal (kein Datenverlust)', async () => {
  let calls = 0;
  const r = await flushAll(owned, async () => calls++, { online: () => false });
  assert.strictEqual(calls, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.offline, true);
  assert.deepStrictEqual(r.pending, ['Alpha', 'Beta', 'Gamma']);
});

test('flushAll: ohne Projekte ist offline kein Fehler', async () => {
  const r = await flushAll([], async () => {}, { online: () => false });
  assert.strictEqual(r.ok, true);
});

test('flushAll: normaler Fehler eines Projekts lässt die anderen laufen', async () => {
  const r = await flushAll(owned, async (p) => {
    if (p.projectId === 'b') throw new Error('kaputt');
  });
  assert.deepStrictEqual(r.synced, ['Alpha', 'Gamma']);
  assert.deepStrictEqual(r.pending, ['Beta']);
  assert.strictEqual(r.ok, false);
});

test('flushAll: Verbindungsabbruch (fatal) mitten drin bricht ab, Rest bleibt vorgemerkt', async () => {
  const r = await flushAll(owned, async (p) => {
    if (p.projectId === 'b') throw Object.assign(new Error('offline'), { fatal: true });
  });
  assert.deepStrictEqual(r.synced, ['Alpha']);
  assert.deepStrictEqual(r.pending, ['Beta', 'Gamma']);
});

test('flushAll: meldet Fortschritt', async () => {
  const prog = [];
  await flushAll(owned, async () => {}, { onProgress: (p) => prog.push(`${p.done}/${p.total}`) });
  assert.deepStrictEqual(prog, ['0/3', '1/3', '2/3', '3/3']);
});

// --- nur lokal ---

test('nur lokal: Projekt ist kein Sync-Ziel und wird nicht synchronisiert', async () => {
  const targets = syncTargets(owned, ['b']);
  assert.deepStrictEqual(targets.map((p) => p.name), ['Alpha', 'Gamma']);
  const seen = [];
  await flushAll(targets, async (p) => seen.push(p.name));
  assert.ok(!seen.includes('Beta'));
});

// --- Startmeldung ---

test('Startmeldung nennt die Server-Adresse', () => {
  assert.strictEqual(staleNotice('https://x.example'), 'Möglicherweise nicht auf dem neusten Stand – keine Verbindung zum Server https://x.example');
});

// --- Update-Quelle ---

test('Update-Quelle: Server wenn konfiguriert, sonst GitHub', () => {
  assert.deepStrictEqual(updateSource({ remote: 'https://s' }), { kind: 'server', remote: 'https://s' });
  assert.deepStrictEqual(updateSource({ remote: '' }), { kind: 'github', repo: 'felix-d-git/LaTeX-IDE' });
});

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function fakeGithub(pkg, listed = sha(pkg)) {
  return async (url) => {
    const ok = (body, json) => ({ ok: true, status: 200, json: async () => json, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
    if (url.includes('api.github.com')) {
      return ok('', {
        tag_name: 'v9.9.9',
        assets: [
          { name: 'LatexIDE-Setup.exe', browser_download_url: 'https://github.com/x/y/releases/download/v9.9.9/LatexIDE-Setup.exe' },
          { name: 'SHA256SUMS', browser_download_url: 'https://github.com/x/y/releases/download/v9.9.9/SHA256SUMS' },
        ],
      });
    }
    if (url.endsWith('SHA256SUMS')) return ok(`${listed}  LatexIDE-Setup.exe\n`);
    return ok(pkg);
  };
}

test('sumFor liest sha256sum-Zeilen', () => {
  const h = 'a'.repeat(64);
  assert.strictEqual(sumFor(`${h}  x.exe\r\n${'b'.repeat(64)} *y.zip\n`, 'y.zip'), 'b'.repeat(64));
  assert.strictEqual(sumFor(`${h}  x.exe`, 'nope'), null);
});

test('GitHub-Update: Download wird gegen SHA256SUMS geprüft', async () => {
  const pkg = Buffer.from('installer-bytes');
  const rel = await githubLatest('x/y', fakeGithub(pkg));
  assert.strictEqual(rel.version, '9.9.9');
  assert.ok((await githubDownload(rel, 'windows', fakeGithub(pkg))).equals(pkg));
});

test('GitHub-Update: abweichende Prüfsumme oder fehlendes SHA256SUMS wird abgelehnt', async () => {
  const pkg = Buffer.from('installer-bytes');
  const rel = await githubLatest('x/y', fakeGithub(pkg));
  await assert.rejects(githubDownload(rel, 'windows', fakeGithub(pkg, 'f'.repeat(64))));
  await assert.rejects(githubDownload({ ...rel, sums: null }, 'windows', fakeGithub(pkg)));
  await assert.rejects(githubDownload({ ...rel, windows: { ...rel.windows, url: 'https://evil.example/x.exe' } }, 'windows', fakeGithub(pkg)));
});

// --- Datei-Argument ---

test('fileArg: erstes .tex-Argument, absolut aufgelöst, Flags ignoriert', () => {
  const cwd = path.resolve(os.tmpdir());
  assert.strictEqual(fileArg(['--inspect', 'foo.txt', 'a.TEX', 'b.tex'], cwd), path.join(cwd, 'a.TEX'));
  assert.strictEqual(fileArg([path.join(cwd, 'x y', 'c.tex')], '/'), path.join(cwd, 'x y', 'c.tex'));
  assert.strictEqual(fileArg(['--x.tex', 'readme.md'], cwd), null);
  assert.strictEqual(fileArg([], cwd), null);
});

// --- Electron-Sicherheit ---

test('Electron: Fenster-Optionen sicher', () => {
  assert.strictEqual(WEB_PREFERENCES.contextIsolation, true);
  assert.strictEqual(WEB_PREFERENCES.nodeIntegration, false);
  assert.strictEqual(WEB_PREFERENCES.sandbox, true);
  assert.strictEqual(WEB_PREFERENCES.webviewTag, false);
  assert.ok(isOwnOrigin('http://localhost:3178/x', 3178));
  assert.ok(!isOwnOrigin('http://localhost:3179/', 3178));
  assert.ok(!isOwnOrigin('https://localhost:3178/', 3178));
  assert.ok(!isOwnOrigin('http://evil.example:3178/', 3178));
  assert.strictEqual(externalTarget('file:///c:/windows'), null);
  assert.strictEqual(externalTarget('javascript:alert(1)'), null);
  assert.ok(externalTarget('https://example.org/a'));
});

test('Electron: main.js statisch - Wächter, Fensteroptionen aus security.js, kein nodeIntegration', () => {
  const main = fs.readFileSync(path.join(REPO, 'desktop', 'main.js'), 'utf8');
  const sec = fs.readFileSync(path.join(REPO, 'desktop', 'lib', 'security.js'), 'utf8');
  for (const src of [main, sec]) {
    assert.ok(!/nodeIntegration\s*:\s*true/.test(src));
    assert.ok(!/contextIsolation\s*:\s*false/.test(src));
    assert.ok(!/sandbox\s*:\s*false/.test(src));
    assert.ok(!/webSecurity\s*:\s*false/.test(src));
  }
  assert.ok(/contextIsolation:\s*true/.test(sec) && /nodeIntegration:\s*false/.test(sec) && /sandbox:\s*true/.test(sec));
  assert.ok(/setWindowOpenHandler/.test(main) && /will-navigate/.test(main) && /will-redirect/.test(main));
  assert.ok(/requestSingleInstanceLock/.test(main) && /second-instance/.test(main));
  assert.ok(/webPreferences:\s*WEB_PREFERENCES/.test(main));
});

// --- Desktop-Proxy ohne Verbindung (Startmeldung + nur lokal über die API) ---

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test('Desktop ohne Verbindung: Startmeldung mit Adresse, "nur lokal" per API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-electron-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'lide_test' }));
  const port = await freePort();
  const dead = `http://127.0.0.1:${await freePort()}`; // nichts hört zu
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'desktop.js')], {
    env: { ...process.env, PORT: String(port), LATEX_IDE_DATA: data, LATEX_IDE_LOCAL: path.join(dir, 'local'), REMOTE_URL: dead, LOCAL_NO_BROWSER: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; !fs.existsSync(path.join(data, '.launch-key')); i++) {
    if (i > 150) throw new Error('Desktop startet nicht');
    await new Promise((r) => setTimeout(r, 100));
  }
  const csrf = 'c'.repeat(48);
  const key = fs.readFileSync(path.join(data, '.launch-key'), 'utf8').trim();
  const call = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { cookie: `csrfToken=${csrf}; lideLocal=${key}`, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const info = await call('GET', '/api/desktop/info');
  assert.strictEqual(info.json.online, false);
  assert.strictEqual(info.json.staleNotice, staleNotice(dead));
  assert.strictEqual(info.json.updateSource, 'server');
  assert.deepStrictEqual(info.json.localOnly, []);

  assert.strictEqual((await call('POST', '/api/desktop/project-sync', { projectId: 'p1', enabled: 'ja' })).status, 400);
  assert.deepStrictEqual((await call('POST', '/api/desktop/project-sync', { projectId: 'p1', enabled: false })).json.localOnly, ['p1']);
  assert.deepStrictEqual((await call('GET', '/api/desktop/info')).json.localOnly, ['p1']);
  assert.deepStrictEqual((await call('POST', '/api/desktop/project-sync', { projectId: 'p1', enabled: true })).json.localOnly, []);
});

// --- Installer ---

test('Installer: Electron-Version im macOS-Skript = package.json, .tex-Zuordnung im Windows-Setup', () => {
  const ver = require('../package.json').devDependencies.electron.replace(/^[^0-9]*/, '');
  const mac = fs.readFileSync(path.join(REPO, 'installer', 'macos', 'install.command'), 'utf8');
  assert.ok(mac.includes(`ELECTRON_VERSION="${ver}"`));
  const iss = fs.readFileSync(path.join(REPO, 'installer', 'windows', 'LatexIDE.iss'), 'utf8');
  assert.ok(/ChangesAssociations=yes/.test(iss) && /OpenWithProgids/.test(iss));
  assert.ok(/electron-runtime/.test(fs.readFileSync(path.join(REPO, 'installer', 'build-release.ps1'), 'utf8')));
});
