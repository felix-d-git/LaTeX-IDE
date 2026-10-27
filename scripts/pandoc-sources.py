#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
"""Lists the Debian source packages statically linked into pandoc, as "<source> <version>" lines.

bookworm's pandoc has no (Static-)Built-Using field, so the Haskell libraries come from the
official buildinfo (Installed-Build-Depends: ghc + libghc-*-dev). The buildinfo is only used
if its pandoc .deb hash matches the archive. Usage: pandoc-sources.py DEBIAN-PACKAGES.txt
"""
import json, lzma, re, sys, urllib.request

ARCH = "amd64"
INDEXES = [
    "https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz",
    "https://deb.debian.org/debian/dists/bookworm-updates/main/binary-amd64/Packages.xz",
    "https://security.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz",
]


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def stanzas(text):
    for block in text.split("\n\n"):
        fields = dict(re.findall(r"^([\w-]+): (.*)$", block, re.M))
        if "Package" in fields:
            yield fields


# pandoc version from the image
pandoc_ver = None
for line in open(sys.argv[1], encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if f[0] == "pandoc":
        pandoc_ver = f[1]
        assert f[2] == "pandoc" and f[3] == pandoc_ver, f
if not pandoc_ver:
    sys.exit("pandoc not in the image")

# binary (name, version) -> (source, source version)
binaries = {}
for url in INDEXES:
    for s in stanzas(lzma.decompress(get(url)).decode("utf-8")):
        m = re.match(r"(\S+)(?: \((\S+)\))?", s.get("Source", s["Package"]))
        binaries[(s["Package"], s["Version"])] = (m[1], m[2] or s["Version"], s.get("SHA256"))

deb_sha = binaries.get(("pandoc", pandoc_ver), (None, None, None))[2]
if not deb_sha:
    sys.exit(f"pandoc {pandoc_ver} not in the bookworm indexes")

pool = "https://buildinfos.debian.net/buildinfo-pool/p/pandoc"
buildinfo = get(f"{pool}/pandoc_{pandoc_ver.split(':')[-1]}_{ARCH}.buildinfo").decode("utf-8")
if f"{deb_sha} " not in buildinfo:
    sys.exit("buildinfo does not belong to the shipped pandoc .deb")

deps = re.search(r"^Installed-Build-Depends:\n((?: .*\n)+)", buildinfo, re.M)[1]
wanted = [(n, v) for n, v in re.findall(r"^ ([a-z0-9][a-z0-9.+-]*) \(= ([^)]+)\)", deps, re.M)
          if n == "ghc" or (n.startswith("libghc-") and n.endswith("-dev"))]

out = {("pandoc", pandoc_ver)}
for name, ver in wanted:
    hit = binaries.get((name, ver))
    if hit:
        out.add(hit[:2])
        continue
    # no longer in the archive: ask snapshot.debian.org
    res = json.loads(get(f"https://snapshot.debian.org/mr/binary/{name}/"))["result"]
    src = [(r["source"], r["version"]) for r in res if r["binary_version"] == ver]
    if not src:
        sys.exit(f"no source for {name} {ver}")
    out.add(src[0])

# bookworm: ~150; far fewer means the buildinfo format changed
if len(out) < 50:
    sys.exit(f"only {len(out)} source packages found")
for src, ver in sorted(out):
    print(src, ver)
