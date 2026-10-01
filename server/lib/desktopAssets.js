// Desktop installers served by this server, with its own address built in.
// The server fetches the assets of the GitHub release matching its own version
// (built by .github/workflows/release.yml) once into DATA_DIR/desktop/<version>
// and patches the server URL in while streaming them out:
//   windows: LatexIDE-Setup.exe + 1024-byte trailer "LATEXIDE-SERVER-URL=<url>" (read by LatexIDE.iss)
//   macos:   LatexIDE-macOS.zip + extra entry server.json {"remoteUrl": ...} (read by desktop.js)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ASSETS = { windows: /setup.*\.exe$/i, macos: /macos.*\.zip$/i };
const TRAILER = 1024;
const MARKER = 'LATEXIDE-SERVER-URL=';

function createDesktopAssets({ dataDir, repo, token, version }) {
  const dir = path.join(dataDir, 'desktop', version);
  const headers = (accept) => ({
    Accept: accept,
    'User-Agent': 'LatexIDE-Server',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  let meta = { at: 0, assets: null, error: null };
  const downloads = new Map();

  // Assets of release v<version>; errors are cached too (no GitHub hammering).
  async function releaseAssets() {
    const complete = meta.assets && Object.keys(ASSETS).every((os) => meta.assets[os]);
    if (Date.now() - meta.at < (complete ? 6 * 3600e3 : 600e3)) {
      if (meta.error) throw new Error(meta.error);
      return meta.assets;
    }
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, {
        headers: headers('application/vnd.github+json'),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`GitHub HTTP ${r.status} (Release v${version})`);
      const rel = await r.json();
      const assets = {};
      for (const [os, re] of Object.entries(ASSETS)) {
        const a = (rel.assets || []).find((x) => re.test(x.name));
        if (a) assets[os] = a.url;
      }
      meta = { at: Date.now(), assets, error: null };
      return assets;
    } catch (e) {
      meta = { at: Date.now(), assets: null, error: e.message };
      throw e;
    }
  }

  // Local path of the unpatched asset, downloaded on first use.
  function assetFile(os) {
    if (!Object.hasOwn(ASSETS, os)) return Promise.reject(new Error('Unbekanntes Betriebssystem.'));
    const file = path.join(dir, os === 'windows' ? 'LatexIDE-Setup.exe' : 'LatexIDE-macOS.zip');
    if (fs.existsSync(file)) return Promise.resolve(file);
    if (!downloads.has(os)) {
      const p = (async () => {
        const url = (await releaseAssets())[os];
        if (!url) throw new Error(`Release v${version} enthält kein Paket für ${os}.`);
        const r = await fetch(url, { headers: headers('application/octet-stream'), signal: AbortSignal.timeout(900000) });
        if (!r.ok) throw new Error(`GitHub HTTP ${r.status} (Download)`);
        fs.mkdirSync(dir, { recursive: true });
        await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(`${file}.part`));
        fs.renameSync(`${file}.part`, file);
        // Only the current version is ever served.
        for (const old of fs.readdirSync(path.dirname(dir))) {
          if (old !== version) fs.rmSync(path.join(path.dirname(dir), old), { recursive: true, force: true });
        }
        return file;
      })().finally(() => downloads.delete(os));
      downloads.set(os, p);
    }
    return downloads.get(os);
  }

  async function available() {
    const assets = await releaseAssets();
    return { windows: !!assets.windows, macos: !!assets.macos };
  }

  // Streams the patched installer for serverUrl to res.
  async function send(os, serverUrl, res) {
    checkUrl(serverUrl);
    const file = await assetFile(os);
    const parts = os === 'windows' ? [[0, fs.statSync(file).size], exeTrailer(serverUrl)] : zipAppendParts(file, 'server.json', JSON.stringify({ remoteUrl: serverUrl }));
    const length = parts.reduce((n, p) => n + (Buffer.isBuffer(p) ? p.length : p[1] - p[0]), 0);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
      'Content-Length': String(length),
    });
    for (const p of parts) {
      if (Buffer.isBuffer(p)) {
        if (!res.write(p)) await new Promise((ok) => (res.once('drain', ok), res.once('close', ok)));
        if (res.destroyed) return;
      } else if (p[1] > p[0]) {
        await pipeline(fs.createReadStream(file, { start: p[0], end: p[1] - 1 }), res, { end: false });
      }
    }
    res.end();
  }

  return { available, assetFile, send };
}

function checkUrl(url) {
  if (!/^https?:\/\/[^\s"\\]+$/.test(url) || MARKER.length + url.length > TRAILER) throw new Error(`Ungültige Server-Adresse: ${url}`);
}

function exeTrailer(url) {
  checkUrl(url);
  return Buffer.from((MARKER + url).padEnd(TRAILER, ' '), 'ascii');
}

// Appends one stored (uncompressed) entry to an existing zip without rewriting it:
// [old entries] [new local entry] [old central dir] [new central entry] [new end record].
// Returns parts: [start, end) byte ranges of the file or Buffers.
function zipAppendParts(file, name, content) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0) throw new Error('Kein gültiges ZIP.');
    const eocdPos = size - tailLen + at;
    const entries = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOff = tail.readUInt32LE(at + 16);
    // ponytail: no zip64 support - the macOS package is ~40 MB / ~5k entries.
    if (entries === 0xffff || cdOff === 0xffffffff || cdOff + cdSize !== eocdPos) throw new Error('ZIP-Format nicht unterstützt (zip64?).');

    const n = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = zlib.crc32(data);
    const DOS_DATE = 0x21; // 1980-01-01

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 name
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(cdOff, 42); // new local entry sits where the old central dir began

    const added = 30 + n.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries + 1, 8);
    eocd.writeUInt16LE(entries + 1, 10);
    eocd.writeUInt32LE(cdSize + 46 + n.length, 12);
    eocd.writeUInt32LE(cdOff + added, 16);

    return [[0, cdOff], Buffer.concat([local, n, data]), [cdOff, cdOff + cdSize], Buffer.concat([central, n]), eocd];
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { createDesktopAssets, exeTrailer, zipAppendParts };
