-- SPDX-License-Identifier: AGPL-3.0-only
-- SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
--
-- LuaTeX startup script of the compile sandbox (#119), run as `lualatex --lua=<this file>`.
--
-- TeX runs with openin_any=p: no \input of absolute paths or ../ (other projects,
-- auth-data.json). Since TeX Live 2023 LuaTeX applies that kpathsea check to Lua's io.open
-- as well, so luaotfload cannot read its own files from texmf-dist (ScriptExtensions.txt,
-- the fonts) and every lualatex run aborts. TeX Live 2022 and older check nothing in Lua,
-- and even 2023+ leaves loadfile, io.output, zip, gzip, pdfe, pdf.obj, luaharfbuzz, mplib,
-- image/map/data file lookups and Lua bytecode open.
--
-- This script runs before LuaTeX's own luatex-core.lua and before the format. It sets the
-- policy below for everything Lua can open, so lualatex works with openin_any=p and Lua
-- reaches no more than TeX. TeX's own \input/\openin keep the kpathsea check; \write18,
-- io.popen and os.execute stay restricted by LuaTeX (same command list as for pdflatex).
--
-- Policy (paths normalised to "/", a ".." segment is never allowed):
--   read:  relative paths (the project), absolute paths in the project or TEXMFOUTPUT,
--          and the TeX trees ($TEXMF, TEXMFVAR, TEXMFCACHE …) and system font folders,
--          read-only. Like kpathsea, no component of a path in the project may start with
--          "." ("./" and a final ".tex" aside), which also keeps the server's folders
--          (.latex-ide-yjs, .latex-ide-history, .trash, other users' output) out of reach;
--          below the run's own output folder only the components under it count.
--   write: only in the project or TEXMFOUTPUT (openout_any=p). The font cache shared by
--          all projects stays read-only; compile.js points luaotfload to one per output
--          folder (TEXMFCACHE).
-- A TeX or font folder that contains the project (e.g. TEXMFHOME = home folder with the
-- projects below it) is dropped, otherwise neighbouring projects would become readable.
-- Allowlist: every C function of the libraries that deal with files (io, os, lfs, zip, gzip,
-- fontloader, font, img, pdfe, mplib, kpse, package, luaharfbuzz) is either checked here or
-- known to open nothing by name; any other one (a newer LuaTeX) is removed at the end.

local type, tostring, ipairs, pairs, next, error, select = type, tostring, ipairs, pairs, next, error, select
local getmetatable = getmetatable
local find, gsub, sub, lower, gmatch = string.find, string.gsub, string.sub, string.lower, string.gmatch
local concat = table.concat

local EPERM = "LaTeX-IDE: Zugriff außerhalb des Projekts nicht erlaubt"
local is_windows, is_mac = os.type == "windows", os.name == "macosx"
local list_sep = is_windows and ";" or ":"
-- Taken now: document code could replace the globals before the first check.
local getenv, expand_braces, status_of = os.getenv, kpse.expand_braces, status

---------------------------------------------------------------------------------------------
-- Paths

-- Form used for all comparisons: forward slashes, no doubled slashes (a leading // of a
-- UNC path stays), no "." segments after a folder, lower case on Windows.
-- "<folder>/." is that folder (kpathsea allows "/./" as well): lualibs' lfs.isdir asks for
-- attributes("<folder>/.") on Windows (or with a ";" in PATH), luaotfload's check of its
-- cache folder included. "." on its own stays as it is.
local function norm(p)
  p = gsub(p, "\\", "/")
  local unc = sub(p, 1, 2) == "//"
  p = gsub(p, "/+", "/")
  -- Windows device paths (\\.\x, \\?\x) keep their prefix: \\.\x is not the UNC path \\x.
  if not (unc and find(p, "^/[.?]/")) then
    local n
    repeat p, n = gsub(p, "/%./", "/") until n == 0
    p = gsub(p, "/%.$", "/")
  end
  if unc then p = "/" .. p end
  if is_windows then p = lower(p) end
  return p
end

-- "C:x" (relative to the current folder of drive C) counts as absolute: never allowed
-- outside the known folders.
local function is_abs(p)
  return sub(p, 1, 1) == "/" or find(p, "^%a:") ~= nil
end

local function has_dotdot(p)
  return find("/" .. p .. "/", "/%.%./") ~= nil
end

local function strip_slash(p)
  while #p > 1 and sub(p, -1) == "/" and not find(p, "^%a:/$") do p = sub(p, 1, -2) end
  return p
end

-- kpathsea (openin_any/openout_any = p) refuses every path component that starts with "."
-- (".rhosts", ".ssh/x") except "." itself and a final ".tex". `whole`: rel is a path of its
-- own (not the part below a folder), so it must name something other than ".".
local function names_ok(rel, whole)
  local parts = {}
  for part in gmatch(rel, "[^/]+") do parts[#parts + 1] = part end
  if whole and (#parts == 0 or parts[#parts] == ".") then return false end
  for i, part in ipairs(parts) do
    if part ~= "." and sub(part, 1, 1) == "." and not (part == ".tex" and i == #parts) then return false end
  end
  return true
end

local function drop_dot_slash(p)
  while sub(p, 1, 2) == "./" do p = sub(p, 3) end
  return p
end

local function under(p, dir)
  return dir ~= nil and (p == dir or sub(p, 1, #dir + 1) == dir .. "/")
end

local function abs_dir(d)
  if type(d) ~= "string" or d == "" then return nil end
  d = norm(d)
  if not is_abs(d) or has_dotdot(d) then return nil end
  return strip_slash(d)
end

local project = abs_dir(lfs.currentdir())
local outdir = abs_dir(getenv("TEXMFOUTPUT"))
-- The output folder relative to the project (.latex-ide-out/u-1): compile.js passes it,
-- comparing TEXMFOUTPUT with the current folder could miss it (Windows short names).
local out_rel
do
  local r = getenv("LATEX_IDE_OUT")
  if type(r) == "string" and r ~= "" then
    r = drop_dot_slash(strip_slash(norm(r)))
    if r ~= "." and not is_abs(r) and not has_dotdot(r) then out_rel = r end
  end
  if not out_rel and project and outdir and outdir ~= project and under(outdir, project) then
    out_rel = sub(outdir, #project + 2)
  end
end
local home = abs_dir(getenv("HOME") or getenv("USERPROFILE"))

-- TeX trees and font folders (read-only). Computed on first use: kpathsea is initialised
-- only after this script.
local ro_roots
local function roots()
  if ro_roots then return ro_roots end
  if status_of.kpse_used ~= 1 then return {} end
  local list = {}
  local function add(d)
    d = abs_dir(d)
    if not d or under(project or "", d) or under(outdir or "", d) then return end
    list[#list + 1] = d
  end
  for _, v in ipairs({ "TEXMF", "TEXMFDIST", "TEXMFMAIN", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG",
                       "TEXMFVAR", "TEXMFCONFIG", "TEXMFHOME", "TEXMFCACHE", "OSFONTDIR" }) do
    for d in gmatch(expand_braces("$" .. v) or "", "[^" .. list_sep .. "]+") do
      add((gsub(d, "^!!", "")))
    end
  end
  -- What luaotfload indexes besides the TeX trees.
  if is_windows then
    local windir = getenv("WINDIR") or getenv("SystemRoot")
    if windir then add(windir .. "/Fonts") end
    local lad = getenv("LOCALAPPDATA")
    if lad then add(lad .. "/Microsoft/Windows/Fonts") end
  elseif is_mac then
    for _, d in ipairs({ "/Library/Fonts", "/System/Library/Fonts", "/Network/Library/Fonts" }) do add(d) end
    if home then add(home .. "/Library/Fonts") end
  else
    for _, d in ipairs({ "/usr/share/fonts", "/usr/local/share/fonts", "/usr/share/X11/fonts", "/etc/fonts" }) do add(d) end
    if home then
      add(home .. "/.fonts")
      add(home .. "/.local/share/fonts")
    end
  end
  ro_roots = list
  return list
end

local function in_project(p)
  return under(p, project) or under(p, outdir)
end

-- p: a relative path or an absolute one in the project. Below the own output folder only the
-- components under it count (its font cache, written by luaotfload).
local function project_names_ok(p)
  if is_abs(p) then
    local top = under(p, outdir) and outdir or project
    return names_ok(sub(p, #top + 2), false)
  end
  p = drop_dot_slash(strip_slash(p))
  if under(p, out_rel) then return names_ok(sub(p, #out_rel + 2), false) end
  return names_ok(p, true)
end

local function read_ok(name)
  if type(name) ~= "string" or find(name, "%z") then return false end
  local p = norm(name)
  if has_dotdot(p) then return false end
  if not is_abs(p) or in_project(p) then return project_names_ok(p) end
  for _, d in ipairs(roots()) do
    if under(p, d) then return true end
  end
  return false
end

-- File type and symlink queries also for the folders above the allowed ones: luaotfload
-- resolves symlinks component by component from "/" (luaotfload-realpath.lua). No listings.
local function meta_ok(name)
  if read_ok(name) then return true end
  if type(name) ~= "string" or find(name, "%z") then return false end
  local p = strip_slash(norm(name))
  if has_dotdot(p) then return false end
  -- Relative: only the folders that lead to the own output folder (.latex-ide-out).
  if not is_abs(p) then
    p = drop_dot_slash(p)
    return out_rel ~= nil and sub(out_rel, 1, #p + 1) == p .. "/"
  end
  local prefix = sub(p, -1) == "/" and p or p .. "/"
  local function above(d) return d ~= nil and (p == d or sub(d, 1, #prefix) == prefix) end
  if above(project) or above(outdir) then return true end
  for _, d in ipairs(roots()) do
    if above(d) then return true end
  end
  return false
end

local function write_ok(name)
  if type(name) ~= "string" or find(name, "%z") then return false end
  local p = norm(name)
  if has_dotdot(p) or (is_abs(p) and not in_project(p)) then return false end
  return project_names_ok(p)
end

-- luatex-core.lua (TeX Live 2023+) builds its io/os/lfs wrappers on these two functions
-- and takes them from kpse when it runs, after this script. Its wrappers call the ones
-- below, so both checks apply: the loosest (meta_ok) there, the exact one here. Otherwise
-- kpathsea's "extended" check would also let Lua write to TEXMFVAR/TEXMFSYSVAR, the font
-- cache of all projects.
if kpse.in_name_ok_silent_extended then kpse.in_name_ok_silent_extended = meta_ok end
if kpse.out_name_ok_silent_extended then kpse.out_name_ok_silent_extended = write_ok end

---------------------------------------------------------------------------------------------
-- Wrappers

local function raise() error(EPERM, 2) end

local function guard(fn, check, fail)
  if type(fn) ~= "function" then return fn end
  return function(name, ...)
    if not check(name) then
      if fail then return fail(name) end
      return nil, EPERM
    end
    return fn(name, ...)
  end
end

local function is_read_mode(mode)
  return mode == nil or mode == "r" or mode == "rb" or mode == ""
end

local io_open = io.open
io.open = function(name, mode)
  if not (read_ok(name) and (is_read_mode(mode) or write_ok(name))) then return nil, EPERM end
  return io_open(name, mode)
end

local io_lines, io_input, io_output = io.lines, io.input, io.output
io.lines = function(name, ...)
  if name ~= nil and not read_ok(name) then return raise() end
  return io_lines(name, ...)
end
io.input = function(f, ...)
  if type(f) == "string" and not read_ok(f) then return raise() end
  return io_input(f, ...)
end
io.output = function(f, ...)
  if type(f) == "string" and not write_ok(f) then return raise() end
  return io_output(f, ...)
end

-- Lua 5.3 does not verify bytecode: a crafted binary chunk reads and writes memory and gets
-- around every check here. So only source code is loaded, plus bytecode that string.dump
-- produced in this run (lualibs compiles its formatters that way, luaotfload and the
-- fontloader their caches). .luc files from earlier runs are refused; luaotfload and the
-- fontloader then read the .lua variant. The env argument keeps its arity (an explicit
-- nil would replace _ENV).
local lua_load, lua_loadfile, string_dump = load, loadfile, string.dump
local digest = sha2 and sha2.digest256
local dumped = {}
local function dump_key(s) return digest and digest(s) or s end
string.dump = function(f, ...)
  local s = string_dump(f, ...)
  dumped[dump_key(s)] = true
  return s
end
local function own_bytecode(s)
  return type(s) == "string" and sub(s, 1, 1) == "\27" and dumped[dump_key(s)] == true
end

load = function(chunk, chunkname, mode, ...)
  local m = own_bytecode(chunk) and "b" or "t"
  if select("#", ...) > 0 then return lua_load(chunk, chunkname, m, ...) end
  return lua_load(chunk, chunkname, m)
end
loadfile = function(name, mode, ...)
  if name ~= nil and not read_ok(name) then return nil, EPERM end
  local n = select("#", ...)
  local f, err
  if n > 0 then f, err = lua_loadfile(name, "t", ...) else f, err = lua_loadfile(name, "t") end
  if f or name == nil or not find(tostring(err), "binary chunk", 1, true) then return f, err end
  local h = io_open(name, "rb")
  if not h then return f, err end
  local data = h:read("a")
  h:close()
  if not own_bytecode(data) then return f, err end
  if n > 0 then return lua_load(data, "=" .. name, "b", ...) end
  return lua_load(data, "=" .. name, "b")
end
dofile = function(name)
  local f, err = loadfile(name)
  if not f then error(err, 2) end
  return f()
end
if loadstring then loadstring = load end

-- require: LuaTeX's kpse searchers load any file (also bytecode, also C libraries). One
-- searcher for Lua source found by kpathsea instead ("a.b" -> a/b.lua as before).
if package then
  local searchers = package.searchers or package.loaders
  if searchers then
    local preload = searchers[1]
    for i = #searchers, 1, -1 do searchers[i] = nil end
    searchers[1] = preload
    searchers[2] = function(name)
      local file = type(name) == "string" and (kpse.find_file((gsub(name, "%.", "/")), "lua") or kpse.find_file(name, "lua"))
      if not file then return "\n\tno file '" .. tostring(name) .. "' (kpse)" end
      local f, err = loadfile(file)
      if not f then error("error loading module '" .. tostring(name) .. "' from file '" .. file .. "':\n\t" .. tostring(err), 2) end
      return f, file
    end
  end
  package.loadlib = function() return nil, EPERM end
end
-- luatex-core does the same with restricted shell escape, older versions do not.
if package and package.loaded and package.loaded.ffi then
  local ffi = package.loaded.ffi
  for k in next, ffi do if k ~= "gc" then ffi[k] = nil end end
end
ffi = nil
if package and package.preload then package.preload.ffi = function() error(EPERM, 2) end end

local os_rename = os.rename
os.rename = function(a, b)
  if not (write_ok(a) and write_ok(b)) then return nil, EPERM end
  return os_rename(a, b)
end
os.remove = guard(os.remove, write_ok)
-- kpathsea reads openin_any/openout_any/TEXMFOUTPUT from the environment on every check.
os.setenv = function() end
-- os.tmpdir(template) creates a folder wherever the template points (luatex-core checks
-- "os.tempdir", which does not exist). Without a template: luatex.XXXXXX in the current
-- folder, which luaotfload's HarfBuzz mode uses.
local os_tmpdir = os.tmpdir
if os_tmpdir then
  os.tmpdir = function(template, ...)
    if template ~= nil and not write_ok(template) then return nil, EPERM end
    return os_tmpdir(template, ...)
  end
end
-- os.tmpname creates a file in the system's temp folder, which Lua here can neither read
-- nor write.
os.tmpname = function() error(EPERM, 2) end

-- lfs: listings like reading, metadata also above the allowed folders, changes like writing.
lfs.attributes = guard(lfs.attributes, meta_ok)
lfs.symlinkattributes = guard(lfs.symlinkattributes, meta_ok)
lfs.readlink = guard(lfs.readlink, meta_ok)
lfs.shortname = guard(lfs.shortname, meta_ok)
lfs.isdir = guard(lfs.isdir, meta_ok, function() return false end)
lfs.isfile = guard(lfs.isfile, read_ok, function() return false end)
lfs.dir = guard(lfs.dir, read_ok, raise)
for _, f in ipairs({ "chdir", "mkdir", "mkdirp", "rmdir", "touch", "lock_dir" }) do
  lfs[f] = guard(lfs[f], write_ok)
end
if lfs.link then
  local lfs_link = lfs.link
  lfs.link = function(old, new, ...)
    if not (write_ok(old) and write_ok(new)) then return nil, EPERM end
    return lfs_link(old, new, ...)
  end
end

-- Libraries that open files by name on the C side.
if zip then
  zip.open = guard(zip.open, read_ok)
  -- zip.openfile(name, ext) appends "." .. ext to every folder of the name and opens the
  -- result as the archive, ".." included ("x/a.txt", "/../../b.zip" reads a.txt from
  -- x./../../b.zip), and copies ext into a fixed-size buffer: no extensions. Without them
  -- zziplib tries <folder>.zip for every folder of the name, so only relative names: the
  -- archive then always lies in the project.
  local zip_openfile = zip.openfile
  if zip_openfile then
    zip.openfile = function(name, ext)
      if ext ~= nil or not read_ok(name) or is_abs(norm(name)) then return nil, EPERM end
      return zip_openfile(name)
    end
  end
end
if gzip then
  local gzip_open = gzip.open
  if gzip_open then
    gzip.open = function(name, mode, ...)
      if not (read_ok(name) and (mode == nil or not find(mode, "[wa+]") or write_ok(name))) then return nil, EPERM end
      return gzip_open(name, mode, ...)
    end
  end
  gzip.lines = guard(gzip.lines, read_ok, raise)
end
if pdfe then pdfe.open = guard(pdfe.open, read_ok) end
-- pdf.obj/pdf.immediateobj with type "file"/"streamfile" (or { file = … }) copy a file into
-- the PDF.
if pdf then
  local function obj_guard(fn)
    if type(fn) ~= "function" then return fn end
    return function(...)
      local a = { ... }
      if type(a[1]) == "table" then
        if a[1].file ~= nil and not read_ok(a[1].file) then return raise() end
      else
        local i = type(a[1]) == "number" and 2 or 1
        if (a[i] == "file" or a[i] == "streamfile") and not read_ok(a[i + 1]) then return raise() end
      end
      return fn(...)
    end
  end
  pdf.obj = obj_guard(pdf.obj)
  pdf.immediateobj = obj_guard(pdf.immediateobj)
end
local hb = package and package.loaded and package.loaded.luaharfbuzz
if type(hb) == "table" then
  if type(hb.Blob) == "table" then hb.Blob.new_from_file = guard(hb.Blob.new_from_file, read_ok) end
  if type(hb.Face) == "table" then hb.Face.new = guard(hb.Face.new, read_ok) end
end
if fontloader then
  fontloader.open = guard(fontloader.open, read_ok)
  fontloader.info = guard(fontloader.info, read_ok)
  -- The second argument is a file as well; a parse error quotes its first word.
  for _, f in ipairs({ "apply_featurefile", "apply_afmfile" }) do
    local orig = fontloader[f]
    if type(orig) == "function" then
      fontloader[f] = function(font, name, ...)
        if not read_ok(name) then return raise() end
        return orig(font, name, ...)
      end
    end
  end
end
-- TFM and VF files by name (kpathsea also finds absolute names, without openin_any).
if font then
  font.read_tfm = guard(font.read_tfm, read_ok, raise)
  font.read_vf = guard(font.read_vf, read_ok)
end
-- MetaPost opens what find_file returns (without find_file: the name as given).
if mplib and mplib.new then
  local mplib_new = mplib.new
  mplib.new = function(cfg, ...)
    local c = {}
    if type(cfg) == "table" then for k, v in pairs(cfg) do c[k] = v end end
    local find_file = c.find_file
    c.find_file = function(name, mode, kind)
      local found = name
      if type(find_file) == "function" then found = find_file(name, mode, kind) end
      if type(found) ~= "string" then return found end
      if mode == "w" then return write_ok(found) and found or nil end
      return read_ok(found) and found or nil
    end
    return mplib_new(c, ...)
  end
end

-- kpathsea lookups of absolute names would tell which files exist outside.
local LOOKUPS = { "find_file", "readable_file", "lookup" }
local function lookup_ok(name)
  if type(name) ~= "string" then return true end
  local p = norm(name)
  return not (is_abs(p) or has_dotdot(p)) or read_ok(name)
end
for _, f in ipairs(LOOKUPS) do
  local orig = kpse[f]
  if type(orig) == "function" then
    kpse[f] = function(name, ...)
      if not lookup_ok(name) then return nil end
      return orig(name, ...)
    end
  end
end
-- kpse.new() instances have the same lookups as methods (one metatable for all of them).
local kpse_new = kpse.new
if type(kpse_new) == "function" then
  local patched = false
  kpse.new = function(...)
    local k = kpse_new(...)
    if not patched then
      local mt = getmetatable(k)
      local index = type(mt) == "table" and mt.__index
      if type(index) ~= "table" then return nil end
      for _, f in ipairs(LOOKUPS) do
        local orig = index[f]
        if type(orig) == "function" then
          index[f] = function(self, name, ...)
            if not lookup_ok(name) then return nil end
            return orig(self, name, ...)
          end
        end
      end
      patched = true
    end
    return k
  end
end
-- package.searchpath tries every template with fopen, so it would tell the same.
if package then
  local dirsep = sub(package.config or "/", 1, 1)
  package.searchpath = function(name, path, sep, rep)
    if type(name) ~= "string" or type(path) ~= "string" then error("bad argument to 'searchpath' (string expected)", 2) end
    sep, rep = sep or ".", rep or dirsep
    if sep ~= "" then name = gsub(name, (gsub(sep, "%p", "%%%0")), (gsub(rep, "%%", "%%%%"))) end
    local tried = {}
    for template in gmatch(path, "[^;]+") do
      local file = gsub(template, "%?", function() return name end)
      local f = read_ok(file) and io_open(file, "r")
      if f then
        f:close()
        return file
      end
      tried[#tried + 1] = "\n\tno file '" .. file .. "'"
    end
    return nil, concat(tried)
  end
end

---------------------------------------------------------------------------------------------
-- Callbacks

-- find_*_file callbacks hand LuaTeX a file name that it opens on the C side. LuaTeX's own
-- lookup for images (\includegraphics, img.scan), \pdfextension obj file (embeds any file
-- into the PDF), map/enc files and font files does not check openin_any, so they get a
-- checked default. A refused name becomes DENIED, a path that cannot exist: for nil
-- LuaTeX falls back to the name as given (\pdfextension obj file). ltluatex keeps a copy
-- of callback.register, so the wrapper below also covers luatexbase.add_to_callback;
-- unregistering brings back the checked default.
local DENIED = "/latex-ide-sandbox/nicht-erlaubt"
local callback_register = callback.register
local kpse_find_file = kpse.find_file
local defaults = {}
local function checked_lookup(format, must_exist)
  return function(name)
    if not read_ok(name) then return DENIED end
    local found = kpse_find_file(name, format, must_exist)
    if found == nil then return nil end
    return read_ok(found) and found or DENIED
  end
end
defaults.find_image_file = checked_lookup("tex", true)
defaults.find_data_file = checked_lookup("tex", true)
defaults.find_map_file = checked_lookup("map")
defaults.find_enc_file = checked_lookup("enc files")
defaults.find_type1_file = checked_lookup("type1 fonts")
defaults.find_truetype_file = checked_lookup("truetype fonts")
defaults.find_opentype_file = checked_lookup("opentype fonts")

callback.register = function(name, fn, ...)
  if type(name) == "string" and find(name, "^find_.*_file$") then
    local default = defaults[name]
    if type(fn) == "function" then
      local check = (name == "find_write_file" or name == "find_output_file") and write_ok or read_ok
      local inner = fn
      fn = function(...)
        local found = inner(...)
        if type(found) == "string" then return check(found) and found or DENIED end
        -- nil: LuaTeX would take the name as given.
        if default then return default(...) end
        return found
      end
    elseif default then
      fn = default
    end
  end
  return callback_register(name, fn, ...)
end
for name, fn in pairs(defaults) do callback_register(name, fn) end

---------------------------------------------------------------------------------------------
-- Allowlist

-- C functions of these libraries that are checked above or open nothing by name (LuaTeX
-- 1.15-1.18; methods of opened files, archives, fonts … work on what is already open).
-- Every other function is removed, so a newer LuaTeX cannot add a way out unnoticed.
-- Removed rather than replaced: packages that test for a function then behave as with
-- an older LuaTeX without it. Add a name only after checking what the function opens.
local KNOWN = {
  io = "close flush input lines open output popen read tmpfile type write",
  os = "clock date difftime exec execute exit getenv gettimeofday kpsepopen remove rename setenv setlocale "
    .. "sleep socketgettime socketsleep spawn time times tmpdir tmpname uname",
  lfs = "attributes chdir currentdir dir isdir isfile link lock lock_dir mkdir mkdirp readlink rmdir setmode "
    .. "shortname symlinkattributes touch unlock",
  zip = "close open openfile type",
  gzip = "close lines open",
  fontloader = "apply_afmfile apply_featurefile close fields info open to_table",
  font = "addcharacters current define each frozen getcopy getfont getparameters id max nextid read_tfm read_vf "
    .. "setexpansion setfont",
  img = "boxes copy fields immediatewrite immediatewriteobject keys new node scan types write",
  pdfe = "arraytotable close closestream dictionarytotable getarray getboolean getbox getcatalog getdictionary "
    .. "getfromarray getfromdictionary getfromreference getfromstream getinfo getinteger getmemoryusage getname "
    .. "getnofobjects getnofpages getnumber getpage getpages getsize getstatus getstream getstring gettrailer "
    .. "getversion new open openstream pagestotable readfromstream readwholestream type unencrypt",
  mplib = "char_depth char_height char_width execute fields finish get_boolean get_number get_numeric get_path "
    .. "get_string new pen_info solve_path statistics version",
  kpse = "check_permission default_texmfcnf expand_braces expand_path expand_var find_file in_name_ok "
    .. "in_name_ok_silent_extended init_prog lookup new out_name_ok out_name_ok_silent_extended readable_file "
    .. "record_input_file record_output_file set_program_name show_path var_value version",
  package = "loadlib searchpath seeall",
  -- One level deeper: the classes (Blob.new_from_file, Face.new open files).
  luaharfbuzz = "shape_full shapers version Blob.new Blob.new_from_file Buffer.new Direction.new Face.new "
    .. "Face.new_from_blob Feature.new Font.new Language.new Script.from_iso15924_tag Script.new Tag.new "
    .. "Variation.new unicode.script",
}
local function sweep(t, prefix, known, depth)
  for k, v in next, t do
    local name = type(k) == "string" and prefix .. k
    if type(v) == "function" then
      if not (name and known[name]) then t[k] = nil end
    elseif type(v) == "table" and name and depth > 0 then
      sweep(v, name .. ".", known, depth - 1)
    end
  end
end
for lib, names in pairs(KNOWN) do
  local known = {}
  for n in gmatch(names, "%S+") do known[n] = true end
  local depth = lib == "luaharfbuzz" and 1 or 0
  local global, loaded = _G[lib], package and package.loaded and package.loaded[lib]
  if type(global) == "table" then sweep(global, "", known, depth) end
  if type(loaded) == "table" and loaded ~= global then sweep(loaded, "", known, depth) end
end

-- debug.getupvalue would hand out the unwrapped functions. TeX Live 2023+ removes the
-- debug library anyway (unless --luadebug), older versions do not.
if debug then
  for k in pairs(debug) do
    if k ~= "traceback" then debug[k] = nil end
  end
end
