// P12-Rest D (#64): Desktop-Sync - If-Match, Ordner-Marker, Hash-Cache, Offline-Abbruch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { syncFolder, walkLocal } = require('../server/lib/localSync');

const REPO = path.join(__dirname, '..');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-p12d-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// --- 1. If-Match ---

test('Server: PUT /api/collab/raw prüft If-Match, ohne Header wie bisher', async () => {
  const { startServer, client } = require('./_server');
  const s = await startServer();
  try {
    const admin = client(s.base);
    await admin.login('admin', 'bitte-sofort-aendern');
    await admin.call('POST', '/api/projects/create', { name: 'Thesis' });
    const url = (p) => `${s.base}/api/collab/raw?project=Thesis&path=${p}`;
    const put = (p, body, ifMatch) =>
      fetch(url(p), {
        method: 'PUT',
        headers: { cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': admin.jar.csrfToken, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
        body,
      });
    assert.strictEqual((await put('n.tex', 'eins', 'none')).status, 200, 'neue Datei, Basis none');
    assert.strictEqual((await put('n.tex', 'zwei', 'none')).status, 409, 'Datei existiert inzwischen');
    assert.strictEqual((await put('n.tex', 'zwei', sha1(Buffer.from('falsch')))).status, 409);
    assert.strictEqual((await put('n.tex', 'zwei', `"${sha1(Buffer.from('eins'))}"`)).status, 200, 'passender Hash (auch in Anführungszeichen)');
    assert.strictEqual((await put('n.tex', 'drei')).status, 200, 'ohne Header: Verhalten wie bisher');
    const man = await admin.call('GET', '/api/collab/manifest?project=Thesis');
    assert.ok(man.body.files.some((f) => f.path === 'n.tex' && f.sha1 === sha1(Buffer.from('drei'))));
  } finally {
    await s.stop();
  }
});

test('syncFolder: 409 beim Hochladen = Konflikt, nichts geht verloren', async () => {
  const dir = path.join(tmp(), 'p');
  const idx = path.join(tmp(), 'i.json');
  const srv = new Map([['a.tex', Buffer.from('v1')]]);
  const bases = [];
  const io = {
    caseInsensitive: false,
    manifest: async () => ({ files: [...srv].map(([p, b]) => ({ path: p, sha1: sha1(b) })) }),
    download: async (rel) => srv.get(rel),
    upload: async (rel, buf, base) => {
      bases.push([rel, base]);
      const cur = srv.has(rel) ? sha1(srv.get(rel)) : 'none';
      if (base !== cur) throw Object.assign(new Error('409'), { status: 409 });
      srv.set(rel, Buffer.from(buf));
    },
    remove: async () => {},
  };
  await syncFolder(dir, idx, io);
  fs.writeFileSync(path.join(dir, 'a.tex'), 'lokal');
  // someone changes the server file right after our manifest: the manifest still shows v1
  const man = io.manifest;
  io.manifest = async () => {
    const m = await man();
    srv.set('a.tex', Buffer.from('server2'));
    return m;
  };
  const r = await syncFolder(dir, idx, io);
  assert.deepStrictEqual(r.conflicts, ['a.tex']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.tex'), 'utf8'), 'server2', 'Server-Fassung gewinnt');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.offline-konflikt.tex'), 'utf8'), 'lokal', 'lokale Fassung als Konfliktkopie');
  assert.strictEqual(srv.get('a.offline-konflikt.tex').toString(), 'lokal');
  assert.deepStrictEqual(bases[0], ['a.tex', sha1(Buffer.from('v1'))], 'Basis = Hash aus dem Manifest');
  assert.deepStrictEqual(bases.at(-1), ['a.offline-konflikt.tex', 'none']);
});

// --- 3. Hash-Cache ---

test('walkLocal: Hash nach (Pfad, Größe, mtime) gecacht, Marker wird nie gelistet', () => {
  const d = tmp();
  const f = path.join(d, 'a.tex');
  fs.writeFileSync(f, 'AAAA');
  fs.writeFileSync(path.join(d, '.latex-ide-project.json'), '{}');
  const t0 = new Date(Date.now() - 60000);
  fs.utimesSync(f, t0, t0);
  assert.deepStrictEqual([...walkLocal(d)], [['a.tex', sha1(Buffer.from('AAAA'))]]);
  fs.writeFileSync(f, 'BBBB'); // same size
  fs.utimesSync(f, t0, t0); // same mtime -> cache hit (not re-read)
  assert.strictEqual(walkLocal(d).get('a.tex'), sha1(Buffer.from('AAAA')));
  const t1 = new Date(t0.getTime() + 5000);
  fs.utimesSync(f, t1, t1);
  assert.strictEqual(walkLocal(d).get('a.tex'), sha1(Buffer.from('BBBB')), 'neue mtime -> neu gehasht');
});

// --- Desktop gegen Fake-Server (2, 4) ---

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// state: { name, down, hang, files: Map }, log: { puts: [{path, ifMatch}], gets: [] }
async function startRemote(state) {
  const log = { puts: [], gets: [] };
  const srv = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-latex-ide': '1' });
      res.end(JSON.stringify(body));
    };
    if (state.down) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end('Bad Gateway');
    }
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'HEAD') log.gets.push(u.pathname);
    if (req.method === 'HEAD') return send(200, {});
    if (u.pathname === '/api/hang') return; // never answers
    if (u.pathname === '/api/collab/owned') return send(200, { projects: [{ name: state.name, projectId: 'p1' }] });
    if (u.pathname === '/api/collab/manifest') return send(200, { projectId: 'p1', mainFile: 'main.tex', files: [...state.files].map(([p, b]) => ({ path: p, sha1: sha1(b) })) });
    if (u.pathname === '/api/raw') return res.end(state.files.get(u.searchParams.get('path')));
    if (u.pathname === '/api/collab/raw' && req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        const p = u.searchParams.get('path');
        log.puts.push({ path: p, ifMatch: req.headers['if-match'] });
        state.files.set(p, Buffer.concat(chunks));
        send(200, { ok: true });
      });
    }
    send(404, { error: 'unbekannt' });
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => (srv.closeAllConnections(), srv.close(r))) };
}

async function startDesktop(remoteUrl, root) {
  const data = path.join(root, 'data');
  const local = path.join(root, 'local');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  if (!fs.existsSync(path.join(data, 'config.json'))) fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'lide_test' }));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), LATEX_IDE_DATA: data, LATEX_IDE_LOCAL: local, REMOTE_URL: remoteUrl };
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'desktop.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error('Desktop beendet:\n' + log);
    try {
      await fetch(base + '/api/desktop/info');
      break;
    } catch {
      if (i > 150) throw new Error('Desktop startet nicht:\n' + log);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const csrf = 'c'.repeat(48);
  const get = async (url) => {
    const r = await fetch(base + url, { headers: { cookie: `csrfToken=${csrf}`, 'x-csrf-token': csrf } });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json };
  };
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  };
  return { get, stop, local, data, log: () => log };
}

const until = async (fn, ms = 15000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test('Ordner-Marker: Umbenennung, Groß-/Kleinschreibung, fremder Marker, kein Upload, If-Match', async () => {
  const root = tmp();
  const state = { name: 'Thesis', files: new Map([['main.tex', Buffer.from('v1')]]) };
  const remote = await startRemote(state);
  try {
    let d = await startDesktop(remote.url, root);
    const marker = (dir) => path.join(root, 'local', dir, '.latex-ide-project.json');
    assert.ok(await until(() => fs.existsSync(marker('Thesis'))), 'Marker nach dem ersten Sync\n' + d.log());
    const m = JSON.parse(fs.readFileSync(marker('Thesis'), 'utf8'));
    assert.strictEqual(m.projectId, 'p1');
    assert.strictEqual(m.server, remote.url);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8')).folders.p1, 'Thesis', 'Zuordnung gespeichert');
    await d.stop();

    // renamed on the server + local edit: folder is renamed, edit uploaded with If-Match, marker not uploaded
    state.name = 'Diss';
    fs.writeFileSync(path.join(root, 'local', 'Thesis', 'main.tex'), 'lokal');
    d = await startDesktop(remote.url, root);
    assert.ok(await until(() => remote.log.puts.length > 0), 'Upload\n' + d.log());
    assert.ok(fs.existsSync(marker('Diss')), 'Ordner umbenannt');
    assert.ok(!fs.existsSync(path.join(root, 'local', 'Thesis')), 'kein zweiter Ordner');
    assert.deepStrictEqual(remote.log.puts, [{ path: 'main.tex', ifMatch: sha1(Buffer.from('v1')) }]);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!remote.log.puts.some((p) => p.path.includes('latex-ide-project')), 'Marker wird nicht hochgeladen');
    await d.stop();

    // only the case changes
    state.name = 'diss';
    d = await startDesktop(remote.url, root);
    assert.ok(await until(() => fs.readdirSync(path.join(root, 'local')).includes('diss')), 'Groß-/Kleinschreibung\n' + d.log());
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'local')), ['diss']);
    await d.stop();

    // folder of another account/project with the wanted name: not taken over
    const root2 = tmp();
    fs.mkdirSync(path.join(root2, 'local', 'diss'), { recursive: true });
    fs.writeFileSync(path.join(root2, 'local', 'diss', '.latex-ide-project.json'), JSON.stringify({ projectId: 'x9', server: 'https://anders.example' }));
    fs.writeFileSync(path.join(root2, 'local', 'diss', 'fremd.tex'), 'fremd');
    d = await startDesktop(remote.url, root2);
    assert.ok(await until(() => fs.existsSync(path.join(root2, 'local', 'diss (p1)', 'main.tex'))), 'eigener Ordner mit Id\n' + d.log());
    assert.strictEqual(fs.readFileSync(path.join(root2, 'local', 'diss', 'fremd.tex'), 'utf8'), 'fremd');
    await d.stop();
  } finally {
    await remote.close();
  }
});

test('Offline: kein Request vor dem ersten Ping, laufende Anfragen werden beim Offline-Gehen abgebrochen', async () => {
  const root = tmp();
  // server down from the start: the first request must not even reach it (only the ping does)
  const state = { name: 'Thesis', down: true, files: new Map() };
  const remote = await startRemote(state);
  let d;
  try {
    d = await startDesktop(remote.url, root);
    const t = await d.get('/api/comments');
    assert.strictEqual(t.status, 503);
    assert.strictEqual((await d.get('/api/desktop/info')).json.online, false);
    assert.deepStrictEqual(remote.log.gets, [], 'Server nie mit einer Anfrage belästigt');
    // up, then a hanging request, then the tunnel goes down: it ends within the ping cycle, not after 15 s
    state.down = false;
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      ok = (await d.get('/api/desktop/info')).json.online;
    }
    assert.ok(ok, 'wieder online');
    const t0 = Date.now();
    const hung = d.get('/api/hang');
    await until(() => remote.log.gets.includes('/api/hang'), 5000);
    state.down = true;
    const r = await hung;
    assert.strictEqual(r.status, 503);
    assert.ok(Date.now() - t0 < 10000, `abgebrochen nach ${Date.now() - t0} ms`);
  } finally {
    if (d) await d.stop();
    await remote.close();
  }
});
