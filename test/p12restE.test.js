// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// P12-Rest E (#64): INSTALL_KIND, Dockerfile labels, release.yml draft flow, own session store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

test('Windows-Installer setzt INSTALL_KIND=windows, Server und Client werten es aus', () => {
  assert.match(read('installer', 'windows', 'LatexIDE.iss'), /'INSTALL_KIND=windows'/);
  assert.match(read('installer', 'windows', 'LatexIDE-Server.cmd'), /INSTALL_KIND=windows/);
  const srv = read('server', 'index.js');
  assert.match(srv, /installKind: INSTALL_KIND/);
  assert.match(srv, /releases\/download\/v\$\{rel\.version\}\/LatexIDE-Setup\.exe/);
  for (const f of ['main.js', 'profileDialog.js']) {
    const c = read('client', 'src', f);
    assert.match(c, /installKind === 'windows'/);
    assert.match(c, /setupUrl/);
  }
});

test('Dockerfile hat keinen festen Repo-Namen, container-image.yml setzt die Labels', () => {
  const df = read('Dockerfile');
  assert.doesNotMatch(df, /felix-d-git/);
  assert.match(df, /ARG IMAGE_SOURCE/);
  assert.match(df, /image\.source="\$\{IMAGE_SOURCE\}"/);
  const yml = read('.github', 'workflows', 'container-image.yml');
  assert.match(yml, /--build-arg IMAGE_SOURCE="https:\/\/github\.com\/\$GITHUB_REPOSITORY"/);
  assert.match(yml, /--build-arg IMAGE_AUTHORS=/);
});

test('release.yml: Entwurf -> Pruefung -> Assets -> Veroeffentlichen -> Container-Image', () => {
  const yml = read('.github', 'workflows', 'release.yml');
  assert.doesNotMatch(yml, /types: \[published\]/);
  assert.match(yml, /tags: \['v\*'\]/);
  const at = (re) => { const m = yml.search(re); assert.ok(m >= 0, `${re} fehlt`); return m; };
  const order = [
    /Tag passt zu package\.json/,
    /gh release create .*--draft/,
    /Pakete bauen/,
    /gh release upload \$env:TAG installer\/out\/LatexIDE-Setup\.exe/,
    /--draft=false/,
    /uses: \.\/\.github\/workflows\/container-image\.yml/,
  ].map(at);
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  assert.match(yml, /publish:\n    needs: \[desktop, macos\]/);
  assert.match(yml, /container:\n    needs: publish/);
  // container-image.yml muss aufrufbar sein und den Tag uebernehmen
  const c = read('.github', 'workflows', 'container-image.yml');
  assert.match(c, /workflow_call:/);
  assert.match(c, /TAG: \$\{\{ inputs\.tag \|\| github\.event\.release\.tag_name \}\}/);
});

test('Session-Store: Login ueberlebt Server-Neustart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sess-'));
  process.env.DATA_DIR = dir;
  const boot = async () => {
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}lib${path.sep}`)) delete require.cache[k];
    const express = require('express');
    const mw = require('../server/lib/authMiddleware');
    const app = express();
    app.use(mw.createSessionMiddleware());
    app.get('/login', (req, res) => { req.session.userId = 'u1'; res.send('ok'); });
    app.get('/me', (req, res) => res.send(req.session.userId || 'none'));
    return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  };
  const get = (server, p, cookie) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: cookie ? { cookie } : {} }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ body: b, cookie: (res.headers['set-cookie'] || [])[0] }));
    }).on('error', reject);
  });
  const s1 = await boot();
  const cookie = (await get(s1, '/login')).cookie.split(';')[0];
  assert.strictEqual((await get(s1, '/me', cookie)).body, 'u1');
  s1.close();
  const s2 = await boot(); // frischer Modulzustand, gleiche Dateien
  assert.strictEqual((await get(s2, '/me', cookie)).body, 'u1');
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Session-Store: abgelaufene Sessions werden entfernt, alte session-file-store-Dateien lesbar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-sess-'));
  const Store = require('../server/lib/sessionStore');
  const now = Date.now();
  // Format des bisherigen session-file-store: Session + __lastAccess
  const put = (n, o) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(o));
  put('alt', { cookie: { originalMaxAge: null }, userId: 'u9', __lastAccess: now - 1000 });
  put('abgelaufen', { cookie: { originalMaxAge: null }, userId: 'u8', __lastAccess: now - 8 * 24 * 3600e3 });
  put('remember', { cookie: { originalMaxAge: 1000 }, userId: 'u7', __lastAccess: now - 5000 });
  fs.writeFileSync(path.join(dir, 'kaputt.json'), '{nope');
  const store = new Store({ path: dir, ttl: 7 * 24 * 3600, reapInterval: -1 }); // reapt beim Start
  assert.deepStrictEqual(fs.readdirSync(dir), ['alt.json']);
  store.get('alt', (e, s) => { assert.strictEqual(s.userId, 'u9'); assert.strictEqual(s.__lastAccess, undefined); });
  store.set('../boese', { userId: 'x' }, (e) => assert.ok(e));
  store.set('neu', { cookie: { originalMaxAge: 1 }, userId: 'u1' }, (e) => assert.ifError(e));
  const t = Date.now() + 20;
  while (Date.now() < t); // cookie.originalMaxAge 1 ms
  store.get('neu', (e, s) => assert.strictEqual(s, null));
  assert.ok(!fs.existsSync(path.join(dir, 'neu.json')), 'abgelaufene Datei beim Lesen geloescht');
  store.destroy('alt', () => {});
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
