// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Minimale Brücke: die Seite erfährt nur, dass sie in der Desktop-App läuft. Kein Node-Zugriff.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('lideDesktop', { shell: 'electron' });
