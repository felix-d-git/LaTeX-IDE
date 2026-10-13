#!/bin/bash
# LatexIDE Desktop - macOS Installer.
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
NODE_VERSION="24.21.0"

echo "=== LatexIDE Desktop Installer ==="

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
# Paket ohne eingebaute Server-Adresse (z. B. direkt von GitHub): abfragen, sonst beendet sich die App.
if [ ! -f "$APP_DIR/server.json" ]; then
    while :; do
        read -r -p "Adresse deines LatexIDE-Servers (http:// oder https://...): " SRV_URL
        case "$SRV_URL" in http://*|https://*) break ;; *) echo "Bitte mit http:// oder https:// beginnen." ;; esac
    done
    printf '{"remoteUrl":"%s"}\n' "${SRV_URL%/}" > "$APP_DIR/server.json"
fi
if ! (cd "$APP_DIR" && "$NODE_DIR/bin/node" -e "for (const m of ['express', 'ws', 'http-proxy']) require.resolve(m)"); then
    echo "App-Abhaengigkeiten fehlen in $APP_DIR/node_modules - Installation abgebrochen." >&2
    exit 1
fi

# --- TeX Live / MacTeX installieren (falls noetig) --------------------------

if [ -x /Library/TeX/texbin/latexmk ]; then
    echo "latexmk bereits unter /Library/TeX/texbin gefunden - MacTeX-Installation wird uebersprungen."
else
    echo "Suche aktuelles MacTeX-2025-Paket..."
    MACTEX_BASE="https://ftp.tu-chemnitz.de/pub/tug/historic/systems/mactex/2025"
    MACTEX_PKG="MacTeX.pkg"
    if ! curl -fsSI "$MACTEX_BASE/$MACTEX_PKG" >/dev/null 2>&1; then
        echo "Fallback: suche versionierten Dateinamen (mactex-*.pkg)..."
        MACTEX_PKG="$(curl -fsSL "$MACTEX_BASE/" | grep -oE 'href="mactex-[0-9]+\.pkg"' | head -1 | sed -E 's/href="(.*)"/\1/')"
        if [ -z "$MACTEX_PKG" ]; then
            echo "Konnte kein MacTeX-Paket unter $MACTEX_BASE finden." >&2
            exit 1
        fi
    fi
    # installer -pkg zeigt die Lizenzseite des MacTeX-Pakets nicht an.
    echo "Hinweis: MacTeX ist nicht Teil von LatexIDE; jede Komponente hat ihre eigene Lizenz."
    echo "  TeX Live: https://www.tug.org/texlive/LICENSE.TL"
    echo "  MacTeX:   https://www.tug.org/mactex/"
    echo "Lade $MACTEX_PKG (mehrere GB, kann lange dauern)..."
    curl -fL -o "$TMP_DIR/$MACTEX_PKG" "$MACTEX_BASE/$MACTEX_PKG"
    echo "Installiere MacTeX (Administrator-Passwort erforderlich)..."
    sudo installer -pkg "$TMP_DIR/$MACTEX_PKG" -target /
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
"$APP_ROOT/node/bin/node" server/desktop.js &
SERVER_PID=$!
sleep 2
open "http://localhost:$PORT"
wait "$SERVER_PID"
EOF
chmod +x "$STARTER"

echo ""
echo "=== Installation abgeschlossen ==="
echo "Starter angelegt: $STARTER"
echo "Hinweis: Beim ersten Start von LatexIDE.command meldet macOS Gatekeeper"
echo "moeglicherweise eine Sicherheitswarnung. Falls noetig: Systemeinstellungen ->"
echo "Datenschutz & Sicherheit -> 'Dennoch oeffnen' (aeltere macOS: Rechtsklick -> 'Oeffnen')."
