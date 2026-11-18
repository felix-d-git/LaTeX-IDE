// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
const { parentPort, workerData } = require('worker_threads');
const { searchProjectSync } = require('./search');
try {
  parentPort.postMessage({ results: searchProjectSync(workerData.root, workerData.query, workerData.opts) });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
