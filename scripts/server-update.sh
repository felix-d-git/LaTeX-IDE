#!/usr/bin/env bash
# Auto-update of a Docker-hosted server: if GitHub has a newer release than the one
# installed, back up the data dir (keeps the newest 3 backups), unpack the
# release over APP_DIR and rebuild the container. Meant for cron; which line
# depends on UPDATE_MODE in .env (the web UI shows admins a banner either way):
#   auto:   17 4 * * * /pfad/zu/latex-web-ide/scripts/server-update.sh >> $HOME/latex-update.log 2>&1
#   button: */5 * * * * /pfad/zu/latex-web-ide/scripts/server-update.sh --if-requested >> $HOME/latex-update.log 2>&1
#   notify: no cron, run the script by hand
# Env (or APP_DIR/.update.env):
#   APP_DIR      default: the folder this script lives in, one up
#   DATA_DIR     the mounted data dir; default LATEX_DATA_DIR from .env, else ./data
#   COMPOSE      compose file; default docker-compose.yml (Pi: docker-compose.pi.yml)
#   BACKUP_DIR   default: $DATA_DIR/../backups
#   GITHUB_TOKEN only while the repo is private (read-only "Contents" token)
#   UPDATE_REPO  default: felix-d-git/latex-web-ide
# .env, .update.env and anything not in the release stay untouched.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
[ -f "$APP_DIR/.update.env" ] && . "$APP_DIR/.update.env"
if [ -z "${DATA_DIR:-}" ] && [ -f "$APP_DIR/.env" ]; then
  DATA_DIR="$(sed -n 's/^LATEX_DATA_DIR=//p' "$APP_DIR/.env" | tail -1)"
fi
DATA_DIR="${DATA_DIR:-./data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$APP_DIR/${DATA_DIR#./}" ;; esac
# Encrypted setup (DATA_KEY, docker-compose.pi.yml): only $DATA_DIR/vault is on disk,
# the plaintext lives in container RAM. Backup = vault only; restoring needs DATA_KEY.
BACKUP_SRC="$(basename "$DATA_DIR")"
SRC_PARENT="$(dirname "$DATA_DIR")"
if [ -d "$DATA_DIR/vault" ]; then
  BACKUP_SRC=vault
  SRC_PARENT="$DATA_DIR"
fi
# --if-requested: only run when an admin pressed "Jetzt aktualisieren" (file written by the app).
REQUEST="$SRC_PARENT/$BACKUP_SRC/.update-request"
if [ "${1:-}" = "--if-requested" ]; then
  [ -f "$REQUEST" ] || exit 0
  rm -f "$REQUEST"
fi
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DATA_DIR")/backups}"
REPO="${UPDATE_REPO:-felix-d-git/latex-web-ide}"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

rel="$(curl -fsSL "${AUTH[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")"
tag="$(printf '%s' "$rel" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$tag" ] || { echo "$(date -Is) kein Release gefunden"; exit 1; }
installed="$(cat "$APP_DIR/.release" 2>/dev/null || true)"
if [ "$tag" = "$installed" ]; then
  echo "$(date -Is) aktuell ($tag)"
  exit 0
fi
echo "$(date -Is) Update $installed -> $tag"

# 1. Backup, keep the newest 3.
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/data-$(date +%Y%m%d-%H%M%S)-${installed:-unbekannt}.tar.gz" --exclude="$BACKUP_SRC/desktop" --exclude="$BACKUP_SRC/.update-request" -C "$SRC_PARENT" "$BACKUP_SRC"
ls -1t "$BACKUP_DIR"/data-*.tar.gz | tail -n +4 | xargs -r rm -f --

# 2. Unpack the release source over APP_DIR.
# ponytail: files deleted in the new release stay behind; switch to a fresh dir + swap if that ever matters.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "${AUTH[@]}" -H 'Accept: application/vnd.github+json' -o "$tmp/src.tar.gz" "https://api.github.com/repos/$REPO/tarball/$tag"
tar -xzf "$tmp/src.tar.gz" -C "$APP_DIR" --strip-components=1

# 3. Rebuild + restart.
cd "$APP_DIR"
docker compose ${COMPOSE:+-f "$COMPOSE"} up -d --build
printf '%s\n' "$tag" > "$APP_DIR/.release"
echo "$(date -Is) fertig ($tag)"
