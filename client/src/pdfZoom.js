// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Reine Zoom-Rechnung fuer Strg + Mausrad (#210): ~10 % pro Raste, Grenzen 25-300 %.
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;
const STEP = 1.1;

export function wheelScale(scale, deltaY) {
  if (!deltaY) return scale;
  const next = deltaY < 0 ? scale * STEP : scale / STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}
