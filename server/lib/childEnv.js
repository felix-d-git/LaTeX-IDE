// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Environment for external programs that process project files (TeX via latexmk, biber,
// makeindex, restricted \write18 commands; pandoc; synctex): only what they need, never the
// server's secrets (DATA_KEY, SESSION_SECRET, UPDATE_TOKEN, SMTP_*, ADMIN_*, TS_AUTHKEY) - a
// hole anywhere in that chain must not hand out the vault key (#114).

// Case-insensitive: Windows spells Path/SystemRoot in any case.
const CHILD_ENV_RE = new RegExp(
  '^(?:' +
    [
      'PATH', 'PATHEXT', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_\\w+', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
      'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
      'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES\\(X86\\)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
      'XDG_\\w+', 'FONTCONFIG_\\w+', 'OSFONTDIR', 'SOURCE_DATE_EPOCH', 'FORCE_SOURCE_DATE',
      // TeX Live/MiKTeX search paths and caches (TEXMFHOME, TEXMFVAR, TEXINPUTS, BIBINPUTS …)
      'TEX\\w*', 'BIB\\w*', 'BST\\w*', 'KPATHSEA\\w*', 'MIKTEX_\\w+', 'LUAINPUTS', 'T1FONTS', 'TTFONTS', 'OPENTYPEFONTS', 'ENCFONTS',
    ].join('|') +
    ')$',
  'i'
);

// Read at call time: the desktop app extends PATH after start (TeX found later).
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (CHILD_ENV_RE.test(k)) env[k] = v;
  return env;
}

module.exports = { childEnv, CHILD_ENV_RE };
