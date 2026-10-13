#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installiere Abhaengigkeiten..."
  npm install
elif [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Lockfile neuer - aktualisiere Abhaengigkeiten..."
  npm ci
fi
npm start
