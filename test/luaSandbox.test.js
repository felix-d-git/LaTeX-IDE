// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// LuaLaTeX in the compile sandbox (#119): lualatex runs with server/lib/luaSandbox.lua, Lua in
// a document reaches no more than TeX's \input with openin_any=p (no ../, no absolute paths
// outside the project and the TeX/font folders), the shared font cache stays read-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { compile, texCommand, luaLatexCommand, luaEnv, seedFontNames, LUA_SANDBOX, FONT_CACHE_DIR } = require('../server/lib/compile');

const runs = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }).status === 0;
const hasLua = runs('latexmk', ['-v']) && runs('lualatex', ['--version']);
// REQUIRE_TEX (CI with TeX Live): fail instead of skipping.
const skipTex = !hasLua && !process.env.REQUIRE_TEX && 'latexmk/lualatex fehlt';
const OUT = '.latex-ide-out/u-1';

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lide-lua-'));
  test.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// Smallest valid PDF with one page whose content stream carries `text`.
function tinyPdf(text) {
  const content = `% ${text}\n`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return pdf + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// Text in the PDF, also inside compressed streams.
function pdfContains(file, needle) {
  if (!file || !fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  if (buf.includes(needle)) return true;
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      if (zlib.inflateSync(buf.subarray(start, end)).includes(needle)) return true;
    } catch {}
  }
  return false;
}

test('luaLatexCommand: Sandbox-Pfad sicher für latexmk und die Shell gequotet (#119)', () => {
  assert.strictEqual(luaLatexCommand('/app/server/lib/luaSandbox.lua', false), "lualatex --lua='/app/server/lib/luaSandbox.lua' %O %S");
  assert.strictEqual(luaLatexCommand("/opt/it's 100%/x.lua", false), "lualatex --lua='/opt/it'\\''s 100%%/x.lua' %O %S");
  assert.strictEqual(luaLatexCommand('C:\\Program Files\\LatexIDE\\server\\lib\\luaSandbox.lua', true), 'lualatex --lua="C:/Program Files/LatexIDE/server/lib/luaSandbox.lua" %O %S');
  for (const bad of ['C:\\a"b\\x.lua', 'C:\\100%\\x.lua']) assert.strictEqual(luaLatexCommand(bad, true), null, bad);
  assert.strictEqual(luaLatexCommand('/a\nb/x.lua', false), null);
  assert.ok(fs.existsSync(LUA_SANDBOX));
});

test('texCommand: nur lualatex läuft mit dem Sandbox-Skript (#119)', () => {
  const [, lua] = texCommand('main.tex', { compiler: 'lualatex' }, OUT);
  assert.ok(lua.includes('-lualatex'));
  assert.ok(lua.includes(`-lualatex=${luaLatexCommand()}`));
  assert.ok(lua.indexOf('-norc') < lua.indexOf('-lualatex'));
  for (const compiler of ['pdflatex', 'xelatex', undefined]) {
    const [, args] = texCommand('main.tex', { compiler }, OUT);
    assert.ok(!args.some((a) => a.startsWith('-lualatex')), String(compiler));
  }
});

test('luaEnv: eigener Font-Cache relativ zum Projekt, Caches der Installation nur dahinter (#119)', () => {
  const d = path.delimiter;
  assert.deepStrictEqual(luaEnv({}, path.join('.latex-ide-out', 'u-1')), { TEXMFCACHE: `.latex-ide-out/u-1/${FONT_CACHE_DIR}${d}$TEXMFSYSVAR${d}$TEXMFVAR` });
  assert.deepStrictEqual(luaEnv({ TEXMFCACHE: '/srv/cache' }, '.latex-ide-out'), { TEXMFCACHE: `.latex-ide-out/${FONT_CACHE_DIR}${d}/srv/cache` });
});

test('seedFontNames: Namensdatenbank der Installation einmal kopieren, nie überschreiben (#119)', async () => {
  const base = tmp();
  const shared = path.join(base, 'texmf-var');
  const names = path.join(shared, 'luatex-cache', 'generic', 'names');
  fs.mkdirSync(names, { recursive: true });
  fs.writeFileSync(path.join(names, 'luaotfload-names.lua.gz'), 'vorab gebaut');
  fs.writeFileSync(path.join(names, 'luaotfload-lookup-cache.lua'), 'nicht kopieren');
  const out = path.join(base, 'projekt', OUT);
  const dest = path.join(out, FONT_CACHE_DIR, 'luatex-cache', 'generic', 'names');

  assert.strictEqual(await seedFontNames(out, [path.join(base, 'fehlt'), shared]), true);
  assert.deepStrictEqual(fs.readdirSync(dest), ['luaotfload-names.lua.gz']);
  fs.writeFileSync(path.join(dest, 'luaotfload-names.lua.gz'), 'im Projekt neu gebaut');
  assert.strictEqual(await seedFontNames(out, [shared]), false);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'luaotfload-names.lua.gz'), 'utf8'), 'im Projekt neu gebaut');
  assert.strictEqual(await seedFontNames(path.join(base, 'leer'), [path.join(base, 'fehlt')]), false);
  assert.ok(!fs.existsSync(path.join(base, 'leer', FONT_CACHE_DIR)));
});

// Smallest ZIP archive with one stored (uncompressed) entry.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function tinyZip(name, text) {
  const data = Buffer.from(text);
  const file = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(10, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

// One project for all TeX runs: the per-project font cache is built only once.
function lab() {
  const base = tmp();
  const root = path.join(base, 'projekt');
  const geheim = path.join(base, 'geheim');
  fs.mkdirSync(root);
  fs.mkdirSync(geheim);
  fs.mkdirSync(path.join(base, 'anderes-projekt'));
  fs.writeFileSync(path.join(base, 'anderes-projekt', 'main.tex'), 'GEHEIM-ANDERES\n');
  fs.writeFileSync(path.join(geheim, 'auth-data.json'), '{"x":"GEHEIM-AUTH"}\n');
  fs.writeFileSync(path.join(geheim, 'zugang.env'), 'GEHEIM_KEY=GEHEIM-ENV\n');
  fs.writeFileSync(path.join(geheim, 'modul.lua'), 'x = "GEHEIM-LUA"\n');
  fs.writeFileSync(path.join(geheim, 'geheim.pdf'), tinyPdf('GEHEIM-PDF'));
  fs.writeFileSync(path.join(geheim, 'archiv.zip'), tinyZip('geheim.txt', 'GEHEIM-ZIP\n'));
  fs.writeFileSync(path.join(geheim, 'merkmale.fea'), 'GEHEIMWORT feature\n');
  for (const f of ['opfer.txt', 'opfer2.txt']) fs.writeFileSync(path.join(geheim, f), 'opfer\n');
  const gemeinsam = path.join(base, 'gemeinsam');
  fs.mkdirSync(gemeinsam);
  const lua = (p) => `[==[${p.split(path.sep).join('/')}]==]`;
  fs.writeFileSync(path.join(root, 'pfade.lua'), `return { geheim = ${lua(geheim)}, gemeinsam = ${lua(gemeinsam)} }\n`);
  const tex = (name, body, pre = '') =>
    fs.writeFileSync(path.join(root, name), `\\documentclass{article}\n${pre}\\edef\\geheim{\\directlua{tex.sprint(-2, dofile("pfade.lua").geheim)}}\n\\begin{document}\nHallo\n${body}\n\\end{document}\n`);
  return { base, root, geheim, gemeinsam, tex, files: () => fs.readdirSync(geheim).sort() };
}

// Every probe reports LECK (got through), GESPERRT (nil/false, a refusal by the sandbox or by
// luatex-core with the sandbox's check, or where given another error that means "not found")
// or FEHLER (the probe itself broke and would prove nothing). The control run without the
// sandbox shows that each probe can leak.
const ANGRIFF = String.raw`
local G = dofile("pfade.lua").geheim
local function has(s) return type(s) == "string" and s:find("GEHEIM", 1, true) ~= nil end
local REFUSED = { "LaTeX-IDE: Zugriff", "LuaTeX: operation not permitted", "patched 'io.lines' can't open" }
local function try(name, f, notfound)
  local ok, r = pcall(f)
  local e = ok and "" or tostring(r)
  local refused = notfound and e:find(notfound, 1, true)
  for _, s in ipairs(REFUSED) do refused = refused or e:find(s, 1, true) end
  local status = "FEHLER "
  if ok then
    status = r and "LECK " or "GESPERRT "
  elseif refused then
    status = "GESPERRT "
  else
    name = name .. " (" .. e:gsub("GEHEIM", "G.") .. ")"
  end
  texio.write_nl("term and log", status .. name)
end
-- A font for the fontloader probes: TeX Live's Latin Modern, else one of the system's.
local function schrift()
  local list = { kpse.find_file("lmroman10-regular.otf", "opentype fonts") }
  local win = os.getenv("WINDIR") or os.getenv("SystemRoot")
  if win then list[#list + 1] = win .. "/Fonts/arial.ttf" end
  list[#list + 1] = "/System/Library/Fonts/Supplemental/Arial.ttf"
  list[#list + 1] = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
  for _, f in ipairs(list) do
    local h = io.open(f, "rb")
    if h then h:close() return f end
  end
end
local SCHRIFT = schrift()
local function mit_schrift(name, f)
  if SCHRIFT then try(name, f) else texio.write_nl("term and log", "OHNE " .. name) end
end
try("io.open", function() local f = io.open(G .. "/auth-data.json"); return f and has(f:read("a")) end)
try("io.open ../", function() local f = io.open("../anderes-projekt/main.tex"); return f and has(f:read("a")) end)
try("io.open schreiben", function() local f = io.open(G .. "/neu.txt", "w"); if f then f:write("x"); f:close(); return true end end)
try("io.lines", function() for l in io.lines(G .. "/auth-data.json") do if has(l) then return true end end end)
try("io.input", function() io.input(G .. "/auth-data.json"); local s = io.read("a"); io.input(io.stdin); return has(s) end)
try("io.output", function() io.output(G .. "/neu.txt"); io.write("x"); io.close(); io.output(io.stdout); return true end)
try("loadfile", function() local env = {}; local f, e = loadfile(G .. "/modul.lua", "t", env); if not f then return has(e) end; f(); return has(env.x) end)
try("dofile", function() dofile(G .. "/modul.lua"); return has(x) end)
try("require", function() require(G .. "/modul"); return has(x) end, "not found")
try("os.remove", function() return os.remove(G .. "/opfer.txt") end)
try("os.rename", function() return os.rename(G .. "/opfer2.txt", "gestohlen.txt") end)
try("os.tmpdir", function() return os.tmpdir(G .. "/neuXXXXXX") ~= nil end)
try("os.tmpdir ../", function() return os.tmpdir("../geheim/neuXXXXXX") ~= nil end)
try("os.tmpname", function() local n = os.tmpname(); os.remove(n); return n ~= nil end)
try("lfs.dir", function() for n in lfs.dir(G) do if n == "auth-data.json" then return true end end end)
try("lfs.attributes", function() return lfs.attributes(G .. "/auth-data.json") ~= nil end)
try("lfs.mkdir", function() return lfs.mkdir(G .. "/neu") end)
try("kpse.find_file", function() return kpse.find_file(G .. "/auth-data.json") ~= nil end)
try("kpse.new", function() return kpse.new("lualatex"):find_file(G .. "/auth-data.json") ~= nil end)
try("package.searchpath", function() return package.searchpath("auth-data", G .. "/?.json") ~= nil end)
try("zip.open", function() local z = zip.open(G .. "/archiv.zip"); local f = z and z:open("geheim.txt"); return f and has(f:read("*a")) end)
try("zip.openfile", function() local f = zip.openfile(G .. "/auth-data.json"); return f and has(f:read("*a")) end)
try("zip.openfile Archiv", function() local f = zip.openfile(G .. "/archiv/geheim.txt"); return f and has(f:read("*a")) end)
-- zziplib puts "." + extension behind each folder of the name: x./../../geheim/archiv.zip
lfs.mkdir("x.")
try("zip.openfile Endung", function() local f = zip.openfile("x/geheim.txt", "/../../geheim/archiv.zip"); return f and has(f:read("*a")) end)
try("zip.openfile Endungsliste", function() local f = zip.openfile("x/geheim.txt", { "/../../geheim/archiv.zip" }); return f and has(f:read("*a")) end)
try("gzip.open", function() local f = gzip.open(G .. "/auth-data.json"); return f and has(f:read("*a")) end)
try("gzip.lines", function() for l in gzip.lines(G .. "/auth-data.json") do if has(l) then return true end end end)
try("gzip.lines ../", function() for l in gzip.lines("../anderes-projekt/main.tex") do if has(l) then return true end end end)
mit_schrift("fontloader.apply_featurefile", function()
  local r = fontloader.apply_featurefile(fontloader.open(SCHRIFT), G .. "/merkmale.fea")
  return type(r) == "table" and has(table.concat(r, " "))
end)
mit_schrift("fontloader.apply_afmfile", function() fontloader.apply_afmfile(fontloader.open(SCHRIFT), G .. "/merkmale.fea"); return true end)
try("pdfe.open", function() local d = pdfe and pdfe.open(G .. "/geheim.pdf"); return d ~= nil and pdfe.getnofpages(d) > 0 end)
try("pdf.immediateobj", function() return pdf.immediateobj("streamfile", G .. "/auth-data.json") ~= nil end)
try("pdf.obj", function() return pdf.obj({ type = "stream", file = G .. "/auth-data.json", immediate = true }) ~= nil end)
try("harfbuzz", function() local b = require("luaharfbuzz").Blob.new_from_file(G .. "/auth-data.json"); return b and has(b:get_data()) end)
try("mplib", function()
  local mp = mplib.new({ ini_version = true })
  local r = mp:execute('string s; s := readfrom "' .. G .. '/auth-data.json"; message s;')
  return r and (has(r.log) or has(r.term))
end)
try("fremder Bytecode", function()
  local b = string.dump(load('return "AAAAAA"')):gsub("AAAAAA", "GEHEIM")
  local f = load(b)
  return f and has(f())
end)
try("debug", function() return debug ~= nil and debug.getupvalue ~= nil end)
try("io.popen", function() local f = io.popen("cat " .. G .. "/auth-data.json"); return f and has(f:read("a")) end)
os.execute("mkdir " .. G .. "/neu-exec")
os.setenv("openin_any", "a")
texio.write_nl("term and log", "LUA-ENDE")
`;
const PROBEN = [...ANGRIFF.matchAll(/(?:try|mit_schrift)\("([^"]+)"/g)].map((m) => m[1]);
// LuaTeX refuses these itself, sandbox or not: no debug library without --luadebug (TeX
// Live 2023+), "cat" is not on the list of restricted \write18 commands.
const SCHON_OHNE_SANDBOX = ['debug', 'io.popen'];

// Result per probe from the log: { status, text }.
function proben(log) {
  const res = {};
  for (const line of log.split(/\r?\n/)) {
    const m = /^(LECK|GESPERRT|FEHLER|OHNE) (.*)$/.exec(line);
    if (!m) continue;
    const name = PROBEN.find((p) => m[2] === p || m[2].startsWith(`${p} (`));
    if (name) res[name] = { status: m[1], text: line };
  }
  return res;
}
// Probes whose status is not one of `ok` (missing ones included), for the assertion message.
function abweichend(res, ok, skip = []) {
  return PROBEN.filter((p) => !skip.includes(p) && !ok.includes(res[p] && res[p].status)).map((p) => (res[p] ? res[p].text : `FEHLT ${p}`));
}

test('LuaLaTeX: Lua kommt nicht aus dem Projekt heraus, TeX-\\openin auch nicht (#119)', { skip: skipTex, timeout: 900000 }, async () => {
  const L = lab();
  fs.writeFileSync(path.join(L.root, 'angriff.lua'), ANGRIFF);
  L.tex('main.tex', [
    '\\newread\\r',
    '\\openin\\r=\\geheim/auth-data.json',
    '\\ifeof\\r\\typeout{GESPERRT openin absolut}\\else\\typeout{LECK openin absolut}\\fi',
    '\\openin\\r=../anderes-projekt/main.tex',
    '\\ifeof\\r\\typeout{GESPERRT openin ../}\\else\\typeout{LECK openin ../}\\fi',
    '\\typeout{SANDBOX-ENDE}',
  ].join('\n'), '\\directlua{dofile("angriff.lua")}\n');
  const before = L.files();
  const r = await compile(L.root, 'main.tex', { compiler: 'lualatex' }, OUT, 600000);
  // Without the sandbox lualatex aborts while loading luaotfload: nothing of the above ran.
  assert.match(r.log, /LUA-ENDE/, r.log.slice(-3000));
  assert.match(r.log, /SANDBOX-ENDE/, r.log.slice(-3000));
  assert.deepStrictEqual(abweichend(proben(r.log), ['GESPERRT', 'OHNE']), []);
  assert.deepStrictEqual(r.log.match(/(LECK|FEHLER) [^\n]*/g), null);
  assert.doesNotMatch(r.log, /GEHEIM/);
  assert.ok(r.pdfPath, r.log.slice(-3000));
  assert.ok(!pdfContains(path.join(L.root, r.pdfPath), 'GEHEIM'));
  assert.deepStrictEqual(L.files(), before);
  assert.ok(!fs.existsSync(path.join(L.root, 'gestohlen.txt')));

  // TeX: \input of another project / of an absolute path.
  L.tex('relativ.tex', '\\input{../anderes-projekt/main.tex}');
  L.tex('absolut.tex', '\\input{\\geheim/auth-data.json}');
  // LuaTeX looks up images and \pdfextension obj file without openin_any: callbacks.
  L.tex('objekt.tex', '\\immediate\\pdfextension obj stream file {\\geheim/auth-data.json}');
  L.tex('bild.tex', '\\directlua{img.write(img.scan({ filename = dofile("pfade.lua").geheim .. "/geheim.pdf" }))}');
  // A map file's first word per line ends up in a warning in the log.
  L.tex('karte.tex', '\\pdfextension mapfile{\\geheim/zugang.env}');
  for (const main of ['relativ.tex', 'absolut.tex', 'objekt.tex', 'bild.tex', 'karte.tex']) {
    const res = await compile(L.root, main, { compiler: 'lualatex' }, OUT, 600000);
    assert.doesNotMatch(res.log, /GEHEIM/, main);
    assert.ok(!pdfContains(res.pdfPath && path.join(L.root, res.pdfPath), 'GEHEIM'), main);
    // The font cache works (no luaotfload abort) - the run reached the document.
    assert.doesNotMatch(res.log, /luaotfload.*(FATAL|no writeable cache)/i, main);
  }
  assert.deepStrictEqual(L.files(), before);
});

test('LuaLaTeX ohne Sandbox (Gegenprobe): jede Lua-Probe kommt an ihr Ziel (#119)', { skip: skipTex, timeout: 900000 }, async () => {
  const L = lab();
  fs.writeFileSync(path.join(L.root, 'angriff.lua'), ANGRIFF);
  L.tex('main.tex', '', '\\directlua{dofile("angriff.lua")}\n');
  // Plain lualatex, TeX may read and write anywhere; luaotfload gets a cache of its own.
  const cache = path.join(L.base, 'cache');
  await seedFontNames(cache);
  const env = { ...process.env, openin_any: 'a', openout_any: 'a', TEXMFCACHE: path.join(cache, FONT_CACHE_DIR), max_print_line: '10000' };
  delete env.TEXMFOUTPUT;
  spawnSync('lualatex', ['-interaction=nonstopmode', 'main.tex'], { cwd: L.root, env, stdio: 'ignore', windowsHide: true, timeout: 600000 });
  const log = fs.readFileSync(path.join(L.root, 'main.log'), 'latin1');
  assert.match(log, /LUA-ENDE/, log.slice(-3000));
  assert.deepStrictEqual(abweichend(proben(log), ['LECK', 'OHNE'], SCHON_OHNE_SANDBOX), []);
});

test('Lua-Sandbox: unbekannte Funktionen der Datei-Bibliotheken werden entfernt (#119)', { skip: skipTex, timeout: 120000 }, () => {
  const d = tmp();
  const libs = ['io', 'os', 'lfs', 'zip', 'gzip', 'fontloader', 'font', 'img', 'pdfe', 'mplib', 'kpse', 'package'];
  const list = libs.map((l) => `"${l}"`).join(', ');
  // Stands in for a newer LuaTeX: one more function per library before the sandbox runs.
  fs.writeFileSync(path.join(d, 'start.lua'), [
    `for _, l in ipairs({ ${list} }) do _G[l].neu_in_luatex = function() return "OFFEN" end end`,
    'if luaharfbuzz then luaharfbuzz.neu_in_luatex = print; luaharfbuzz.Face.neu_in_luatex = print end',
    `dofile([==[${LUA_SANDBOX.split(path.sep).join('/')}]==])`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'pruefen.lua'), [
    'local t = {}',
    `for _, l in ipairs({ ${list} }) do t[#t + 1] = l .. "=" .. type(_G[l].neu_in_luatex) end`,
    'local hb = luaharfbuzz or { Face = {} }',
    't[#t + 1] = "hb=" .. type(hb.neu_in_luatex) .. "/" .. type(hb.Face.neu_in_luatex)',
    'texio.write_nl("term and log", "NEU " .. table.concat(t, " "))',
    'texio.write_nl("term and log", "ALT " .. type(io.open) .. " " .. type(gzip.lines) .. " " .. type(kpse.find_file) .. " " .. type(os.tmpdir))',
    '',
  ].join('\n'));
  // INITEX: no format, braces need their catcodes first.
  fs.writeFileSync(path.join(d, 'main.tex'), '\\catcode`\\{=1 \\catcode`\\}=2 \\directlua{dofile("pruefen.lua")}\\end\n');
  const env = { ...process.env, openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: d, max_print_line: '10000' };
  const r = spawnSync('lualatex', [`--lua=${path.join(d, 'start.lua')}`, '--ini', '-interaction=nonstopmode', 'main.tex'], { cwd: d, env, encoding: 'latin1', windowsHide: true, timeout: 100000 });
  const out = String(r.stdout);
  assert.ok(out.includes(`NEU ${libs.map((l) => `${l}=nil`).join(' ')} hb=nil/nil`), out.slice(-3000));
  assert.ok(out.includes('ALT function function function function'), out.slice(-3000));
});

test('LuaLaTeX: Dateien im Projekt bleiben nutzbar (Bild, Lua-Modul, Daten, Unterordner) (#119)', { skip: skipTex, timeout: 900000 }, async () => {
  const L = lab();
  fs.mkdirSync(path.join(L.root, 'kapitel', 'bilder'), { recursive: true });
  fs.writeFileSync(path.join(L.root, 'kapitel', 'bilder', 'bild.pdf'), tinyPdf('BILD-IM-PROJEKT'));
  fs.writeFileSync(path.join(L.root, 'werte.lua'), 'return { gruss = "Hallo aus dem Modul" }\n');
  fs.writeFileSync(path.join(L.root, 'kapitel', 'daten.txt'), 'Zeile aus Datei\n');
  fs.writeFileSync(path.join(L.root, 'kapitel', 'main.tex'), [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\directlua{tex.sprint(require("werte").gruss)}',
    '\\directlua{for l in io.lines("kapitel/daten.txt") do tex.sprint(l) end}',
    '\\includegraphics[width=1cm]{bilder/bild.pdf}',
    '\\immediate\\pdfextension obj stream file {kapitel/daten.txt}',
    '\\end{document}',
    '',
  ].join('\n'));
  const r = await compile(L.root, 'kapitel/main.tex', { compiler: 'lualatex' }, OUT, 600000);
  assert.ok(r.success, r.log.slice(-3000));
  const pdf = path.join(L.root, r.pdfPath);
  assert.ok(pdfContains(pdf, 'BILD-IM-PROJEKT'));
  assert.ok(pdfContains(pdf, 'Zeile aus Datei'));
});

// lualibs' lfs.isdir asks for attributes("<folder>/.") on Windows, or wherever PATH contains a
// ";" - which brings that code path to macOS and Linux, too. luaotfload checks its cache folder
// with it: refusing "<folder>/." meant "no writeable cache path" on every Windows run.
test('LuaLaTeX: "Ordner/." gilt als der Ordner, auch mit lualibs im Windows-Modus (#119)', { skip: skipTex, timeout: 900000 }, async () => {
  const L = lab();
  fs.mkdirSync(path.join(L.root, 'kapitel'));
  fs.mkdirSync(path.join(L.root, '.versteckt'));
  L.tex('main.tex', [
    '\\directlua{',
    '  local function zeig(n, v) texio.write_nl("term and log", "PUNKT " .. n .. "=" .. tostring(v)) end',
    '  zeig("relativ", lfs.attributes("kapitel/.", "mode"))',
    '  zeig("absolut", lfs.attributes(lfs.currentdir() .. "/kapitel/.", "mode"))',
    '  zeig("isdir", lfs.isdir("kapitel"))',
    '  zeig("versteckt", lfs.attributes(".versteckt/.", "mode"))',
    '  zeig("geheim", lfs.attributes(dofile("pfade.lua").geheim .. "/.", "mode"))',
    '  zeig("geheim-isdir", lfs.isdir(dofile("pfade.lua").geheim))',
    '}',
  ].join('\n'));
  const saved = process.env.PATH;
  process.env.PATH = `${saved}${path.delimiter}lide-windows-modus;x`;
  try {
    const r = await compile(L.root, 'main.tex', { compiler: 'lualatex' }, OUT, 600000);
    assert.doesNotMatch(r.log, /luaotfload.*(FATAL|no writeable cache)/i, r.log.slice(-3000));
    const punkte = Object.fromEntries([...r.log.matchAll(/PUNKT ([\w-]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
    assert.deepStrictEqual(punkte, {
      relativ: 'directory',
      absolut: 'directory',
      isdir: 'true',
      // Like kpathsea: hidden names stay refused, a folder outside the project as well.
      versteckt: 'nil',
      geheim: 'nil',
      'geheim-isdir': 'false',
    });
    assert.ok(r.pdfPath, r.log.slice(-3000));
    assert.ok(fs.existsSync(path.join(L.root, OUT, FONT_CACHE_DIR, 'luatex-cache', 'generic')));
  } finally {
    process.env.PATH = saved;
  }
});

test('LuaLaTeX: gemeinsamer Font-Cache bleibt unverändert, das Projekt bekommt einen eigenen (#119)', { skip: skipTex, timeout: 900000 }, async () => {
  const L = lab();
  // kpathsea's own check lets Lua write to TEXMFVAR, a cache all projects' runs load code from.
  L.tex('main.tex', '\\directlua{local f = io.open(dofile("pfade.lua").gemeinsam .. "/luatex-cache.lua", "w") texio.write_nl("term and log", f and "LECK" or "GESPERRT")}');
  const saved = { TEXMFVAR: process.env.TEXMFVAR, TEXMFCACHE: process.env.TEXMFCACHE };
  process.env.TEXMFVAR = L.gemeinsam;
  process.env.TEXMFCACHE = L.gemeinsam;
  try {
    const r = await compile(L.root, 'main.tex', { compiler: 'lualatex' }, OUT, 600000);
    assert.ok(r.pdfPath, r.log.slice(-3000));
    assert.match(r.log, /GESPERRT/);
    assert.deepStrictEqual(fs.readdirSync(L.gemeinsam), []);
    assert.ok(fs.existsSync(path.join(L.root, OUT, FONT_CACHE_DIR, 'luatex-cache', 'generic')));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
