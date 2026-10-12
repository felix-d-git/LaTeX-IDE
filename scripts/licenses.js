#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md from production dependencies listed in
// package-lock.json (lockfileVersion 3 "packages" map). Node stdlib only.
//
//   node scripts/licenses.js [--root <dir>] [--out <file>] [--check]
//
//   --root   directory with package-lock.json and node_modules (default: repo root)
//   --out    output file (default: <root>/THIRD_PARTY_NOTICES.md)
//   --check  write nothing, exit 1 if the output file is not up to date
'use strict';

const fs = require('fs');
const path = require('path');

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

// https://openfontlicense.org/documents/OFL.txt, from the dashed title line on
const OFL_BODY = `-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`;

// Readme.md of 1.0.x; https://github.com/tj/node-cookie-signature/blob/master/LICENSE
const COOKIE_SIGNATURE_1_0 = `Copyright (c) 2012 LearnBoost <tj@learnboost.com>

${MIT_BODY}`;

// MIT packages that ship without a license file, keyed by name@version so a new
// version gets checked again. Copyright lines taken from the package README or
// the upstream repo's LICENSE (URL per entry).
const MANUAL_LICENSES = {
  'cookie-signature@1.0.6': COOKIE_SIGNATURE_1_0,
  'cookie-signature@1.0.7': COOKIE_SIGNATURE_1_0,
  // https://github.com/komagata/eastasianwidth/blob/master/MIT-LICENSE.txt
  'eastasianwidth@0.2.0': `Copyright komagata

${MIT_BODY}`,
  // README.md; https://github.com/jensyt/imurmurhash-js/blob/master/LICENSE
  'imurmurhash@0.1.4': `Copyright (c) 2013 Gary Court, Jens Taylor

${MIT_BODY}`,
  // README.md; https://github.com/juliangruber/isarray/blob/master/LICENSE
  'isarray@1.0.0': `Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>

${MIT_BODY}`,
};

// Notices the package's own license file does not carry. Each entry was checked
// against one exact version; any other version stops the script until the texts
// are re-checked. Fields: version, displayLicense (table text when parts of the
// package use other licenses), copyrightFrom (file whose @licstart header holds
// the copyright line put before the license text), notices [{ title, note, text }].

// Third-party code compiled into the package's build files.
const EMBEDDED_NOTICES = {
  // https://github.com/mozilla/pdf.js/blob/v4.10.38/external/openjpeg/README.md
  'pdfjs-dist': {
    version: '4.10.38',
    displayLicense: 'Apache-2.0; BSD-2-Clause (embedded OpenJPEG); MIT (embedded Emscripten runtime, musl)',
    copyrightFrom: 'build/pdf.mjs',
    notices: [
      {
        title: 'Embedded: OpenJPEG (BSD-2-Clause)',
        note: 'JPEG 2000 decoder, compiled to WebAssembly in build/pdf.worker*.mjs, image_decoders/ and their '
          + 'legacy/ copies (sent to the browser as client/dist/pdf.worker.min.mjs). '
          + 'See https://github.com/mozilla/pdf.js/blob/v4.10.38/external/openjpeg/README.md',
        // https://github.com/uclouvain/openjpeg/blob/master/LICENSE (trailing blanks dropped)
        text: `/*
 * The copyright in this software is being made available under the 2-clauses
 * BSD License, included below. This software may be subject to other third
 * party and contributor rights, including patent rights, and no such rights
 * are granted under this license.
 *
 * Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium
 * Copyright (c) 2002-2014, Professor Benoit Macq
 * Copyright (c) 2003-2014, Antonin Descampe
 * Copyright (c) 2003-2009, Francois-Olivier Devaux
 * Copyright (c) 2005, Herve Drolon, FreeImage Team
 * Copyright (c) 2002-2003, Yannick Verschueren
 * Copyright (c) 2001-2003, David Janssens
 * Copyright (c) 2011-2012, Centre National d'Etudes Spatiales (CNES), France
 * Copyright (c) 2012, CS Systemes d'Information, France
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \`AS IS'
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */`,
      },
      {
        title: 'Embedded: pdf.js.openjpeg (BSD-2-Clause)',
        note: 'Wrapper that builds OpenJPEG for pdf.js, compiled into the same files. '
          + 'See https://github.com/mozilla/pdf.js.openjpeg',
        // https://github.com/mozilla/pdf.js.openjpeg/blob/main/LICENSE
        text: `Copyright (c) 2024, Mozilla Foundation

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
      },
      {
        title: 'Embedded: Emscripten runtime (MIT)',
        note: 'JavaScript glue and runtime code generated by Emscripten when compiling OpenJPEG to WebAssembly, '
          + 'in the same files. Emscripten is dual-licensed MIT / University of Illinois/NCSA; used here under MIT. '
          + 'See https://github.com/emscripten-core/emscripten/blob/main/LICENSE',
        // https://github.com/emscripten-core/emscripten/blob/main/LICENSE (MIT part)
        text: `Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`,
      },
      {
        title: 'Embedded: musl libc (MIT)',
        note: 'Parts of the C library bundled with Emscripten, compiled into the OpenJPEG WebAssembly module. '
          + 'See https://git.musl-libc.org/cgit/musl/tree/COPYRIGHT',
        // https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT (license part)
        text: `Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
      },
    ],
  },
};

// Parts of the package under other licenses than its LICENSE file.
const EXTRA_NOTICES = {
  katex: {
    version: '0.16.47',
    displayLicense: 'MIT (code); OFL-1.1 (fonts); Apache-2.0 (contrib/mhchem)',
    notices: [
      {
        title: 'Fonts: dist/fonts/KaTeX_* (OFL-1.1)',
        note: 'Copyright lines and Reserved Font Names from the font metadata (name table, license description).',
        text: `Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)
Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>),
with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur,
KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1,
KaTeX_Size2, KaTeX_Size3, KaTeX_Size4 and KaTeX_Typewriter.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

${OFL_BODY}`,
      },
      {
        title: 'contrib/mhchem (Apache-2.0)',
        note: 'contrib/mhchem/mhchem.js and dist/contrib/mhchem.*, adapted from MathJax/extensions/TeX/mhchem.js. '
          + 'The full text of the Apache License, Version 2.0 is reproduced in this file under pdfjs-dist.',
        // dist/contrib/mhchem.js:111-124
        text: `Copyright (c) 2011-2015 The MathJax Consortium
Copyright (c) 2015-2018 Martin Hensel

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`,
      },
    ],
  },
};

const LICENSE_FILE_NAMES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt'
];
// Appended under their own heading, in addition to the license file.
const NOTICE_FILE_RE = /^notice(\.(md|txt))?$/i;

function parseArgs(argv) {
  const opts = { root: path.resolve(__dirname, '..'), out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if ((a === '--root' || a === '--out') && argv[i + 1]) opts[a.slice(2)] = path.resolve(argv[++i]);
    else {
      console.error(`Unknown or incomplete option: ${a}`);
      console.error('Usage: node scripts/licenses.js [--root <dir>] [--out <file>] [--check]');
      process.exit(1);
    }
  }
  if (!opts.out) opts.out = path.join(opts.root, 'THIRD_PARTY_NOTICES.md');
  return opts;
}

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

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function listDir(pkgDir) {
  try {
    return fs.readdirSync(pkgDir).sort(); // sorted: readdir order differs between file systems
  } catch {
    return [];
  }
}

function findLicenseFile(pkgDir, entries) {
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

// Copyright line of the "@licstart ... @licend" header, e.g. "Copyright 2024 Mozilla Foundation".
function licstartCopyright(file) {
  let src;
  try {
    src = readText(file);
  } catch {
    return null;
  }
  const block = /@licstart[\s\S]*?@licend/.exec(src);
  const line = block && /^\s*\*\s*(Copyright .+?)\s*$/m.exec(block[0]);
  return line ? line[1] : null;
}

function compareSemver(a, b) {
  const re = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d;
  }
  if (!ma[4] || !mb[4]) return (ma[4] ? -1 : 0) + (mb[4] ? 1 : 0); // release > prerelease
  const pa = ma[4].split('.');
  const pb = mb[4].split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function collect(root, errors) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const byId = new Map();
  for (const [pkgPath, meta] of Object.entries(lock.packages || {})) {
    if (pkgPath === '') continue; // the project itself
    if (!pkgPath.includes('node_modules/')) continue;
    // Decided from the lockfile alone, so installed platform binaries never change
    // the output. Never shipped: installer and image prune with --omit=dev
    // --omit=optional (image: multi-stage, build stage not shipped).
    if (meta.dev || meta.optional || meta.devOptional) continue;

    // npm package name from the path (handles scoped @scope/name); aliases carry "name"
    const name = meta.name || pkgPath.slice(pkgPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const id = `${name}@${meta.version}`;
    const absDir = path.join(root, pkgPath);
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8'));
    } catch {
      errors.push(`${id}: not installed at ${pkgPath} (run npm ci)`);
      continue;
    }
    if (pkgJson.name !== name || pkgJson.version !== meta.version) {
      errors.push(`${id}: ${pkgPath} holds ${pkgJson.name}@${pkgJson.version} (run npm ci)`);
      continue;
    }
    if (byId.has(id)) continue; // a package can appear at multiple lockfile paths

    const license = licenseToString(pkgJson.license) || 'UNKNOWN';
    const entries = listDir(absDir);
    const licenseFile = findLicenseFile(absDir, entries);
    const licenseText = licenseFile
      ? readText(licenseFile)
      : (license === 'MIT' && MANUAL_LICENSES[id]) || null;
    if (!licenseText) errors.push(`${id}: no license text found (add it to MANUAL_LICENSES)`);
    const noticeFiles = entries
      .filter((e) => NOTICE_FILE_RE.test(e))
      .map((e) => ({ title: e, text: readText(path.join(absDir, e)) }));

    byId.set(id, { name, version: meta.version, license, licenseText, noticeFiles, absDir });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || compareSemver(a.version, b.version));
}

function applyNotices(packages, errors) {
  for (const [mapName, map] of [['EMBEDDED_NOTICES', EMBEDDED_NOTICES], ['EXTRA_NOTICES', EXTRA_NOTICES]]) {
    for (const [name, entry] of Object.entries(map)) {
      const hits = packages.filter((p) => p.name === name);
      if (hits.length === 0) errors.push(`${mapName}.${name}: not a production package any more`);
      for (const p of hits) {
        if (p.version !== entry.version) {
          errors.push(`${name}@${p.version}: ${mapName}.${name} was checked for ${entry.version}; re-check its texts and update the entry`);
          continue;
        }
        if (entry.displayLicense) p.displayLicense = entry.displayLicense;
        if (entry.copyrightFrom) {
          const line = licstartCopyright(path.join(p.absDir, entry.copyrightFrom));
          if (line) p.copyrightLine = line;
          else errors.push(`${name}@${p.version}: no @licstart copyright line in ${entry.copyrightFrom}`);
        }
        p.extraNotices = (p.extraNotices || []).concat(entry.notices || []);
      }
    }
  }
}

function render(packages) {
  const lines = [];
  const block = (text) => lines.push('```', text.trimEnd(), '```', '');
  lines.push('# Third-Party Notices');
  lines.push('');
  lines.push('latex-web-ide is licensed under AGPL-3.0-only (see LICENSE). That license covers only');
  lines.push("the project's own code. The third-party packages listed here keep their own licenses,");
  lines.push('reproduced below.');
  lines.push('');
  lines.push(`Scope: the npm packages the app ships (${packages.length} packages), i.e. the production`);
  lines.push('dependencies from package-lock.json without dev and optional packages, as left by');
  lines.push('`npm prune --omit=dev --omit=optional`. This includes the code bundled into client/dist.');
  lines.push('Generated by scripts/licenses.js, do not edit by hand.');
  lines.push('');
  lines.push('Not covered here:');
  lines.push('- Desktop installer packages (Node.js, TeX distributions): see LICENSES-INSTALLER.txt');
  lines.push('  (in the repository: installer/LICENSES-INSTALLER.txt). The Windows package ships');
  lines.push('  Node.js with its license in `node\\LICENSE`.');
  lines.push('- Docker image: Debian packages, listed with exact versions in /app/DEBIAN-PACKAGES.txt');
  lines.push('  inside the image (see docs/INSTALL-DOCKER.md).');
  lines.push('');
  lines.push('| Package | Version | License |');
  lines.push('|---|---|---|');
  for (const p of packages) {
    lines.push(`| ${p.name} | ${p.version} | ${p.displayLicense || p.license} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const p of packages) {
    lines.push(`## ${p.name}@${p.version}`);
    lines.push('');
    lines.push(`License: ${p.displayLicense || p.license}`);
    lines.push('');
    block(p.copyrightLine ? `${p.copyrightLine}\n\n${p.licenseText.replace(/^\n+/, '')}` : p.licenseText);
    for (const n of p.noticeFiles.concat(p.extraNotices || [])) {
      lines.push(`### ${n.title}`);
      lines.push('');
      if (n.note) lines.push(n.note, '');
      block(n.text);
    }
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const errors = [];
  const packages = collect(opts.root, errors);
  applyNotices(packages, errors);
  for (const p of packages) {
    if (!isAllowedLicense(p.license)) errors.push(`${p.name}@${p.version}: license not on allow-list: ${p.license}`);
  }
  if (errors.length > 0) {
    console.error('Cannot generate the notices:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const text = render(packages);
  if (opts.check) {
    let current = null;
    try {
      current = fs.readFileSync(opts.out, 'utf8');
    } catch {}
    if (current !== text) {
      console.error(`${opts.out} is not up to date. Run: node scripts/licenses.js`);
      process.exit(1);
    }
    console.log(`${opts.out} is up to date (${packages.length} packages).`);
    return;
  }
  fs.writeFileSync(opts.out, text, 'utf8');
  console.log(`Wrote ${opts.out}`);
  console.log(`Packages: ${packages.length}`);
}

main();
