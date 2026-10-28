// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Paket P11: a manual run (workflow_dispatch) of container-image.yml on master
// pushed ghcr :<version> and clobbered the release's package list/pandoc
// sources, although it builds master, not the release commit. Runs the naming
// and push steps from the YAML in bash with a docker stub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const fwd = (p) => p.replace(/\\/g, '/');
const VER = require('../package.json').version;
const V = VER.replace(/\./g, '\\.');
const YML = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'container-image.yml'), 'utf8').replace(/\r\n/g, '\n');

// The `run:` script of the step `name` (block scalar or single line).
function runOf(name) {
  const lines = YML.split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `Schritt "${name}" fehlt`);
  while (!/^\s+run:/.test(lines[++i]));
  const one = lines[i].match(/run:[ \t]*([^|\s].*)$/);
  if (one) return one[1];
  const out = [];
  for (i++; i < lines.length && (lines[i].startsWith('          ') || !lines[i].trim()); i++) out.push(lines[i].slice(10));
  return out.join('\n');
}

function simulate(event) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-ci-'));
  test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'docker'), '#!/bin/bash\necho "docker $*" >> "$LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'gh'), '#!/bin/bash\necho "gh $*" >> "$LOG"\n', { mode: 0o755 });
  // Nur die Namensbildung aus "pandoc-Quellen sammeln" (bis vor das erste docker run).
  const naming = runOf('pandoc-Quellen sammeln').split('\ndocker run')[0];
  const script = [
    'u() { cygpath -u "$1" 2>/dev/null || echo "$1"; }',
    'export PATH="$(u "$STUBS"):$PATH" LOG="$(u "$LOGF")" GITHUB_ENV="$(u "$ENVF")"',
    `( ${naming}\n ) || exit 98`,
    'set -a; . "$GITHUB_ENV"; set +a',
    `( ${runOf('Paketliste und pandoc-Quellen an das Release haengen')}\n ) || exit 97`,
    `( ${runOf('Nach ghcr.io pushen')}\n ) || exit 96`,
  ].join('\n');
  const env = {
    ...process.env, STUBS: fwd(stubs), LOGF: fwd(path.join(tmp, 'log')), ENVF: fwd(path.join(tmp, 'env')),
    GITHUB_EVENT_NAME: event, RELEASE_RUN: event === 'release' ? 'true' : '', TAG: event === 'release' ? `v${VER}` : '', GITHUB_SHA: 'abcdef0123456789',
    GITHUB_REPOSITORY: 'Owner/LaTeX-IDE', GITHUB_ACTOR: 'x', GH_TOKEN: 't',
    GITHUB_STEP_SUMMARY: fwd(path.join(tmp, 'summary')),
  };
  fs.writeFileSync(path.join(tmp, 'env'), '');
  const r = spawnSync(BASH, ['-e', '-c', script], { env, cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return fs.readFileSync(path.join(tmp, 'log'), 'utf8');
}

test('Container-Workflow: manueller Start pusht nicht :<version> und überschreibt keine Release-Dateien', { skip: !fs.existsSync(BASH) && 'bash fehlt' }, () => {
  const log = simulate('workflow_dispatch');
  const img = 'ghcr.io/owner/latex-ide';
  assert.doesNotMatch(log, new RegExp(`docker push ${img}:${V}\\s*$`, 'm'), log);
  assert.doesNotMatch(log, /:latest/, log);
  assert.match(log, new RegExp(`docker push ${img}:${V}-abcdef0`), log);
  assert.match(log, new RegExp(`gh release upload v${V} DEBIAN-PACKAGES-v${V}-abcdef0\\.txt pandoc-sources-v${V}-abcdef0\\.tar`), log);
});

test('Container-Workflow: Release pusht :<version> und :latest', { skip: !fs.existsSync(BASH) && 'bash fehlt' }, () => {
  const log = simulate('release');
  const img = 'ghcr.io/owner/latex-ide';
  assert.match(log, new RegExp(`docker push ${img}:${V}\\s*$`, 'm'), log);
  assert.match(log, new RegExp(`docker push ${img}:latest`), log);
  assert.match(log, new RegExp(`gh release upload v${V} DEBIAN-PACKAGES-v${V}\\.txt pandoc-sources-v${V}\\.tar`), log);
});
