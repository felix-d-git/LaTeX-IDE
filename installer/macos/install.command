#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
# LaTeX-IDE Desktop - macOS Installer.
# Doppelklickbar (Finder). Bei Gatekeeper-Warnung: Systemeinstellungen ->
# Datenschutz & Sicherheit -> "Dennoch oeffnen" (oder: bash install.command).
#
# Erwartet, im selben Ordner wie die App-Dateien (client/, server/,
# package.json, build.js, ...) zu liegen - also entpackt aus
# LatexIDE-macOS.zip.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$HOME/Applications/LatexIDE"
APP_DIR="$APP_ROOT/app"
NODE_DIR="$APP_ROOT/node"
NODE_VERSION="26.13.0"

echo "=== LaTeX-IDE Desktop Installer ==="

ARCH="$(uname -m)"
case "$ARCH" in
    arm64)
        NODE_ARCH="darwin-arm64"
        ;;
    x86_64)
        NODE_ARCH="darwin-x64"
        ;;
    *)
        echo "Nicht unterstuetzte Architektur: $ARCH" >&2
        exit 1
        ;;
esac
echo "Erkannte Architektur: $ARCH ($NODE_ARCH)"

mkdir -p "$APP_ROOT"

# --- Node.js laden und pruefen ---------------------------------------------

NODE_TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"
NODE_DIST_BASE="https://nodejs.org/dist/v${NODE_VERSION}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "Lade Node.js ${NODE_VERSION} (${NODE_ARCH})..."
    curl -fsSL -o "$TMP_DIR/$NODE_TARBALL" "$NODE_DIST_BASE/$NODE_TARBALL"
    curl -fsSL -o "$TMP_DIR/SHASUMS256.txt" "$NODE_DIST_BASE/SHASUMS256.txt"

    EXPECTED_HASH="$(grep " ${NODE_TARBALL}\$" "$TMP_DIR/SHASUMS256.txt" | awk '{print $1}')"
    if [ -z "$EXPECTED_HASH" ]; then
        echo "Konnte $NODE_TARBALL nicht in SHASUMS256.txt finden." >&2
        exit 1
    fi
    ACTUAL_HASH="$(shasum -a 256 "$TMP_DIR/$NODE_TARBALL" | awk '{print $1}')"
    if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
        echo "SHA256-Mismatch fuer $NODE_TARBALL!" >&2
        echo "Erwartet: $EXPECTED_HASH" >&2
        echo "Erhalten: $ACTUAL_HASH" >&2
        exit 1
    fi
    echo "SHA256 OK: $NODE_TARBALL"

    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TMP_DIR/$NODE_TARBALL" -C "$TMP_DIR"
    NODE_SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name "node-v${NODE_VERSION}-${NODE_ARCH}")"
    cp -R "$NODE_SRC_DIR"/. "$NODE_DIR"/
else
    echo "Node.js bereits unter $NODE_DIR gefunden - Download uebersprungen."
fi

# --- App-Dateien kopieren ---------------------------------------------------

# Alles aus dem Paket ausser install.command (wie das Auto-Update in
# desktop.js), damit z. B. node_modules nicht fehlt.
if [ ! -f "$SCRIPT_DIR/server/desktop.js" ] || [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "Unvollstaendiges Paket in $SCRIPT_DIR (server/ oder node_modules/ fehlt)." >&2
    echo "Bitte LatexIDE-macOS.zip neu herunterladen und entpacken." >&2
    exit 1
fi
echo "Kopiere App-Dateien nach $APP_DIR..."
mkdir -p "$APP_DIR"
for src in "$SCRIPT_DIR"/*; do
    name="$(basename "$src")"
    [ "$name" = install.command ] && continue
    rm -rf "$APP_DIR/$name"
    cp -R "$src" "$APP_DIR/$name"
done
# ZIP aus GitHub (nicht vom Server): ohne server.json nach der Server-Adresse fragen.
if [ ! -f "$APP_DIR/server.json" ] && [ -t 0 ]; then
    read -r -p "Server-Adresse (https://..., leer = lokal ohne Server): " SERVER_URL
    if [ -n "$SERVER_URL" ]; then
        case "$SERVER_URL" in
            http://*|https://*) printf '{"remoteUrl": "%s"}
' "$(printf '%s' "$SERVER_URL" | tr -d '"\')" > "$APP_DIR/server.json" ;;
            *) echo "Ungueltige Adresse (muss mit http:// oder https:// beginnen) - server.json nicht angelegt." >&2 ;;
        esac
    fi
fi
if ! (cd "$APP_DIR" && "$NODE_DIR/bin/node" -e "for (const m of ['express', 'ws', 'http-proxy']) require.resolve(m)"); then
    echo "App-Abhaengigkeiten fehlen in $APP_DIR/node_modules - Installation abgebrochen." >&2
    exit 1
fi

# --- TeX Live / MacTeX installieren (falls noetig) --------------------------

if [ -x /Library/TeX/texbin/latexmk ]; then
    echo "latexmk bereits unter /Library/TeX/texbin gefunden - MacTeX-Installation wird uebersprungen."
else
    MACTEX_BASE="https://ftp.tu-chemnitz.de/pub/tug/historic/systems/mactex/2025"
    MACTEX_PKG="mactex-20250308.pkg"
    # SHA-512 aus mactex-20250308.pkg.sha512 der TUG; Team-ID aus dem Zertifikat des Pakets (Richard Koch).
    MACTEX_SHA512="93a853296afdec6eb2b30d9efeef028c87e607179bcdea19804e09e6c38e391d533620f84545293b4e448ca0dcaebccc62a11e0093bf2340f0906b02415017b5"
    MACTEX_TEAM_ID="RBGCY5RJWM"
    # installer -pkg zeigt die Lizenzseite des MacTeX-Pakets nicht an.
    echo "Hinweis: MacTeX ist nicht Teil von LaTeX-IDE; jede Komponente hat ihre eigene Lizenz."
    echo "  TeX Live: https://www.tug.org/texlive/LICENSE.TL"
    echo "  MacTeX:   https://www.tug.org/mactex/"
    echo "Lade $MACTEX_PKG (mehrere GB, kann lange dauern)..."
    curl -fL -o "$TMP_DIR/$MACTEX_PKG" "$MACTEX_BASE/$MACTEX_PKG"
    if [ "$(shasum -a 512 "$TMP_DIR/$MACTEX_PKG" | cut -d' ' -f1)" != "$MACTEX_SHA512" ]; then
        echo "MacTeX-Paket: SHA-512 stimmt nicht - Installation abgebrochen." >&2
        exit 1
    fi
    if ! pkgutil --check-signature "$TMP_DIR/$MACTEX_PKG" | grep -q "Developer ID Installer: .*($MACTEX_TEAM_ID)"; then
        echo "MacTeX-Paket: Signatur/Team-ID ($MACTEX_TEAM_ID) ungueltig - Installation abgebrochen." >&2
        exit 1
    fi
    echo "Installiere MacTeX (Administrator-Passwort erforderlich)..."
    sudo installer -pkg "$TMP_DIR/$MACTEX_PKG" -target /
fi

# --- Electron-Laufzeit (#212) ------------------------------------------------
# Fenster der Desktop-App + ".tex"-Zuordnung ("Oeffnen mit LaTeX-IDE"). Scheitert der Teil,
# bleibt der bisherige Start ueber Node + Browser (Starter unten faellt darauf zurueck).
# Version muss zu devDependencies.electron in package.json passen (test/desktopElectron.test.js).
ELECTRON_VERSION="45.5.0"
APP_BUNDLE="$APP_ROOT/LatexIDE.app"

install_electron() {
    local earch
    case "$ARCH" in arm64) earch="darwin-arm64" ;; *) earch="darwin-x64" ;; esac
    local zip="electron-v${ELECTRON_VERSION}-${earch}.zip"
    local base="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"
    if [ -d "$APP_BUNDLE" ] && [ "$(cat "$APP_BUNDLE/.electron-version" 2>/dev/null)" = "$ELECTRON_VERSION" ]; then
        return 0
    fi
    echo "Lade Electron ${ELECTRON_VERSION} (${earch})..."
    curl -fsSL -o "$TMP_DIR/$zip" "$base/$zip" || return 1
    curl -fsSL -o "$TMP_DIR/SHASUMS256.electron" "$base/SHASUMS256.txt" || return 1
    local want have
    want="$(grep " \*\?${zip}\$" "$TMP_DIR/SHASUMS256.electron" | awk '{print $1}')"
    have="$(shasum -a 256 "$TMP_DIR/$zip" | awk '{print $1}')"
    if [ -z "$want" ] || [ "$want" != "$have" ]; then
        echo "SHA256 fuer $zip stimmt nicht - Electron wird nicht installiert." >&2
        return 1
    fi
    rm -rf "$APP_BUNDLE" "$TMP_DIR/electron-x"
    mkdir -p "$TMP_DIR/electron-x"
    ditto -x -k "$TMP_DIR/$zip" "$TMP_DIR/electron-x" || return 1
    mv "$TMP_DIR/electron-x/Electron.app" "$APP_BUNDLE" || return 1
    # Lizenzen (MIT + Chromium) liegen im ZIP neben der App und muessen mitgeliefert werden.
    cp "$TMP_DIR/electron-x/LICENSE" "$TMP_DIR/electron-x/LICENSES.chromium.html" "$APP_ROOT/" 2>/dev/null || true
    # Die App-Dateien liegen unter app/: Einstieg ist ein Stub, der desktop/main.js laedt.
    mkdir -p "$APP_BUNDLE/Contents/Resources/app"
    printf '{"name":"latexide","main":"main.js"}\n' > "$APP_BUNDLE/Contents/Resources/app/package.json"
    # LatexIDE.app/Contents/Resources/app -> vier Ebenen hoch = $APP_ROOT
    printf '%s\n' "require(require('path').join(__dirname, '..', '..', '..', '..', 'app', 'desktop', 'main.js'));" > "$APP_BUNDLE/Contents/Resources/app/main.js"
    local plist="$APP_BUNDLE/Contents/Info.plist" pb=/usr/libexec/PlistBuddy
    $pb -c "Set :CFBundleName LaTeX-IDE" -c "Set :CFBundleDisplayName LaTeX-IDE" -c "Set :CFBundleIdentifier org.latexide.desktop" "$plist" || return 1
    $pb -c "Delete :CFBundleDocumentTypes" "$plist" 2>/dev/null || true
    $pb -c "Add :CFBundleDocumentTypes array" \
        -c "Add :CFBundleDocumentTypes:0 dict" \
        -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string LaTeX-Dokument" \
        -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor" \
        -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" \
        -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array" \
        -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string tex" "$plist" || return 1
    # Info.plist geaendert -> Signatur ungueltig; ad-hoc neu signieren, sonst startet die App nicht.
    codesign --force --deep -s - "$APP_BUNDLE" || return 1
    echo "$ELECTRON_VERSION" > "$APP_BUNDLE/.electron-version"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" 2>/dev/null || true
}
if ! install_electron; then
    echo "Hinweis: Electron konnte nicht installiert werden - die App startet im Browser." >&2
    rm -rf "$APP_BUNDLE"
fi

# --- Startskript anlegen -----------------------------------------------------

STARTER="$APP_ROOT/LatexIDE.command"
cat > "$STARTER" <<'EOF'
#!/bin/bash
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$APP_ROOT/node/bin:/Library/TeX/texbin:$PATH"
# Server-Adresse kommt aus app/server.json (vom Server ins ZIP eingebaut)
: "${PORT:=3178}"
: "${LATEX_IDE_DATA:=$HOME/Library/Application Support/LatexIDE}"
export PORT LATEX_IDE_DATA
cd "$APP_ROOT/app"
# Mit Electron-Laufzeit: eigenes Fenster (Datei-Argumente werden durchgereicht).
if [ -d "$APP_ROOT/LatexIDE.app" ]; then
    exec "$APP_ROOT/LatexIDE.app/Contents/MacOS/Electron" "$@"
fi
# Sonst: desktop.js oeffnet den Browser selbst mit dem Start-Schluessel (?k=, #163)
exec "$APP_ROOT/node/bin/node" server/desktop.js
EOF
chmod +x "$STARTER"

echo ""
echo "=== Installation abgeschlossen ==="
echo "Starter angelegt: $STARTER"
echo "Hinweis: Beim ersten Start von LatexIDE.command meldet macOS Gatekeeper"
echo "moeglicherweise eine Sicherheitswarnung. Falls noetig: Systemeinstellungen ->"
echo "Datenschutz & Sicherheit -> 'Dennoch oeffnen' (aeltere macOS: Rechtsklick -> 'Oeffnen')."
