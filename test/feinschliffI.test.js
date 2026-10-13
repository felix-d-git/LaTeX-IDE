const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('comments.save schreibt atomar, kaputte Datei wird gesichert', () => {
  const comments = require('../server/lib/comments');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsI-'));
  fs.writeFileSync(path.join(root, comments.COMMENTS_FILE), '{kaputt');
  comments.listAll(root);
  const files = fs.readdirSync(root);
  assert.ok(files.some((f) => f.includes('.corrupt-')), files.join());
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('.env.example setzt PUBLIC_URL nicht aktiv', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(!/^PUBLIC_URL=/m.test(s));
});
