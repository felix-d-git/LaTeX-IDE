// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #109 M2: without SOURCE_URL, /source pointed at the tag of the package.json version even when
// the server ran a master snapshot, a fork or a modified checkout (AGPL-3.0 §13). Now: commit of
// the git checkout it runs from; with local changes a warning in the log and for admins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sourceInfo, gitState } = require('../server/lib/legal');
const { startServer, client } = require('./_server');

const VER = require('../package.json').version;
const SHA = 'a'.repeat(40);
const UP = 'https://github.com/felix-d-git/LaTeX-IDE';
const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

// git in a temp repo, independent of the user's global config (signing, hooks, default branch).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-src-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const emptyConfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
function git(dir, ...args) {
  const r = spawnSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function checkout(dir) {
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\nlocal/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Stand');
  return git(dir, 'rev-parse', 'HEAD');
}

test('Quell-Link: SOURCE_URL gewinnt, {version} wird ersetzt, keine Warnung', () => {
  const r = sourceInfo({ env: { SOURCE_URL: 'https://example.org/src/tree/v{version}' }, version: '1.2.3', git: { commit: SHA, changed: ['x.js'], unpushed: true } });
  assert.deepStrictEqual(r, { link: 'https://example.org/src/tree/v1.2.3', commit: null, warning: null });
});

test('Quell-Link: ohne Git-Checkout der Tag der Version (Docker-Image, Installer)', () => {
  assert.deepStrictEqual(sourceInfo({ env: {}, version: '1.2.3', git: null }), { link: `${UP}/tree/v1.2.3`, commit: null, warning: null });
  assert.strictEqual(sourceInfo({ env: { UPDATE_REPO: 'fork/LaTeX-IDE' }, version: '1.2.3', git: null }).link, 'https://github.com/fork/LaTeX-IDE/tree/v1.2.3');
});

test('Quell-Link: Git-Checkout ohne Änderungen zeigt auf den Commit, ohne Warnung', () => {
  const r = sourceInfo({ env: { UPDATE_REPO: 'fork/LaTeX-IDE' }, version: '1.2.3', git: { commit: SHA, changed: [], unpushed: false } });
  assert.deepStrictEqual(r, { link: `https://github.com/fork/LaTeX-IDE/tree/${SHA}`, commit: SHA, warning: null });
});

test('Quell-Link: lokale oder nicht gepushte Änderungen ohne SOURCE_URL ergeben eine Warnung', () => {
  const changed = ['server/a.js', 'server/b.js', 'client/c.js', 'd', 'e', 'f'];
  let r = sourceInfo({ env: {}, version: '1.2.3', git: { commit: SHA, changed, unpushed: false } });
  assert.strictEqual(r.link, `${UP}/tree/${SHA}`);
  assert.match(r.warning, /6 lokal geänderte oder neue Datei\(en\): server\/a\.js, server\/b\.js, client\/c\.js, d, e, …/);
  assert.match(r.warning, /SOURCE_URL/);
  assert.match(r.warning, /AGPL-3\.0 §13/);
  r = sourceInfo({ env: {}, version: '1.2.3', git: { commit: SHA, changed: [], unpushed: true } });
  assert.match(r.warning, new RegExp(`Commit ${SHA.slice(0, 12)} liegt auf keinem Remote-Branch und keinem Tag`));
});

test('Quell-Link: gitState liest Commit, Änderungen und Remote/Tag eines echten Checkouts', { skip: !hasGit && 'git fehlt' }, () => {
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a\n');
  assert.strictEqual(gitState(dir), null, 'kein Checkout');
  const sha = checkout(dir);
  assert.deepStrictEqual(gitState(dir), { commit: sha, changed: [], unpushed: true });
  git(dir, 'update-ref', 'refs/remotes/origin/master', sha);
  assert.deepStrictEqual(gitState(dir), { commit: sha, changed: [], unpushed: false });
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/master');
  git(dir, 'tag', `v${VER}`);
  assert.deepStrictEqual(gitState(dir), { commit: sha, changed: [], unpushed: false }, 'Release-Commit nur am Tag');
  fs.appendFileSync(path.join(dir, 'sub', 'a.txt'), 'b\n');
  fs.writeFileSync(path.join(dir, 'neu.js'), '');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'ignoriert'), '');
  assert.deepStrictEqual(gitState(dir), { commit: sha, changed: ['sub/a.txt', 'neu.js'], unpushed: false });
  // Ordner innerhalb eines anderen Checkouts (installer\out\staging) zählt nicht
  assert.strictEqual(gitState(path.join(dir, 'sub')), null);
});

test('Quell-Link: gitState ohne git-Programm ergibt null', () => {
  assert.strictEqual(gitState(tmp, () => ({ status: null, error: new Error('ENOENT') })), null);
});

test('Server: /source ohne Checkout auf den Tag, keine Warnung für Admins', async () => {
  const srv = await startServer({ UPDATE_MODE: 'off', SOURCE_URL: '', UPDATE_REPO: '' });
  try {
    const r = await fetch(`${srv.base}/source`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), `${UP}/tree/v${VER}`);
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    const u = await admin.call('GET', '/api/admin/update');
    assert.strictEqual(u.status, 200);
    assert.strictEqual(u.body.sourceWarning, undefined);
    assert.doesNotMatch(srv.log(), /\[source\]/);
  } finally {
    await srv.stop();
  }
});

test('Server: veränderter Checkout ohne SOURCE_URL verlinkt den Commit und warnt in Log und Admin-Banner', { skip: !hasGit && 'git fehlt' }, async () => {
  let sha;
  const srv = await startServer({ UPDATE_MODE: 'off', SOURCE_URL: '', UPDATE_REPO: '' }, {
    prepare: (dir) => {
      for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f)); // für /licenses
      sha = checkout(dir);
      fs.writeFileSync(path.join(dir, 'server', 'lokal.js'), '// lokale Änderung\n');
    },
  });
  try {
    const r = await fetch(`${srv.base}/source`, { redirect: 'manual' });
    assert.strictEqual(r.headers.get('location'), `${UP}/tree/${sha}`);
    const lic = await (await fetch(`${srv.base}/licenses`)).text();
    assert.ok(lic.includes(`Source code: ${UP}/tree/${sha}`));
    assert.match(srv.log(), /\[source\] Warnung: .*server\/lokal\.js/);
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    const u = await admin.call('GET', '/api/admin/update');
    assert.match(u.body.sourceWarning, /1 lokal geänderte oder neue Datei\(en\): server\/lokal\.js/);
    assert.match(u.body.sourceWarning, new RegExp(`Commit ${sha.slice(0, 12)} liegt auf keinem Remote-Branch`));
    // Nur für Admins: ohne Anmeldung kein Zugriff auf den Endpunkt
    assert.strictEqual((await client(srv.base).call('GET', '/api/admin/update')).status, 401);
  } finally {
    await srv.stop();
  }
});

test('Server: mit SOURCE_URL keine Warnung, auch bei lokalen Änderungen', { skip: !hasGit && 'git fehlt' }, async () => {
  const srv = await startServer({ UPDATE_MODE: 'off', SOURCE_URL: 'https://example.org/fork/tree/v{version}', UPDATE_REPO: '' }, {
    prepare: (dir) => {
      checkout(dir);
      fs.writeFileSync(path.join(dir, 'server', 'lokal.js'), '// lokale Änderung\n');
    },
  });
  try {
    const r = await fetch(`${srv.base}/source`, { redirect: 'manual' });
    assert.strictEqual(r.headers.get('location'), `https://example.org/fork/tree/v${VER}`);
    const admin = client(srv.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    assert.strictEqual((await admin.call('GET', '/api/admin/update')).body.sourceWarning, undefined);
    assert.doesNotMatch(srv.log(), /\[source\]/);
  } finally {
    await srv.stop();
  }
});

test('Client: Admin-Banner zeigt die Quellcode-Warnung des Servers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', 'main.js'), 'utf8');
  assert.match(main, /showSourceWarning\(u\.sourceWarning\)/);
  assert.match(main, /function showSourceWarning\(text\)/);
  assert.match(main, /id: 'source-warning', role: 'alert'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'client', 'style.css'), 'utf8'), /#source-warning\{ position: fixed/);
});

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

test('Docker: SOURCE_URL und UPDATE_REPO erreichen die Build-Stufe vor node build.js (Bundle-Banner)', () => {
  const df = read('Dockerfile');
  const start = df.indexOf(' AS build\n');
  const stage = df.slice(start, df.indexOf('\nFROM ', start));
  const run = stage.indexOf('RUN node build.js');
  assert.ok(run > 0, 'node build.js fehlt in der Build-Stufe');
  for (const a of ['SOURCE_URL', 'UPDATE_REPO']) {
    const i = stage.indexOf(`\nARG ${a}=""\n`);
    assert.ok(i > 0 && i < run, `ARG ${a} fehlt vor node build.js`);
  }
  // Laufzeit wie bisher: ARG + ENV in der finalen Stufe
  assert.match(df.slice(start + stage.length), /\nARG SOURCE_URL=""\nENV SOURCE_URL=\$\{SOURCE_URL\}\n/);
  for (const f of ['docker-compose.yml', 'docker-compose.pi.yml']) {
    const args = /\n {4}build:\n[\s\S]*?\n {6}args:\n((?: {8}.*\n)+)/.exec(read(f));
    assert.ok(args, `${f}: build.args fehlt`);
    assert.match(args[1], / {8}SOURCE_URL: \$\{SOURCE_URL:-\}\n/, f);
    assert.match(args[1], / {8}UPDATE_REPO: \$\{UPDATE_REPO:-\}\n/, f);
  }
  const ci = read('.github/workflows/container-image.yml');
  assert.match(ci, /--build-arg SOURCE_URL="\$SRC"/);
  assert.match(ci, /docker exec ide grep -qF "Source: \$SOURCE_URL" \/app\/client\/dist\/bundle\.js/);
});

test('Docker: Build ohne Checkout nimmt SOURCE_URL aus der Umgebung in den Banner', () => {
  // Wie RUN node build.js in der Build-Stufe: legal.js liest SOURCE_URL beim Laden.
  const src = 'https://github.com/owner/LaTeX-IDE/tree/0123456789abcdef0123456789abcdef01234567';
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./build.js').options.banner.js)"], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, SOURCE_URL: src, UPDATE_REPO: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(` * AGPL-3.0-only, WITHOUT ANY WARRANTY. Source: ${src}\n`), r.stdout);
});

test('Release: Desktop-Pakete bauen den Banner mit dem Repo des Laufs (Forks)', () => {
  const yml = read('.github/workflows/release.yml');
  assert.match(yml, /- name: Pakete bauen\n {8}shell: pwsh\n(?: {8}#.*\n)* {8}env:\n {10}UPDATE_REPO: \$\{\{ github\.repository \}\}\n {8}run: \.\/installer\/build-release\.ps1/);
});
