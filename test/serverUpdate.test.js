// Paket P11 (#54): server-update.sh copies the new release over itself while
// running. Bash then read on at the old byte offset in the new file -> syntax
// error, no rebuild, .release stays old, exit code 0. Runs the script in a temp
// APP_DIR with stubs for curl and docker (never the real network or Docker).
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

test('server-update.sh: neues Release mit längerem Skriptkopf -> Update läuft komplett durch (#54)', { skip: !fs.existsSync(BASH) && 'bash fehlt' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-update-'));
  test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'server-update.sh'), 'utf8');

  const app = path.join(tmp, 'app');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(app, 'scripts', 'server-update.sh'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(app, '.release'), 'v0.5.1\n');
  fs.writeFileSync(path.join(data, 'auth-data.json'), '{}');

  // Release: dasselbe Skript mit drei zusätzlichen Kommentarzeilen am Anfang.
  const newScript = script.replace('\n', '\n# neu 1\n# neu 2\n# neu 3\n');
  const rel = path.join(tmp, 'release');
  fs.mkdirSync(path.join(rel, 'repo', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(rel, 'repo', 'scripts', 'server-update.sh'), newScript, { mode: 0o755 });
  fs.writeFileSync(path.join(rel, 'repo', 'NEU.txt'), 'x');

  const stubs = path.join(tmp, 'stubs');
  exe(path.join(stubs, 'curl'), [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -H) shift ;; -*) ;; *) url="$1" ;; esac; shift; done',
    'case "$url" in',
    '  */releases/latest) echo \'{"tag_name": "v9.9.9"}\' ;;',
    '  */tarball/v9.9.9) (cd "$REL" && tar -czf - repo) > "$out" ;;',
    '  *) exit 22 ;;',
    'esac',
  ].join('\n'));
  exe(path.join(stubs, 'docker'), 'echo "$*" >> "$APP_DIR/docker-aufrufe"');

  const env = { ...process.env, STUBS: fwd(stubs), APP: fwd(app), DATA: fwd(data), RELD: fwd(rel), GITHUB_TOKEN: '' };
  delete env.COMPOSE;
  // Pfade in bash umwandeln (Windows), PATH auf die Stubs, nie echtes curl/docker.
  const r = spawnSync(BASH, ['-c', [
    'u() { cygpath -u "$1" 2>/dev/null || echo "$1"; }',
    'S="$(u "$STUBS")"; export PATH="$S:$PATH" APP_DIR="$(u "$APP")" DATA_DIR="$(u "$DATA")" REL="$(u "$RELD")"',
    '[ "$(command -v curl)" = "$S/curl" ] && [ "$(command -v docker)" = "$S/docker" ] || exit 99',
    'exec bash "$APP_DIR/scripts/server-update.sh"',
  ].join('\n')], { env, encoding: 'utf8', timeout: 60000 });

  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /syntax error|command not found/, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(app, 'scripts', 'server-update.sh'), 'utf8'), newScript, 'neuer Quellstand nicht entpackt');
  assert.ok(fs.existsSync(path.join(app, 'docker-aufrufe')), 'kein Neubau (docker nie aufgerufen)');
  assert.strictEqual(fs.readFileSync(path.join(app, '.release'), 'utf8').trim(), 'v9.9.9');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, '.update-status'), 'utf8')).state, 'done');
});
