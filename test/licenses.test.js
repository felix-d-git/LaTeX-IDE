// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// THIRD_PARTY_NOTICES.md leaves out the pdfjs-dist parts with their own licenses
// (STRIPPED in scripts/licenses.js) because the Docker build, the installer build
// and the image check delete or reject them. The three lists must stay in sync.
// The bundle check (bundleErrors) ties the notices to what client/dist really
// contains; it needs esbuild (npm ci), not TeX.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STRIPPED, SHIPPED_FROM_STRIPPED, bundleErrors, checkBundle } = require('../scripts/licenses.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sorted = (a) => [...a].sort();
const want = sorted(STRIPPED['pdfjs-dist']);

test('Lizenzen: Dockerfile löscht genau die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /cd node_modules\/pdfjs-dist \\\n\s*&& rm -rf ([^\n]+)/.exec(read('Dockerfile'));
  assert.ok(m, 'rm -rf für pdfjs-dist fehlt im Dockerfile');
  assert.deepStrictEqual(sorted(m[1].trim().split(/\s+/)), want);
});

test('Lizenzen: Installer-Build löscht genau die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /\$PdfjsUnused = @\(([^)]*)\)/.exec(read('installer/build-release.ps1'));
  assert.ok(m, '$PdfjsUnused fehlt in build-release.ps1');
  const parts = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '').replace(/\\/g, '/'));
  assert.deepStrictEqual(sorted(parts), want);
});

test('Lizenzen: Container-Workflow prüft die pdfjs-dist-Teile aus STRIPPED', () => {
  const m = /for p in ([^;]+); do\n\s*! ls -d \/app\/node_modules\/pdfjs-dist\//.exec(read('.github/workflows/container-image.yml'));
  assert.ok(m, 'Prüfung der pdfjs-dist-Teile fehlt in container-image.yml');
  assert.deepStrictEqual(sorted(m[1].trim().split(/\s+/)), want);
});

// --- Client bundle (client/dist) against package-lock.json and the notices ---

const build = require('../build.js');
const esbuild = require('esbuild');

const lock = JSON.parse(read('package-lock.json'));
const pkg = JSON.parse(read('package.json'));
// "## name@version" headings of THIRD_PARTY_NOTICES.md
const notices = [...read('THIRD_PARTY_NOTICES.md').matchAll(/^## (\S+)@(\S+)$/gm)].map((m) => ({ name: m[1], version: m[2] }));
const noticeIds = new Set(notices.map((p) => `${p.name}@${p.version}`));
const copied = build.COPIED.map((c) => c.from);
const version = (name) => lock.packages[`node_modules/${name}`].version;
const DIRECT = ['@codemirror/autocomplete', '@codemirror/search', '@codemirror/lint'];
let metafilePromise;
const realMetafile = () => (metafilePromise ||= build.bundleMetafile());
const check = async (over = {}) => bundleErrors({
  metafile: await realMetafile(), copied, lockPackages: lock.packages, dependencies: pkg.dependencies, noticeIds, ...over,
});

test('Lizenzen: build.js baut mit Metafile und kopiert den pdf.js-Worker aus node_modules', async () => {
  assert.strictEqual(build.options.metafile, true);
  assert.ok(copied.includes('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), 'Worker fehlt in COPIED');
  const inputs = Object.keys((await realMetafile()).inputs);
  for (const p of [...DIRECT, 'pdfjs-dist', 'katex', 'yjs']) {
    assert.ok(inputs.some((i) => i.startsWith(`node_modules/${p}/`)), `${p} nicht im Metafile`);
  }
});

test('Lizenzen: Client-Bundle enthält nur Prod-Pakete aus THIRD_PARTY_NOTICES.md', async () => {
  assert.deepStrictEqual(await check(), []);
  const errors = [];
  await checkBundle(ROOT, notices, errors);
  assert.deepStrictEqual(errors, []);
});

test('Lizenzen: client/src importiert nur Pakete aus "dependencies"', async () => {
  // In "dependencies", and the locked version lies in the declared range (^x.y.z: same major, >= x.y.z).
  const num = (v) => v.split('.').map(Number);
  for (const p of DIRECT) {
    const range = pkg.dependencies[p];
    assert.match(range || '', /^\^\d+\.\d+\.\d+$/, `${p} fehlt in dependencies`);
    const [low, have] = [num(range.slice(1)), num(version(p))];
    assert.ok(have[0] === low[0] && (have[1] - low[1] || have[2] - low[2]) >= 0, `${p}: Lock-Version ${version(p)} liegt nicht in ${range}`);
  }
  // Gegenprobe: Stand vor #110, die drei kamen nur transitiv über codemirror
  const old = { ...pkg.dependencies };
  for (const p of DIRECT) delete old[p];
  const errors = await check({ dependencies: old });
  for (const p of DIRECT) {
    assert.ok(errors.includes(`client/src/editor.js imports ${p}, which package.json does not list in "dependencies"`), errors.join('\n'));
  }
});

test('Lizenzen: Gegenprobe, ein gebündeltes devDependency-Paket lässt die Prüfung scheitern', async () => {
  // Echtes Bundle plus ein Import aus esbuild (devDependency), wie aus einer Datei in client/src.
  const { metafile } = await esbuild.build({
    ...build.options,
    entryPoints: undefined,
    write: false,
    logLevel: 'silent',
    stdin: {
      contents: "import './main.js';\nimport { version } from 'esbuild/package.json';\nconsole.log(version);\n",
      resolveDir: path.join(ROOT, 'client', 'src'),
      sourcefile: 'devImport.js',
    },
  });
  assert.ok(metafile.inputs['node_modules/esbuild/package.json'], 'esbuild nicht gebündelt');
  const errors = await check({ metafile });
  assert.strictEqual(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith(`esbuild@${version('esbuild')}: node_modules/esbuild/package.json (bundled into client/dist), but a dev or optional package`)), errors.join('\n'));
  assert.ok(errors.some((e) => e.endsWith('imports esbuild, which package.json does not list in "dependencies"')), errors.join('\n'));
});

test('Lizenzen: Gegenprobe, Dev-Paket unter einem Prod-Paket, fehlender Hinweis, kopierte Dev-Datei', async () => {
  // crelt kommt über @codemirror/search und /lint ins Bundle; als Dev-Paket fehlte es in den Notices.
  const lockPackages = { ...lock.packages, 'node_modules/crelt': { ...lock.packages['node_modules/crelt'], dev: true } };
  let errors = await check({ lockPackages });
  assert.strictEqual(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], new RegExp(`^crelt@${version('crelt')}: node_modules/crelt/\\S+ \\(bundled into client/dist\\), but a dev or optional package`));
  // Gebündeltes Prod-Paket, das in den Notices fehlt
  const yjs = `yjs@${version('yjs')}`;
  errors = await check({ noticeIds: new Set([...noticeIds].filter((id) => id !== yjs)) });
  assert.strictEqual(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], new RegExp(`^${yjs}: .*, but not in the notices$`));
  // Von build.js kopierte Datei aus einem Dev-Paket
  errors = await check({ copied: [...copied, 'node_modules/esbuild/lib/main.js'] });
  assert.deepStrictEqual(errors, [`esbuild@${version('esbuild')}: node_modules/esbuild/lib/main.js (copied into client/dist), `
    + 'but a dev or optional package and so not in the notices; add it to "dependencies" or stop shipping it']);
});

test('Lizenzen: Bundle-Prüfung erkennt Scope-Pakete, verschachtelte node_modules und STRIPPED-Teile', () => {
  const metafile = {
    inputs: {
      'client/src/main.js': { imports: [{ path: 'node_modules/a/index.js', kind: 'import-statement', original: 'a' }] },
      'node_modules/a/index.js': { imports: [] },
      'node_modules/a/node_modules/@s/b/dist/x.js': { imports: [] },
      'node_modules/@s/c/web/viewer.js': { imports: [] },
      'node_modules/@s/c/build/ok.js': { imports: [] },
      '(disabled):node_modules/d/fs.js': { imports: [] },
      '../elsewhere/x.js': { imports: [] },
    },
  };
  const lockPackages = {
    'node_modules/a': { version: '1.0.0' },
    'node_modules/@s/b': { version: '9.0.0' }, // top level: prod, but the nested copy is the bundled one
    'node_modules/a/node_modules/@s/b': { version: '2.0.0', dev: true },
    'node_modules/@s/c': { version: '3.0.0' },
    'node_modules/d': { version: '4.0.0', optional: true },
  };
  const errors = bundleErrors({
    metafile,
    copied: ['node_modules/@s/c/web/allowed.js', 'node_modules/e/x.js'],
    lockPackages,
    dependencies: { a: '^1.0.0' },
    noticeIds: new Set(['a@1.0.0', '@s/b@9.0.0', '@s/c@3.0.0']),
    stripped: { '@s/c': ['web'] },
    shippedFromStripped: { '@s/c': ['web/allowed.js', 'web/gone.js'] },
  });
  assert.deepStrictEqual(errors.map((e) => e.split(/[,;] |: /)[0]), [
    '@s/b@2.0.0',
    '@s/c@3.0.0',
    'd@4.0.0',
    '../elsewhere/x.js (bundled into client/dist)',
    'node_modules/e/x.js (copied into client/dist)',
    "SHIPPED_FROM_STRIPPED['@s/c']",
  ], errors.join('\n'));
  assert.match(errors[1], /web\/viewer\.js \(bundled into client\/dist\) lies in a STRIPPED part/);
  assert.match(errors[5], /web\/gone\.js is not shipped any more/);
});

test('Lizenzen: relativer Import nach node_modules und node_modules unter client/ fallen auf', () => {
  const errors = bundleErrors({
    metafile: {
      inputs: {
        'client/src/main.js': { imports: [
          { path: 'node_modules/crelt/index.js', kind: 'import-statement', original: '../../node_modules/crelt/index.js' },
          { path: 'client/node_modules/fakegpl/index.js', kind: 'import-statement', original: 'fakegpl' },
          { path: 'client/src/util.js', kind: 'import-statement', original: './util.js' },
        ] },
        'client/src/util.js': { imports: [] },
        'node_modules/crelt/index.js': { imports: [] },
        'client/node_modules/fakegpl/index.js': { imports: [] },
      },
    },
    copied: [],
    lockPackages: { 'node_modules/crelt': { version: '1.0.6' } },
    dependencies: { fakegpl: '^1.0.0' },
    noticeIds: new Set(['crelt@1.0.6']),
    shippedFromStripped: {},
  });
  assert.deepStrictEqual(errors, [
    'client/src/main.js imports crelt, which package.json does not list in "dependencies"',
    'client/node_modules/fakegpl/index.js (bundled into client/dist): no package for it in package-lock.json (run npm ci)',
  ]);
});

test('Lizenzen: Build-Fehler im Client nennt Datei und Ursache', async () => {
  const errors = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-lic-'));
  try {
    fs.writeFileSync(path.join(root, 'build.js'), `module.exports = { COPIED: [], bundleMetafile: () => require(${JSON.stringify(require.resolve('esbuild'))}).build({ stdin: { contents: 'const = ;', sourcefile: 'client/src/kaputt.js' }, write: false, metafile: true, logLevel: 'silent' }) };`);
    await checkBundle(root, [], errors);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /^client bundle: cannot build it to check its packages: client\/src\/kaputt\.js:1:6: /);
  assert.doesNotMatch(errors[0], /npm ci/);
});

test('Lizenzen: SHIPPED_FROM_STRIPPED liegt in STRIPPED-Teilen mit Embedded-Hinweisen', () => {
  const text = read('THIRD_PARTY_NOTICES.md');
  for (const [name, files] of Object.entries(SHIPPED_FROM_STRIPPED)) {
    assert.ok(STRIPPED[name], `${name} fehlt in STRIPPED`);
    for (const f of files) assert.ok(STRIPPED[name].some((g) => f.startsWith(`${g}/`)), `${name}/${f} liegt in keinem STRIPPED-Teil`);
    const section = text.split(/^## /m).find((s) => s.startsWith(`${name}@`));
    assert.match(section || '', /^### Embedded: /m, `${name} ohne Embedded-Hinweise`);
  }
});
