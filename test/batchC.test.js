// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Static checks for supply-chain hardening: #192 (auto-release author check),
// #190 (compose limits), #191 (pinned actions/images), #200 (SBOM).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));

test('auto-release: author via GitHub API, verified signature, no %an', () => {
  const s = read('.github', 'workflows', 'auto-release.yml');
  assert.ok(!s.includes('%an'));
  assert.match(s, /author\.login == "dependabot\[bot\]"/);
  assert.match(s, /commit\.verification\.verified/);
  assert.match(s, /total_commits/);
});

test('compose: limits in both files', () => {
  for (const f of ['docker-compose.yml', 'docker-compose.pi.yml']) {
    const s = read(f);
    for (const k of ['mem_limit', 'cpus', 'pids_limit']) assert.match(s, new RegExp(`^    ${k}: [$][{]`, 'm'), `${f} ${k}`);
    assert.match(s, /NODE_OPTIONS: --max-old-space-size=/, f);
  }
});

test('workflows: every uses: pinned to a 40-char SHA', () => {
  for (const f of workflows) {
    for (const m of read('.github', 'workflows', f).matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)) {
      if (m[1].startsWith('./')) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
      assert.match(m[2], /# v\d/, `${f}: version comment for ${m[1]}`);
    }
  }
});

test('images pinned by digest', () => {
  for (const m of read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}$/, m[1]);
  for (const f of ['docker-compose.yml', 'docker-compose.pi.yml']) {
    for (const m of read(f).matchAll(/^\s+image:\s*(\S+)/gm)) {
      if (/^latex-(ide|collab)$/.test(m[1])) continue;
      assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${f}: ${m[1]}`);
    }
  }
  const ci = read('.github', 'workflows', 'container-image.yml');
  for (const m of ci.matchAll(/debian:bookworm\S*/g)) assert.match(m[0], /@sha256:[0-9a-f]{64}$/);
});

test('release: SPDX SBOM generated and uploaded', () => {
  const s = read('.github', 'workflows', 'release.yml');
  assert.match(s, /npm sbom --sbom-format spdx --omit dev --omit optional/);
  assert.match(s, /\.spdx\.json/);
});
