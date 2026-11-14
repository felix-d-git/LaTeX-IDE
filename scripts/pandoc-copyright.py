#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
"""Copies debian/copyright of every source package in SOURCES.txt to OUT_DIR/<source>/copyright.

bookworm's pandoc links ~150 Haskell libraries (BSD-3-Clause, MIT, ...) and the GHC runtime
statically, but /usr/share/doc/pandoc/copyright only covers pandoc itself. Their copyright notices
go into the image instead (container-image.yml: /usr/share/doc/pandoc/static-libs). Input is the
folder "pandoc-Quellen sammeln" fills: SOURCES.txt from pandoc-sources.py ("<source> <version>")
and the downloaded Debian source packages (.dsc plus .debian.tar.* / .tar.* / .diff.gz). Only
debian/copyright is read from the archives, nothing is unpacked. Fails if one is missing.
Usage: pandoc-copyright.py SRC_DIR OUT_DIR
"""
import gzip, os, re, shutil, sys, tarfile

NAME = re.compile(r"[a-z0-9][a-z0-9.+-]*")
VERSION = re.compile(r"(?:\d+:)?[0-9][A-Za-z0-9.+~-]*")

README = """Copyright notices of the libraries statically linked into pandoc

Debian's pandoc binary contains code from pandoc, GHC (runtime and base libraries)
and the Haskell libraries it was built against (Installed-Build-Depends of the
official Debian buildinfo). <source>/copyright is debian/copyright of each of
these Debian source packages, in the versions listed in SOURCES.txt.

The complete sources are attached as pandoc-sources-<tag>.tar to the GitHub
release of this image, see /app/docs/INSTALL-DOCKER.md.
"""


def dsc(path):
    """Format and file names of a .dsc (clearsigned or not)."""
    text = open(path, encoding="utf-8", errors="replace").read()
    fmt = re.search(r"^Format: *(.+?) *$", text, re.M)
    files = re.search(r"^Files:\n((?:[ \t].*\n?)+)", text, re.M)
    if not fmt or not files:
        raise ValueError(f"{os.path.basename(path)}: no Format or Files field")
    return fmt[1].strip(), [line.split()[-1] for line in files[1].splitlines() if line.strip()]


def from_tar(path, member):
    """Content of the regular file whose name (without a leading ./) matches member."""
    with tarfile.open(path) as tar:
        for m in tar:
            if m.isfile() and member.fullmatch(m.name[2:] if m.name.startswith("./") else m.name):
                return tar.extractfile(m).read()
    return None


def from_diff(path):
    """debian/copyright created by a format 1.0 .diff.gz."""
    lines, out = gzip.open(path, "rt", encoding="utf-8", errors="surrogateescape").read().split("\n"), None
    for i, line in enumerate(lines):
        if out is None:
            if line.startswith("+++ ") and re.fullmatch(r"[^/\s]+/debian/copyright", line[4:].split("\t")[0].strip()) \
                    and i + 1 < len(lines) and lines[i + 1].startswith("@@ -0,0 "):
                out = []
            continue
        if line.startswith("@@ "):
            continue
        if line.startswith("+"):
            out.append(line[1:])
        elif line.startswith("\\"):  # "\ No newline at end of file"
            return "\n".join(out).encode("utf-8", "surrogateescape")
        else:
            break
    return None if out is None else ("\n".join(out) + "\n").encode("utf-8", "surrogateescape")


def copyright_of(src_dir, source, version):
    fmt, files = dsc(os.path.join(src_dir, f"{source}_{version.split(':', 1)[-1]}.dsc"))
    find = lambda pattern: [f for f in files if re.fullmatch(pattern, f)]
    if fmt == "3.0 (quilt)":
        tars = find(r".+\.debian\.tar\.(gz|bz2|xz|lzma)")
        member = re.compile(r"debian/copyright")
    elif fmt == "3.0 (native)" or (fmt == "1.0" and not find(r".+\.diff\.gz")):
        tars = find(r".+\.tar\.(gz|bz2|xz|lzma)")
        member = re.compile(r"[^/]+/debian/copyright")
    elif fmt == "1.0":
        return from_diff(os.path.join(src_dir, find(r".+\.diff\.gz")[0]))
    else:
        raise ValueError(f"source format {fmt!r} not supported")
    for t in tars:
        text = from_tar(os.path.join(src_dir, t), member)
        if text is not None:
            return text
    return None


def main(src_dir, out_dir):
    sources = []
    for n, line in enumerate(open(os.path.join(src_dir, "SOURCES.txt"), encoding="utf-8"), 1):
        parts = line.split()
        if not parts:
            continue
        # Names become folder names: no path tricks.
        if len(parts) != 2 or not NAME.fullmatch(parts[0]) or not VERSION.fullmatch(parts[1]):
            sys.exit(f"SOURCES.txt line {n}: not '<source> <version>': {line!r}")
        sources.append(tuple(parts))
    if not sources:
        sys.exit("SOURCES.txt is empty")
    errors = []
    os.makedirs(out_dir, exist_ok=True)
    names = [s for s, _ in sources]
    for source, version in sources:
        # Same source in two versions (not seen so far): one folder per version.
        folder = source if names.count(source) == 1 else f"{source}_{version.split(':', 1)[-1]}"
        try:
            text = copyright_of(src_dir, source, version)
        except (OSError, ValueError, tarfile.TarError, EOFError) as e:
            text, why = None, str(e)
        else:
            why = "no debian/copyright in the source package"
        if not text or not text.strip():
            errors.append(f"{source} {version}: {why}")
            continue
        os.makedirs(os.path.join(out_dir, folder), exist_ok=True)
        with open(os.path.join(out_dir, folder, "copyright"), "wb") as f:
            f.write(text)
    if errors:
        sys.exit("debian/copyright missing:\n  " + "\n  ".join(errors))
    shutil.copyfile(os.path.join(src_dir, "SOURCES.txt"), os.path.join(out_dir, "SOURCES.txt"))
    with open(os.path.join(out_dir, "README"), "w", encoding="utf-8") as f:
        f.write(README)
    print(f"{len(sources)} copyright files in {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: pandoc-copyright.py SRC_DIR OUT_DIR")
    main(sys.argv[1], sys.argv[2])
