// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// #109 M4: Debian's pandoc links ~150 Haskell libraries (BSD-3-Clause, MIT ...) statically, the
// image only had pandoc's own copyright file. scripts/pandoc-copyright.py takes debian/copyright
// from the downloaded source packages, container-image.yml adds them to the image as a layer.
// Docker does not run here: the workflow step runs against a docker stub (dry run) that
// executes the image check on the folder the COPY would add.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pandoc-copyright.py');
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !hasPython && 'python3 fehlt';
const YML = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'container-image.yml'), 'utf8').replace(/\r\n/g, '\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-pcr-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Source packages like apt-get source / debsnap leave them: .dsc + archives, all four formats.
const COPYRIGHT = {
  'haskell-foo': 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nFiles: *\nCopyright: 2010 Foo Author\nLicense: BSD-3-clause\n',
  ghc: 'Copyright: The University Court of the University of Glasgow\nLicense: BSD-3-clause\n',
  pandoc: 'Copyright: 2006-2022 John MacFarlane\nLicense: GPL-2+\n',
  native: 'Copyright: 2020 Native\nLicense: MIT\n',
  old: 'Copyright: 1999 Old\nLicense: Expat\n',
};
const FIXTURE = String.raw`
import gzip, io, json, os, sys, tarfile
d, c = sys.argv[1], json.loads(sys.argv[2])
os.makedirs(d, exist_ok=True)
def tar(name, files, mode):
    with tarfile.open(os.path.join(d, name), mode) as t:
        for n, text in files.items():
            b = text.encode()
            i = tarfile.TarInfo(n); i.size = len(b); t.addfile(i, io.BytesIO(b))
def dsc(name, fmt, files, signed=False):
    body = "Format: %s\nSource: x\nFiles:\n%s\nChecksums-Sha256:\n x 1 ignored\n" % (fmt, "".join(" 0123 1 %s\n" % f for f in files))
    if signed:
        body = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n" + body + "\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n"
    open(os.path.join(d, name), "w").write(body)
# 3.0 (quilt), clearsigned, copyright next to other debian/ files
tar("haskell-foo_1.2.orig.tar.gz", {"foo-1.2/LICENSE": "upstream"}, "w:gz")
tar("haskell-foo_1.2-3.debian.tar.xz", {"debian/control": "x", "debian/copyright": c["haskell-foo"]}, "w:xz")
dsc("haskell-foo_1.2-3.dsc", "3.0 (quilt)", ["haskell-foo_1.2.orig.tar.gz", "haskell-foo_1.2-3.debian.tar.xz"], signed=True)
# member names with ./ prefix, bz2
tar("ghc_9.2.5.orig.tar.xz", {"ghc-9.2.5/debian/copyright": "falsch: aus dem Upstream-Tarball"}, "w:xz")
tar("ghc_9.2.5-1.debian.tar.bz2", {"./debian/copyright": c["ghc"]}, "w:bz2")
dsc("ghc_9.2.5-1.dsc", "3.0 (quilt)", ["ghc_9.2.5.orig.tar.xz", "ghc_9.2.5-1.debian.tar.bz2"])
tar("pandoc_2.17.1.1.orig.tar.gz", {}, "w:gz")
tar("pandoc_2.17.1.1-2~deb12u1.debian.tar.xz", {"debian/copyright": c["pandoc"]}, "w:xz")
dsc("pandoc_2.17.1.1-2~deb12u1.dsc", "3.0 (quilt)", ["pandoc_2.17.1.1.orig.tar.gz", "pandoc_2.17.1.1-2~deb12u1.debian.tar.xz"])
# 3.0 (native) with epoch (not in the file name)
tar("native_0.5.tar.xz", {"native-0.5/debian/copyright": c["native"], "native-0.5/src/x.hs": "x"}, "w:xz")
dsc("native_0.5.dsc", "3.0 (native)", ["native_0.5.tar.xz"])
# 1.0 with .diff.gz that creates debian/copyright
diff = "--- old-1.0.orig/x\n+++ old-1.0/x\n@@ -1 +1 @@\n-a\n+b\n--- old-1.0.orig/debian/copyright\n+++ old-1.0/debian/copyright\n@@ -0,0 +1,%d @@\n%s--- old-1.0.orig/debian/rules\n+++ old-1.0/debian/rules\n@@ -0,0 +1 @@\n+all:\n" % (
    c["old"].count("\n"), "".join("+" + l + "\n" for l in c["old"].splitlines()))
open(os.path.join(d, "old_1.0-1.diff.gz"), "wb").write(gzip.compress(diff.encode()))
tar("old_1.0.orig.tar.gz", {"old-1.0/x": "a"}, "w:gz")
dsc("old_1.0-1.dsc", "1.0", ["old_1.0.orig.tar.gz", "old_1.0-1.diff.gz"])
open(os.path.join(d, "SOURCES.txt"), "w").write("ghc 9.2.5-1\nhaskell-foo 1.2-3\nnative 1:0.5\nold 1.0-1\npandoc 2.17.1.1-2~deb12u1\n")
`;

function fixture(name) {
  const dir = path.join(tmp, name);
  const r = spawnSync('python3', ['-c', FIXTURE, dir, JSON.stringify(COPYRIGHT)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return dir;
}
const run = (src, out) => spawnSync('python3', ['-I', SCRIPT, src, out], { encoding: 'utf8' });

test('pandoc-Copyright: debian/copyright aus allen Quellformaten (3.0 quilt/native, 1.0 mit diff.gz)', { skip }, () => {
  const src = fixture('ok');
  const out = path.join(tmp, 'ok-out');
  const r = run(src, out);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^5 copyright files in /);
  for (const [name, text] of Object.entries(COPYRIGHT)) {
    assert.strictEqual(fs.readFileSync(path.join(out, name, 'copyright'), 'utf8'), text, name);
  }
  assert.strictEqual(fs.readFileSync(path.join(out, 'SOURCES.txt'), 'utf8'), fs.readFileSync(path.join(src, 'SOURCES.txt'), 'utf8'));
  assert.match(fs.readFileSync(path.join(out, 'README'), 'utf8'), /statically linked into pandoc[\s\S]*pandoc-sources-<tag>\.tar/);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['README', 'SOURCES.txt', ...Object.keys(COPYRIGHT)].sort());
});

test('pandoc-Copyright: Gegenproben, fehlende Datei und unsaubere SOURCES.txt brechen ab', { skip }, () => {
  // debian/copyright fehlt in einem Paket: Abbruch mit Namen, alle Fehler gesammelt
  let src = fixture('missing');
  fs.writeFileSync(path.join(src, 'native_0.5.dsc'), 'Format: 3.0 (native)\nFiles:\n 0 1 native_0.5.tar.xz\n');
  fs.rmSync(path.join(src, 'native_0.5.tar.xz'));
  fs.rmSync(path.join(src, 'old_1.0-1.dsc'));
  let r = run(src, path.join(tmp, 'missing-out'));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /debian\/copyright missing:\n {2}native 1:0\.5: .*native_0\.5\.tar\.xz/);
  assert.match(r.stderr, /\n {2}old 1\.0-1: .*old_1\.0-1\.dsc/);
  assert.ok(!fs.existsSync(path.join(tmp, 'missing-out', 'SOURCES.txt')), 'unvollständige Ausgabe ohne SOURCES.txt');
  // Pfad-Tricks im Quellnamen
  src = fixture('evil');
  fs.appendFileSync(path.join(src, 'SOURCES.txt'), '../../etc 1.0\n');
  r = run(src, path.join(tmp, 'evil-out'));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /SOURCES\.txt line 6: not '<source> <version>'/);
  // Leere Liste
  src = fixture('empty');
  fs.writeFileSync(path.join(src, 'SOURCES.txt'), '\n');
  assert.match(run(src, path.join(tmp, 'empty-out')).stderr, /SOURCES\.txt is empty/);
});

// The `run:` script of a step (block scalar).
function runOf(name) {
  const lines = YML.split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `Schritt "${name}" fehlt`);
  while (!/^\s+run: \|/.test(lines[++i]));
  const out = [];
  for (i++; i < lines.length && (lines[i].startsWith('          ') || !lines[i].trim()); i++) out.push(lines[i].slice(10));
  return out.join('\n');
}
const stepIndex = (name) => YML.indexOf(`\n      - name: ${name}\n`);

test('Container-Workflow: Copyright-Schicht nach den pandoc-Quellen, vor Upload und Push', () => {
  const order = ['pandoc-Quellen sammeln', 'Copyright-Vermerke der pandoc-Bibliotheken ins Image',
    'Paketliste und pandoc-Quellen an das Release haengen', 'Nach ghcr.io pushen'].map(stepIndex);
  assert.ok(order.every((i) => i > 0), order.join());
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
  const pandoc = runOf('pandoc-Quellen sammeln');
  const call = pandoc.indexOf('python3 scripts/pandoc-copyright.py "$RUNNER_TEMP/src" "$RUNNER_TEMP/pandoc-copyright"');
  assert.ok(call > pandoc.indexOf('done < SOURCES.txt'), 'Aufruf erst nach dem Herunterladen der Quellen');
  assert.ok(call < pandoc.indexOf('rm -rf "$RUNNER_TEMP/src"'), 'Aufruf vor dem Löschen der Quellen');
  assert.ok(call < pandoc.indexOf('tar -cf "pandoc-sources-'), 'Ausgabe nicht im pandoc-sources-Archiv');
});

test('Container-Workflow: Trockenlauf der Copyright-Schicht mit docker-Stub', { skip: (skip || (!fs.existsSync(BASH) && 'bash fehlt')) }, () => {
  const runner = path.join(tmp, 'runner');
  fs.mkdirSync(runner);
  fs.renameSync(fixture('dry'), path.join(runner, 'src'));
  const stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(stubs);
  // build: Dockerfile (stdin) und Kontext merken; run: Prüfskript gegen den Kontext statt gegen das Image
  fs.writeFileSync(path.join(stubs, 'docker'), [
    '#!/bin/bash',
    'echo "docker $*" >> "$LOG"',
    'if [ "$1" = build ]; then cat > "$LOG.dockerfile"; printf %s "${@: -1}" > "$LOG.ctx"; cp -R "${@: -1}" "$LOG.image"; exit 0; fi',
    'if [ "$1" = run ]; then script="${@: -1}"; exec sh -c "${script//\\/usr\\/share\\/doc\\/pandoc\\/static-libs/$LOG.image}"; fi',
    'exit 1',
  ].join('\n') + '\n', { mode: 0o755 });
  const log = path.join(tmp, 'log');
  const pandocCall = runOf('pandoc-Quellen sammeln').split('\n').find((l) => l.startsWith('python3 scripts/pandoc-copyright.py'));
  const script = `${pandocCall}\n${runOf('Copyright-Vermerke der pandoc-Bibliotheken ins Image')}`;
  const env = { ...process.env, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, LOG: log, RUNNER_TEMP: runner };
  let r = spawnSync(BASH, ['-e', '-c', script], { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5 Copyright-Dateien unter /);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`^docker build -t latex-ide:test -f - ${runner.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}/pandoc-copyright$`, 'm'));
  assert.strictEqual(fs.readFileSync(`${log}.dockerfile`, 'utf8'), 'FROM latex-ide:test\nCOPY . /usr/share/doc/pandoc/static-libs/\n');
  assert.ok(!fs.existsSync(path.join(runner, 'pandoc-copyright')), 'Zwischenordner bleibt liegen');
  // Gegenprobe: eine Copyright-Datei fehlt in der neuen Schicht -> der Schritt scheitert
  fs.rmSync(`${log}.image`, { recursive: true });
  const check = runOf('Copyright-Vermerke der pandoc-Bibliotheken ins Image').split('\n').filter((l) => !l.startsWith('rm -rf'));
  fs.mkdirSync(path.join(runner, 'pandoc-copyright'), { recursive: true });
  r = spawnSync('python3', ['-I', SCRIPT, path.join(runner, 'src'), path.join(runner, 'pandoc-copyright')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(path.join(runner, 'pandoc-copyright', 'ghc'), { recursive: true });
  r = spawnSync(BASH, ['-e', '-c', check.join('\n')], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout, /fehlt: \/usr\/share\/doc\/pandoc\/static-libs\/ghc\/copyright|fehlt: .*\/ghc\/copyright/);
});
