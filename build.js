const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
// .env first: legal.js reads SOURCE_URL / UPDATE_REPO for the bundle banner.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const legal = require('./server/lib/legal');

const watch = process.argv.includes('--watch');
// --serve: start the server in this process after the first build (npm run dev; "&" does not background on Windows cmd).
const serve = process.argv.includes('--serve');

function copyPdfWorker() {
  const outDir = path.join(__dirname, 'client', 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
  fs.copyFileSync(src, path.join(outDir, 'pdf.worker.min.mjs'));
}

const options = {
  entryPoints: [path.join(__dirname, 'client', 'src', 'main.js')],
  bundle: true,
  outfile: path.join(__dirname, 'client', 'dist', 'bundle.js'),
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

async function run() {
  copyPdfWorker();
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

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
