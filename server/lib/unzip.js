const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_TOTAL = 200 * 1024 * 1024; // entpackte Gesamtgröße
const MAX_FILES = 5000;

// Liest die Central Directory eines Zips und schreibt es nach destDir.
// Stdlib-only (zlib.inflateRaw); kein Zip64, keine Verschlüsselung.
// Wirft bei Zip-Slip (.. / absolute Pfade), Limits oder kaputtem Zip - bevor etwas geschrieben wird.
function extractZip(buf, destDir) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige Zip-Datei.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 wird nicht unterstützt.');
  if (count > MAX_FILES) throw new Error(`Zu viele Dateien (max. ${MAX_FILES}).`);

  const entries = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip beschädigt.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + elen + clen;

    if (name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`Unzulässiger Pfad im Zip: ${name}`);
    }
    if (name.startsWith('__MACOSX/') || name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Verschlüsselte Zips werden nicht unterstützt.');
    total += usize;
    if (total > MAX_TOTAL) throw new Error('Zip entpackt zu groß (max. 200 MB).');
    entries.push({ name, method, csize, usize, lho });
  }
  if (!entries.length) throw new Error('Zip enthält keine Dateien.');

  // Genau ein gemeinsamer Wurzelordner -> dessen Inhalt nehmen.
  const first = entries[0].name.split('/')[0];
  const strip = entries.every((e) => e.name.includes('/') && e.name.split('/')[0] === first) ? first.length + 1 : 0;

  const base = path.resolve(destDir);
  const out = entries.map((e) => {
    const rel = e.name.slice(strip);
    const abs = path.resolve(base, rel);
    if (!rel || !abs.startsWith(base + path.sep)) throw new Error(`Unzulässiger Pfad im Zip: ${e.name}`);
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('Zip beschädigt.');
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    const raw = buf.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
    else throw new Error('Nicht unterstützte Zip-Kompression.');
    if (data.length !== e.usize) throw new Error('Zip beschädigt (Größe).');
    return { abs, data };
  });
  for (const { abs, data } of out) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

module.exports = { extractZip };
