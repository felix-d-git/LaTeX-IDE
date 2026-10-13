#!/usr/bin/env bash
cd "$(dirname "$0")"
# Install when node_modules is missing or package-lock.json is newer (new dependencies after an update).
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installiere Abhaengigkeiten..."
  npm ci
fi
npm start
