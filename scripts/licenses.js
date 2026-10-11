#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md from production dependencies listed in
// package-lock.json (lockfileVersion 3 "packages" map). Node stdlib only.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const OUT_PATH = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');

const ALLOWED = [
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD',
  'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'MIT-0'
];

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// MIT packages that ship without a license file. Copyright lines taken from the
// package README or the upstream repo's LICENSE (URL per entry).
const MANUAL_LICENSES = {
  // Readme.md of 1.0.x; https://github.com/tj/node-cookie-signature/blob/master/LICENSE
  'cookie-signature': `Copyright (c) 2012 LearnBoost <tj@learnboost.com>

${MIT_BODY}`,
  // https://github.com/komagata/eastasianwidth/blob/master/MIT-LICENSE.txt
  eastasianwidth: `Copyright komagata

${MIT_BODY}`,
  // README.md; https://github.com/jensyt/imurmurhash-js/blob/master/LICENSE
  imurmurhash: `Copyright (c) 2013 Gary Court, Jens Taylor

${MIT_BODY}`,
  // README.md; https://github.com/juliangruber/isarray/blob/master/LICENSE
  isarray: `Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>

${MIT_BODY}`,
};

const LICENSE_FILE_NAMES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt',
  'NOTICE', 'NOTICE.md', 'NOTICE.txt'
];

function isAllowedLicense(license) {
  if (!license) return false;
  // Split SPDX "OR" expressions, e.g. "(MIT OR Apache-2.0)"
  const cleaned = license.replace(/[()]/g, '');
  if (/ OR /i.test(cleaned)) {
    return cleaned.split(/\s+OR\s+/i).some((part) => ALLOWED.includes(part.trim()));
  }
  return ALLOWED.includes(cleaned.trim());
}

function licenseToString(licenseField) {
  if (!licenseField) return '';
  if (typeof licenseField === 'string') return licenseField;
  if (typeof licenseField === 'object' && licenseField.type) return licenseField.type;
  if (Array.isArray(licenseField)) {
    return licenseField.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return '';
}

function findLicenseFile(pkgDir) {
  let entries;
  try {
    entries = fs.readdirSync(pkgDir);
  } catch {
    return null;
  }
  for (const name of LICENSE_FILE_NAMES) {
    if (entries.includes(name)) return path.join(pkgDir, name);
  }
  // case-insensitive fallback
  const lowerMap = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const name of LICENSE_FILE_NAMES) {
    const hit = lowerMap.get(name.toLowerCase());
    if (hit) return path.join(pkgDir, hit);
  }
  // variants like LICENSE-MIT.txt (emoji-regex) or MIT-License (bagpipe)
  const variant = entries.find((e) => /^(licen[cs]e-\w+|\w+-licen[cs]e)(\.(md|txt))?$/i.test(e));
  return variant ? path.join(pkgDir, variant) : null;
}

function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const packages = lock.packages || {};

  const results = [];
  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (pkgPath === '') continue; // the project itself
    if (!pkgPath.includes('node_modules/')) continue;
    if (meta.dev) continue;
    if (meta.optional) continue; // never shipped: installer + image prune with --omit=optional

    const absDir = path.join(ROOT, pkgPath);
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
    } catch {
      continue; // not installed on disk (e.g. optional/platform-specific), skip
    }

    // derive npm package name from the path (handles scoped @scope/name)
    const segs = pkgPath.split('node_modules/');
    const name = pkgJson.name || segs[segs.length - 1];
    const version = pkgJson.version || meta.version || 'unknown';
    const license = licenseToString(pkgJson.license) || 'UNKNOWN';
    const licenseFilePath = findLicenseFile(absDir);
    const licenseText = licenseFilePath
      ? fs.readFileSync(licenseFilePath, 'utf8')
      : (license === 'MIT' && MANUAL_LICENSES[name]) || null;

    results.push({ name, version, license, licenseText, licenseFilePath });
  }

  // de-dup by name@version (a package can appear at multiple lockfile paths)
  const seen = new Map();
  for (const r of results) {
    seen.set(`${r.name}@${r.version}`, r);
  }
  const packagesFinal = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

  const problematic = packagesFinal.filter((p) => !isAllowedLicense(p.license));

  const lines = [];
  lines.push('# Third-Party Notices');
  lines.push('');
  lines.push(`This file lists production dependencies (${packagesFinal.length} packages) and their licenses.`);
  lines.push('');
  lines.push('| Package | Version | License |');
  lines.push('|---|---|---|');
  for (const p of packagesFinal) {
    lines.push(`| ${p.name} | ${p.version} | ${p.license} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const p of packagesFinal) {
    lines.push(`## ${p.name}@${p.version}`);
    lines.push('');
    lines.push(`License: ${p.license}`);
    lines.push('');
    if (p.licenseText) {
      lines.push('```');
      lines.push(p.licenseText.trimEnd());
      lines.push('```');
    } else {
      lines.push('_No LICENSE/NOTICE file found in package._');
    }
    lines.push('');
  }

  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');

  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Packages: ${packagesFinal.length}`);

  if (problematic.length > 0) {
    console.log('\nLicenses not on allow-list:');
    for (const p of problematic) {
      console.log(`  ${p.name}@${p.version}: ${p.license}`);
    }
    process.exit(1);
  }
}

main();
