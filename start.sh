#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
cd "$(dirname "$0")"
# Install when node_modules is missing or package-lock.json is newer (new dependencies after an update).
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installiere Abhaengigkeiten..."
  npm ci
fi
npm start
