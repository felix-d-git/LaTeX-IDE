// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Theme before the first paint (no light flash in dark mode). Own file instead of an inline
// <script>: the CSP allows scripts only from 'self' (#115). Key as in settingsDialog.js.
try {
  var a = JSON.parse(localStorage.getItem('latex-ide-appearance-v1'));
  if (a && a.theme) document.documentElement.dataset.theme = a.theme;
} catch (e) {}
