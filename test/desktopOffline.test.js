// Desktop app (server/desktop.js) against a fake remote server: offline detection and offline answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');

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

// Fake remote: `state.down` = tunnel answers 502 without the app header (Funnel up, Pi off).
// `state.active` = the user's active project on the server.
async function startRemote(state) {
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
    if (req.method === 'HEAD') return send(200, {});
    if (u.pathname === '/api/collab/owned') return send(200, { projects: [{ name: 'Thesis', projectId: 'Thesis' }] });
    if (u.pathname === '/api/tree') return send(200, { tree: [], mainFile: 'main.tex', projectId: state.active });
    if (u.pathname === '/api/projects/open') {
      let b = '';
      req.on('data', (d) => (b += d));
      return req.on('end', () => {
        state.active = JSON.parse(b).root === '/shared' ? 'users/u2/Shared' : 'Thesis';
        send(200, { projectId: state.active, mainFile: 'main.tex', role: 'owner' });
      });
    }
    if (u.pathname === '/api/comments') return send(200, { project: state.active });
    if (u.pathname === '/api/languagetool') return send(502, { error: 'LanguageTool nicht erreichbar' });
    send(404, { error: 'unbekannt' }); // manifest etc.: background sync just fails
  });
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}

async function startDesktop(remoteUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-desk-'));
  const data = path.join(dir, 'data');
  const local = path.join(dir, 'local');
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(local, 'Thesis'), { recursive: true });
  fs.writeFileSync(path.join(local, 'Thesis', 'main.tex'), 'THESIS');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ token: 'lide_test' }));
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
  const call = async (method, url, { pid, body } = {}) => {
    const headers = { cookie: `csrfToken=${csrf}`, 'x-csrf-token': csrf };
    if (pid) headers['x-project-id'] = pid;
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, offline: r.headers.get('x-offline') === '1' };
  };
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { call, stop, local, log: () => log };
}

test('#50: 502 der App selbst (LanguageTool) schaltet die Desktop-App nicht offline', async () => {
  const state = { active: 'Thesis', down: false };
  const remote = await startRemote(state);
  const d = await startDesktop(remote.url);
  try {
    const lt = await d.call('GET', '/api/languagetool');
    assert.strictEqual(lt.status, 502, 'Antwort der App wird durchgereicht');
    assert.strictEqual(lt.json.error, 'LanguageTool nicht erreichbar');
    assert.strictEqual((await d.call('GET', '/api/desktop/info')).json.online, true);
    // Tunnel 502 without the app header still means offline.
    state.down = true;
    const t = await d.call('GET', '/api/comments');
    assert.strictEqual(t.status, 503);
    assert.strictEqual((await d.call('GET', '/api/desktop/info')).json.online, false);
  } finally {
    await d.stop();
    await remote.close();
  }
});

test('#50: Server kennzeichnet seine Antworten mit X-Latex-IDE', async () => {
  const { startServer } = require('./_server');
  const s = await startServer();
  try {
    for (const url of ['/', '/api/tree', '/gibt-es-nicht']) {
      assert.strictEqual((await fetch(s.base + url)).headers.get('x-latex-ide'), '1', url);
    }
  } finally {
    await s.stop();
  }
});

test('#49: offline nach Wechsel in ein geteiltes Projekt - Baum, Cache und Kompilieren bleiben beim geteilten Projekt', async () => {
  const state = { active: 'Thesis', down: false };
  const remote = await startRemote(state);
  const d = await startDesktop(remote.url);
  try {
    // Own project Thesis first, then the shared project S (never compiled there).
    await d.call('POST', '/api/projects/open', { body: { root: '/thesis' } });
    assert.strictEqual((await d.call('GET', '/api/tree')).json.projectId, 'Thesis');
    assert.strictEqual((await d.call('GET', '/api/comments', { pid: 'Thesis' })).json.project, 'Thesis');
    await d.call('POST', '/api/projects/open', { pid: 'Thesis', body: { root: '/shared' } });
    assert.strictEqual((await d.call('GET', '/api/tree')).json.projectId, 'users/u2/Shared');
    assert.strictEqual((await d.call('GET', '/api/comments', { pid: 'users/u2/Shared' })).json.project, 'users/u2/Shared');

    state.down = true;
    const tree = await d.call('GET', '/api/tree', { pid: 'users/u2/Shared' });
    assert.strictEqual(tree.json.projectId, 'users/u2/Shared', 'Baum kommt nicht aus der lokalen Kopie von Thesis');
    assert.ok(tree.offline);
    assert.strictEqual((await d.call('GET', '/api/comments', { pid: 'users/u2/Shared' })).json.project, 'users/u2/Shared');
    assert.strictEqual((await d.call('GET', '/api/comments', { pid: 'Thesis' })).json.project, 'Thesis', 'Cache pro Projekt');
    const raw = await d.call('GET', '/api/file?path=main.tex', { pid: 'users/u2/Shared' });
    assert.notStrictEqual(raw.json && raw.json.content, 'THESIS');

    const c = await d.call('POST', '/api/compile', { pid: 'users/u2/Shared', body: { overrides: { 'main.tex': 'TEXT AUS DEM GETEILTEN PROJEKT' } } });
    assert.strictEqual(c.status, 503);
    assert.strictEqual(c.json.offline, true);
    assert.strictEqual(fs.readFileSync(path.join(d.local, 'Thesis', 'main.tex'), 'utf8'), 'THESIS', 'lokale Kopie von Thesis unverändert');

    // PDF of the last compiled project is not handed to a window of another project.
    assert.strictEqual((await d.call('GET', '/api/pdf?path=main.pdf', { pid: 'Thesis' })).status, 400);

    // The own project still works offline from its copy.
    const own = await d.call('GET', '/api/file?path=main.tex', { pid: 'Thesis' });
    assert.strictEqual(own.json.content, 'THESIS');
  } finally {
    await d.stop();
    await remote.close();
  }
});
