// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Lizenz- und Quellcode-Hinweise (AGPL-3.0-only §5, §13) für Server, Desktop-App und Bundle-Banner.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { version: VERSION } = require('../../package.json');
const COPYRIGHT = 'Copyright (C) 2026 felix-d-git and LaTeX-IDE contributors';
const UPDATE_REPO = process.env.UPDATE_REPO || 'felix-d-git/LaTeX-IDE';
// Wer veränderten Code betreibt oder weitergibt, muss SOURCE_URL auf den eigenen,
// vollständigen Quellcode dieses Stands setzen (AGPL §13 bzw. §6).
const SOURCE_URL = process.env.SOURCE_URL || `https://github.com/${UPDATE_REPO}`;
// Ohne eigene SOURCE_URL: der Tag genau dieser Version statt master.
// {version} in SOURCE_URL is replaced by the running version, so the link follows server updates.
const SOURCE_LINK = (process.env.SOURCE_URL || `${SOURCE_URL}/tree/v${VERSION}`).replaceAll('{version}', VERSION);

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

module.exports = { VERSION, COPYRIGHT, UPDATE_REPO, SOURCE_URL, SOURCE_LINK, licensesText };
