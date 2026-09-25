#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installiere Abhaengigkeiten..."
  npm install
fi
npm start
