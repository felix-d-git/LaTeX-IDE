// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// installer/macos/install.command mit umgebogenem HOME und Stubs für
// uname/curl/sudo ausführen (kein Mac nötig, nur bash).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Unter Windows nur Git Bash, nie das WSL-bash aus System32.
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const fwd = (p) => p.replace(/\\/g, '/');

function exe(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
}

test('install.command kopiert node_modules und alle Paketeinträge', { skip: !fs.existsSync(BASH) && 'bash fehlt' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-inst-'));
  try {
    // Entpacktes Paket nachbauen
    const pkg = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(pkg, 'server'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'server', 'desktop.js'), '');
    fs.writeFileSync(path.join(pkg, 'server.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'NEUE-DATEI.txt'), 'x');
    for (const m of ['express', 'ws', 'http-proxy']) {
      fs.mkdirSync(path.join(pkg, 'node_modules', m), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'node_modules', m, 'index.js'), '');
    }
    fs.copyFileSync(path.join(ROOT, 'installer', 'macos', 'install.command'), path.join(pkg, 'install.command'));

    const home = path.join(tmp, 'home');
    // Vorhandenes Node -> Download wird übersprungen; leitet an das echte Node weiter
    exe(path.join(home, 'Applications', 'LatexIDE', 'node', 'bin', 'node'), `exec "${fwd(process.execPath)}" "$@"`);
    const stubs = path.join(tmp, 'stubs');
    exe(path.join(stubs, 'uname'), 'echo arm64');
    // curl: -o <datei> anlegen, sonst Erfolg
    exe(path.join(stubs, 'curl'), 'while [ $# -gt 0 ]; do [ "$1" = -o ] && { : > "$2"; shift; }; shift; done; exit 0');
    exe(path.join(stubs, 'sudo'), 'exit 0');

    const env = { ...process.env, HOME: fwd(home), STUBS: fwd(stubs) };
    // PATH erst in bash setzen (Windows-PATH-Umwandlung), und nie mit echtem curl laufen
    const run = () => spawnSync(BASH, ['-c', 'S="$(cygpath -u "$STUBS" 2>/dev/null || echo "$STUBS")"; export PATH="$S:$PATH"; [ "$(command -v curl)" = "$S/curl" ] || exit 99; exec bash "$0"', fwd(path.join(pkg, 'install.command'))], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    const r = run();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const app = path.join(home, 'Applications', 'LatexIDE', 'app');
    assert.ok(fs.existsSync(path.join(app, 'node_modules', 'express', 'index.js')), 'node_modules fehlt');
    assert.ok(fs.existsSync(path.join(app, 'NEUE-DATEI.txt')), 'nicht alle Einträge kopiert');
    assert.ok(fs.existsSync(path.join(app, 'server.json')));
    assert.ok(!fs.existsSync(path.join(app, 'install.command')));

    // Paket ohne node_modules -> Abbruch statt kaputter Installation
    fs.rmSync(path.join(pkg, 'node_modules'), { recursive: true });
    const r2 = run();
    assert.notStrictEqual(r2.status, 0);
    assert.match(r2.stderr, /node_modules/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
