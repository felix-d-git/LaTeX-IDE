const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const watch = process.argv.includes('--watch');

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
};

async function run() {
  copyPdfWorker();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('esbuild: watching client/src for changes...');
  } else {
    await esbuild.build(options);
    console.log('esbuild: client bundle built.');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
