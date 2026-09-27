#!/usr/bin/env bash
# Auto-update of the server (Pi): if GitHub has a newer release than the one
# installed, back up the data dir (keeps the newest 3 backups), unpack the
# release over APP_DIR and rebuild the container. Meant for cron, e.g.
#   17 4 * * * /home/pi/container/latex/scripts/server-update.sh >> /home/pi/latex-update.log 2>&1
# Env (or APP_DIR/.update.env):
#   APP_DIR      default: the folder this script lives in, one up
#   DATA_DIR     the mounted data dir (LATEX_DATA_DIR from .env)
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
: "${DATA_DIR:?DATA_DIR bzw. LATEX_DATA_DIR fehlt}"
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
tar -czf "$BACKUP_DIR/data-$(date +%Y%m%d-%H%M%S)-${installed:-unbekannt}.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
ls -1t "$BACKUP_DIR"/data-*.tar.gz | tail -n +4 | xargs -r rm -f --

# 2. Unpack the release source over APP_DIR.
# ponytail: files deleted in the new release stay behind; switch to a fresh dir + swap if that ever matters.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "${AUTH[@]}" -H 'Accept: application/vnd.github+json' -o "$tmp/src.tar.gz" "https://api.github.com/repos/$REPO/tarball/$tag"
tar -xzf "$tmp/src.tar.gz" -C "$APP_DIR" --strip-components=1

# 3. Rebuild + restart.
cd "$APP_DIR"
docker compose -f docker-compose.pi.yml up -d --build
printf '%s\n' "$tag" > "$APP_DIR/.release"
echo "$(date -Is) fertig ($tag)"
