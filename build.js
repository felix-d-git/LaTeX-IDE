// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
// .env first: legal.js reads SOURCE_URL / UPDATE_REPO for the bundle banner.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const legal = require('./server/lib/legal');

const watch = process.argv.includes('--watch');
// --serve: start the server in this process after the first build (npm run dev; "&" does not background on Windows cmd).
const serve = process.argv.includes('--serve');

const outDir = path.join(__dirname, 'client', 'dist');

// Files copied from node_modules to client/dist as they are (from: repo-relative, to: below
// client/dist). scripts/licenses.js checks their packages like the bundled ones.
const COPIED = [
  // pdf.js worker (workerSrc in pdfViewer.js)
  { from: 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', to: 'pdf.worker.min.mjs' },
  // Decoders for JPEG 2000 and JBIG2 images, colour management (wasmUrl in pdfViewer.js, visualEditor.js).
  ...['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm'].map((f) => ({ from: `node_modules/pdfjs-dist/wasm/${f}`, to: `pdfjs-wasm/${f}` })),
];

function copyFromNodeModules() {
  for (const { from, to } of COPIED) {
    const dest = path.join(outDir, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(__dirname, from), dest);
  }
}

const options = {
  entryPoints: [path.join(__dirname, 'client', 'src', 'main.js')],
  bundle: true,
  outfile: path.join(outDir, 'bundle.js'),
  // Input paths in the metafile relative to the repo, whatever the current directory.
  absWorkingDir: __dirname,
  // Lists every bundled input; scripts/licenses.js checks the node_modules ones (bundleMetafile).
  metafile: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2020',
  loader: { '.css': 'text' },
  // License notice in every copy of the bundle (pdf.js' @licstart header is not an esbuild legal comment).
  banner: {
    js: [
      `/*! LaTeX-IDE ${legal.VERSION} - ${legal.COPYRIGHT}`,
      ` * AGPL-3.0-only, WITHOUT ANY WARRANTY. Source: ${legal.SOURCE_LINK}`,
      ' * Includes third-party code, among others:',
      ' *   pdf.js - Copyright 2024 Mozilla Foundation - Apache-2.0',
      ' *   CodeMirror, Lezer - Copyright Marijn Haverbeke and others - MIT',
      ' *   KaTeX - Copyright Khan Academy and other contributors - MIT',
      ' *   Yjs, y-indexeddb - Copyright Kevin Jahns, RWTH Aachen University - MIT',
      ' *   lib0, y-protocols, y-websocket, y-codemirror.next - Copyright Kevin Jahns - MIT',
      ' * Full license texts and notices: /licenses',
      ' */',
    ].join('\n'),
  },
};

// Metafile of the client bundle, built in memory with the same options (nothing written).
async function bundleMetafile() {
  const result = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
  return result.metafile;
}

async function run() {
  copyFromNodeModules();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching client/src for changes...');
    if (serve) require('./server/index.js');
  } else {
    await esbuild.build(options);
    console.log('esbuild: client bundle built.');
  }
}

module.exports = { COPIED, options, bundleMetafile };

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
