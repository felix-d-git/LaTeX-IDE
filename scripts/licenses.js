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
  'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0'
];

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
  return null;
}

function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const packages = lock.packages || {};

  const results = [];
  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (pkgPath === '') continue; // the project itself
    if (!pkgPath.includes('node_modules/')) continue;
    if (meta.dev) continue;
    if (meta.optional && !fs.existsSync(path.join(ROOT, pkgPath))) continue;

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
    const licenseText = licenseFilePath ? fs.readFileSync(licenseFilePath, 'utf8') : null;

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
