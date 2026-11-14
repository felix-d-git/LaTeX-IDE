// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Lizenz- und Quellcode-Hinweise (AGPL-3.0-only §5, §13) für Server, Desktop-App und Bundle-Banner.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { version: VERSION } = require('../../package.json');
const COPYRIGHT = 'Copyright (C) 2026 felix-d-git and LaTeX-IDE contributors';
const DEFAULT_REPO = 'felix-d-git/LaTeX-IDE';
const UPDATE_REPO = process.env.UPDATE_REPO || DEFAULT_REPO;
// Wer veränderten Code betreibt oder weitergibt, muss SOURCE_URL auf den eigenen,
// vollständigen Quellcode dieses Stands setzen (AGPL §13 bzw. §6).
const SOURCE_URL = process.env.SOURCE_URL || `https://github.com/${UPDATE_REPO}`;

// owner/name of a GitHub remote URL (https, ssh, scp-like git@github.com:owner/name), else null.
function githubRepo(url) {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[\w.-]+@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Commit and local changes when root is the top level of a git checkout (start.sh/start.bat,
// npm start, node build.js in a clone); null without git or checkout (Docker image, installer:
// .git is not shipped, installer\out\staging only lies inside the repo). Read-only: no index
// refresh (GIT_OPTIONAL_LOCKS=0), no fsmonitor hook.
// repos: GitHub repos (owner/name) of the remotes with a remote-tracking branch that contains the
// commit; released: the tag v<version> points at it (the release commit only sits on its tag).
// Other remotes (GitLab, own server) and other tags do not count: /source links to GitHub.
function gitState(root, { run = spawnSync, version = VERSION } = {}) {
  // No .git (folder, or file in a worktree) = no checkout, so git is not started at all. On macOS
  // /usr/bin/git is a stub that asks to install the Command Line Tools when they are missing.
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const git = (...args) => {
    const r = run('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return r && r.status === 0 && typeof r.stdout === 'string' ? r.stdout.replace(/\s+$/, '') : null;
  };
  // "" = root is the top level, "installer/out/staging/" = a folder inside another checkout.
  if (git('rev-parse', '--show-prefix') !== '') return null;
  const commit = git('rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (!commit || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return null;
  const status = git('status', '--porcelain', '--untracked-files=normal');
  if (status === null) return null;
  const changed = status.split('\n').filter(Boolean).map((l) => l.slice(3));
  // Fetch URLs with url.<base>.insteadOf applied; remote names may contain "/".
  const remotes = [];
  for (const line of (git('remote', '-v') || '').split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    if (m) remotes.push({ name: m[1], repo: githubRepo(m[2]) });
  }
  const tag = `refs/tags/v${version}`;
  const refs = git('for-each-ref', '--contains', commit, '--format=%(refname) %(objectname) %(*objectname)', 'refs/remotes', tag);
  if (refs === null) return null;
  const repos = [];
  let released = false;
  for (const line of refs.split('\n').filter(Boolean)) {
    const [ref, obj, peeled] = line.split(' ');
    if (ref === tag) { released = (peeled || obj) === commit; continue; }
    const remote = remotes.filter((r) => ref.startsWith(`refs/remotes/${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (remote && remote.repo && !repos.includes(remote.repo)) repos.push(remote.repo);
  }
  return { commit, changed, repos, released };
}

// Link build.js put into the bundle banner (client/dist/source.json). Installed packages and images
// have no .git: /source then shows the same link as the banner, e.g. the fork a release was built
// from (release.yml sets UPDATE_REPO for the build only).
function builtLink(root, version) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(root, 'client', 'dist', 'source.json'), 'utf8'));
    return b && b.version === version && typeof b.link === 'string' && /^https:\/\/\S+$/.test(b.link) ? b.link : null;
  } catch {
    return null;
  }
}

// Where /source points: SOURCE_URL ({version} = running version) or, without it, the commit of
// the git checkout this runs from, else the link of the client build, else the tag of the
// package.json version. warning: the running code may differ from what the link shows
// (uncommitted changes, commit not on GitHub) and SOURCE_URL is not set.
function sourceInfo({ env = process.env, version = VERSION, git, built } = {}) {
  if (env.SOURCE_URL) return { link: env.SOURCE_URL.replaceAll('{version}', version), commit: null, warning: null };
  const repo = env.UPDATE_REPO || DEFAULT_REPO;
  const state = git === undefined ? gitState(ROOT, { version }) : git;
  if (!state) {
    const fromBuild = built === undefined ? builtLink(ROOT, version) : built;
    return { link: fromBuild || `https://github.com/${repo}/tree/v${version}`, commit: null, warning: null };
  }
  // The GitHub repo that has the commit: UPDATE_REPO, else another GitHub remote (fork).
  const pushed = state.repos.find((r) => r.toLowerCase() === repo.toLowerCase()) || state.repos[0];
  const link = `https://github.com/${pushed || repo}/tree/${state.commit}`;
  const why = [];
  if (state.changed.length) {
    const shown = state.changed.slice(0, 5).join(', ') + (state.changed.length > 5 ? ', …' : '');
    why.push(`${state.changed.length} lokal geänderte oder neue Datei(en): ${shown}`);
  }
  if (!pushed && !state.released) {
    why.push(`Commit ${state.commit.slice(0, 12)} liegt auf keinem Remote-Branch eines GitHub-Repos und ist nicht der Release-Tag v${version}`);
  }
  const warning = why.length
    ? `Quellcode-Link ${link} zeigt nicht den laufenden Stand (${why.join('; ')}). `
      + 'Wer diesen Server anderen anbietet, muss SOURCE_URL in .env auf den vollständigen Quellcode dieses Stands setzen (AGPL-3.0 §13).'
    : null;
  return { link, commit: state.commit, warning };
}

const SOURCE = sourceInfo();
const SOURCE_LINK = SOURCE.link;
const SOURCE_WARNING = SOURCE.warning;

// GET /licenses: eigener Hinweis, dann LICENSE und THIRD_PARTY_NOTICES.md (Klartext).
function licensesText() {
  const header = [
    `LaTeX-IDE ${VERSION}`,
    COPYRIGHT,
    '',
    'This program is free software: you can redistribute it and/or modify',
    'it under the terms of the GNU Affero General Public License as published by',
    'the Free Software Foundation, version 3 only (SPDX: AGPL-3.0-only).',
    '',
    'This program is distributed in the hope that it will be useful,',
    'but WITHOUT ANY WARRANTY; without even the implied warranty of',
    'MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the',
    'GNU Affero General Public License below for more details.',
    '',
    `Source code: ${SOURCE_LINK}`,
    'Third-party components: see the notices after the license text.',
  ].join('\n');
  const files = ['LICENSE', 'THIRD_PARTY_NOTICES.md'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return [header, ...files].join('\n\n' + '='.repeat(72) + '\n\n');
}

module.exports = { VERSION, COPYRIGHT, UPDATE_REPO, SOURCE_URL, SOURCE_LINK, SOURCE_WARNING, licensesText, githubRepo, gitState, builtLink, sourceInfo };
