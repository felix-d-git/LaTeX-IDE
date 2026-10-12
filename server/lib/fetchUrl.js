// "Add files > From external URL": the server downloads the file, so it must
// not become a door into the Pi's network (SSRF). Every connection - incl.
// each redirect hop - is checked at DNS-lookup time (no rebinding window)
// against private, loopback, link-local, CGNAT/Tailscale and other
// non-public ranges.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(a, p, 'ipv6');

function isBlocked(addr) {
  const family = net.isIP(addr);
  return !family || blocked.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

function safeLookup(host, opts, cb) {
  dns.lookup(host, opts, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => isBlocked(a.address))) {
      return cb(Object.assign(new Error('Ziel-Adresse ist nicht erlaubt (internes Netz).'), { code: 'EBLOCKED' }));
    }
    cb(null, address, family);
  });
}

function get(url, hops, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Ungültige URL.'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Nur http- und https-Adressen.'));
    if (u.username || u.password) return reject(new Error('URLs mit Zugangsdaten sind nicht erlaubt.'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // A literal IP skips the lookup, so check it here.
    if (net.isIP(host) && isBlocked(host)) return reject(new Error('Ziel-Adresse ist nicht erlaubt (internes Netz).'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'LatexWebIDE', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('Zu viele Weiterleitungen.'));
        let next;
        try {
          next = new URL(res.headers.location, u);
        } catch {
          return reject(new Error('Server leitet auf eine ungültige Adresse weiter.'));
        }
        // API keys only to the host they were meant for; Accept (DOI content negotiation) may follow.
        const keep = next.host === u.host ? headers : headers.Accept ? { Accept: headers.Accept } : {};
        return resolve(get(next.href, hops + 1, keep));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Server antwortet mit ${res.statusCode}.`));
      }
      if (Number(res.headers['content-length']) > MAX_BYTES) {
        res.destroy();
        return reject(new Error('Datei ist größer als 50 MB.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          res.destroy();
          reject(new Error('Datei ist größer als 50 MB.'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ data: Buffer.concat(chunks), finalUrl: u.href, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Download.')));
    req.on('error', reject);
  });
}

function fetchUrl(url, headers = {}) {
  return get(String(url || ''), 0, headers);
}

module.exports = { fetchUrl, isBlocked };
