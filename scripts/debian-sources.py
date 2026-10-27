#!/usr/bin/env python3
"""Lists every Debian source package of the image, as "<source> <version>" lines.

Input is DEBIAN-PACKAGES.txt (Dockerfile: package, version, source, source version,
Built-Using, Static-Built-Using, X-Cargo-Built-Using). Besides the source of each
installed package, the sources named in the three Built-Using columns are listed, since
their code went into the binaries as well. pandoc's statically linked Haskell libraries
have no such field; scripts/pandoc-sources.py lists those.
Usage: debian-sources.py DEBIAN-PACKAGES.txt
"""
import re, sys

# "htmldoc (= 1.9.3-1), poppler-data (= 0.4.9-2)"
BUILT_USING = re.compile(r"([a-z0-9][a-z0-9.+-]*) \(= ([^)\s]+)\)")

out = set()
for n, line in enumerate(open(sys.argv[1], encoding="utf-8"), 1):
    f = line.rstrip("\n").split("\t")
    if len(f) < 4 or not f[2] or not f[3]:
        sys.exit(f"line {n}: no source package: {line!r}")
    out.add((f[2], f[3]))
    for field in f[4:]:
        rest = BUILT_USING.sub("", field).strip(" ,")
        if rest:
            sys.exit(f"line {n}: cannot parse Built-Using {field!r}")
        out.update(BUILT_USING.findall(field))

# texlive-full alone pulls in several hundred; far fewer means the list is broken
if len(out) < 50:
    sys.exit(f"only {len(out)} source packages found")
for src, ver in sorted(out):
    print(src, ver)
