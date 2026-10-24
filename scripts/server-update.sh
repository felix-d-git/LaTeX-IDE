#!/usr/bin/env bash
# Auto-update of a Docker-hosted server: if GitHub has a newer release than the one
# installed, back up the data dir (keeps the newest 3 backups), unpack the
# release over APP_DIR and rebuild the container. Meant for cron; which line
# depends on UPDATE_MODE in .env (the web UI shows admins a banner either way):
#   auto:   17 4 * * * /pfad/zu/LaTeX-IDE/scripts/server-update.sh >> $HOME/latex-update.log 2>&1
#   button: * * * * * /pfad/zu/LaTeX-IDE/scripts/server-update.sh --if-requested >> $HOME/latex-update.log 2>&1
#   notify: no cron, run the script by hand
# Env (or APP_DIR/.update.env):
#   APP_DIR      default: the folder this script lives in, one up
#   DATA_DIR     the mounted data dir; default LATEX_DATA_DIR from .env, else ./data
#   COMPOSE      compose file; default docker-compose.yml (Pi: docker-compose.pi.yml)
#   BACKUP_DIR   default: $DATA_DIR/../backups
#   GITHUB_TOKEN only while the repo is private (read-only "Contents" token)
#   UPDATE_REPO  default: felix-d-git/LaTeX-IDE
# .env, .update.env and anything not in the release stay untouched. Progress goes to
# .update-status next to .update-request, where the web UI shows it to admins.
set -euo pipefail

# Everything runs inside main(): bash parses the whole function before running it.
# Step 2 copies the new release over this very file (same inode); without main()
# bash would read on at the old byte offset in the new content.
main() {
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
[ -f "$APP_DIR/.update.env" ] && . "$APP_DIR/.update.env"
if [ -z "${DATA_DIR:-}" ] && [ -f "$APP_DIR/.env" ]; then
  # tolerate CRLF, "export ", spaces around "=", a trailing " #comment" and quotes
  DATA_DIR="$(tr -d '\r' < "$APP_DIR/.env" | sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}LATEX_DATA_DIR[[:space:]]*=[[:space:]]*//p' | tail -1 \
    | sed "s/[[:space:]]\{1,\}#.*\$//; s/[[:space:]]*\$//; s/^\"\(.*\)\"\$/\1/; s/^'\(.*\)'\$/\1/")"
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
REQUEST="$SRC_PARENT/$BACKUP_SRC/.update-request"
STATUS="$SRC_PARENT/$BACKUP_SRC/.update-status"

# One run at a time (cron fires every minute in button mode, a rebuild takes longer).
# flock is Linux-only; Git Bash/macOS run the script by hand anyway.
if command -v flock >/dev/null; then
  exec 9>"$APP_DIR/.update.lock"
  flock -n 9 || exit 0
fi

# --if-requested: only run when an admin pressed "Jetzt aktualisieren" (file written by the app).
if [ "${1:-}" = "--if-requested" ]; then
  [ -f "$REQUEST" ] || exit 0
  rm -f "$REQUEST"
fi

# Status for the web UI: {"state":"running|done|failed","from":..,"to":..,"at":..,"log":..}.
# Not fatal if the data dir is not writable for this user.
RUNLOG="$(mktemp)"
tmp="$(mktemp -d)"
# Any non-zero exit (also under set -e without ERR, or INT/TERM/HUP) must not leave "running" behind.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then status failed; fi; rm -rf "$tmp" "$RUNLOG"' EXIT
trap 'exit 143' INT TERM HUP
installed="$(cat "$APP_DIR/.release" 2>/dev/null || true)"
tag=""
status() {
  local log=""
  [ "$1" = failed ] && log="$(tail -n 20 "$RUNLOG" | tr -d '\000-\010\013-\037' | tr '\t' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
  printf '{"state":"%s","from":"%s","to":"%s","at":"%s","log":"%s"}\n' "$1" "$installed" "$tag" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$log" > "$STATUS" 2>/dev/null || true
}
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$RUNLOG"; }
trap 'status failed' ERR
# Request already taken: report "running" before the GitHub lookup so the banner keeps polling.
[ "${1:-}" = "--if-requested" ] && status running

BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DATA_DIR")/backups}"
REPO="${UPDATE_REPO:-felix-d-git/LaTeX-IDE}"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

# ${AUTH[@]+...}: empty array is "unbound" under set -u in bash 3.2 (macOS)
rel="$(curl -fsSL ${AUTH[@]+"${AUTH[@]}"} -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" 2>>"$RUNLOG")" \
  || { say "GitHub nicht erreichbar oder Repo privat ohne GITHUB_TOKEN ($(tail -n 1 "$RUNLOG"))"; false; }
tag="$(printf '%s' "$rel" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
[ -n "$tag" ] || { say "kein Release gefunden"; false; }
# Only update to something newer (a re-tagged older release must not downgrade).
if [ -n "$installed" ] && [ "$(printf '%s\n' "${installed#v}" "${tag#v}" | sort -V | tail -1)" = "${installed#v}" ]; then
  say "aktuell (installiert $installed, neuestes Release $tag)"
  [ "${1:-}" = "--if-requested" ] && status done
  exit 0
fi
say "Update $installed -> $tag"
status running

# 1. Backup, keep the newest 3.
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/data-$(date +%Y%m%d-%H%M%S)-${installed:-unbekannt}.tar.gz" --exclude="$BACKUP_SRC/desktop" \
  --exclude="$BACKUP_SRC/.update-request" --exclude="$BACKUP_SRC/.update-status" --exclude='*/.latex-ide-out' \
  -C "$SRC_PARENT" "$BACKUP_SRC" 2>>"$RUNLOG" || [ $? -eq 1 ]  # exit 1 = file changed while reading (server keeps writing)
ls -1t "$BACKUP_DIR"/data-*.tar.gz | tail -n +4 | while IFS= read -r f; do rm -f -- "$f"; done
say "Backup fertig"

# 2. Unpack the release into a fresh dir, copy it over APP_DIR and delete files the
# previous release had but this one no longer has (.release-files = list of the last one).
curl -fsSL ${AUTH[@]+"${AUTH[@]}"} -H 'Accept: application/vnd.github+json' -o "$tmp/src.tar.gz" "https://api.github.com/repos/$REPO/tarball/$tag" 2>>"$RUNLOG"
mkdir "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1
(cd "$tmp/src" && find . -type f | sed 's|^\./||' | sort) > "$tmp/files"
cp -a "$tmp/src/." "$APP_DIR/"
if [ -f "$APP_DIR/.release-files" ]; then
  comm -23 <(sort "$APP_DIR/.release-files") "$tmp/files" | while IFS= read -r f; do
    case "$f" in ""|/*|*..*) continue ;; esac
    # case-insensitive FS (macOS): a renamed file is the same path as the new one
    if [ -e "$tmp/src/$f" ]; then continue; fi
    rm -f -- "$APP_DIR/$f"
  done
fi
cp "$tmp/files" "$APP_DIR/.release-files"
say "Quellstand $tag entpackt"

# 3. Rebuild (--pull: fresh base image, the cached node:24 tag would stay old) + restart.
cd "$APP_DIR"
docker compose ${COMPOSE:+-f "$COMPOSE"} build --pull >>"$RUNLOG" 2>&1
docker compose ${COMPOSE:+-f "$COMPOSE"} up -d >>"$RUNLOG" 2>&1
printf '%s\n' "$tag" > "$APP_DIR/.release"
say "fertig ($tag)"
status done
}

# Same line: nothing after it is read from the (possibly replaced) file.
main "$@"; exit $?
