// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
// Yellow bar at the top while the server is unreachable. × shrinks it to a
// thin strip at the very top edge (click the strip to expand again).
// Offline = any source says so: Yjs WebSocket ('collab') or HTTP answers ('http',
// the desktop app marks cached/local answers with X-Offline).
const sources = { collab: false, http: false };
let minimized = false;

const el = document.createElement('div');
el.id = 'offline-banner';
el.className = 'hidden';
el.setAttribute('role', 'status');
el.innerHTML =
  '<span class="offline-banner-text">Offline – du arbeitest mit der lokalen Kopie. Änderungen werden beim Wiederverbinden zusammengeführt; Konflikte erscheinen im Review.</span>' +
  '<button class="offline-banner-close" title="Verkleinern" aria-label="Hinweis verkleinern">×</button>';
document.body.appendChild(el);

el.querySelector('.offline-banner-close').addEventListener('click', (e) => {
  e.stopPropagation();
  minimized = true;
  render();
});
el.addEventListener('click', () => {
  if (!minimized) return;
  minimized = false;
  render();
});

// Desktop app: "might be outdated" hint (no connection at start), text comes from /api/desktop/info (#212).
let stale = '';
const textEl = el.querySelector('.offline-banner-text');
const defaultText = textEl.textContent;

function isOffline() {
  return sources.collab || sources.http;
}

function render() {
  textEl.textContent = stale || defaultText;
  el.classList.toggle('hidden', !isOffline() && !stale);
  el.classList.toggle('minimized', minimized);
  el.title = minimized ? 'Offline – klicken zum Aufklappen' : '';
}

export const offlineBanner = {
  set(offline, source = 'collab') {
    if (sources[source] === offline) return;
    sources[source] = offline;
    if (!isOffline()) minimized = false; // next outage shows the full bar again
    render();
  },
  isOffline,
};

window.addEventListener('lide-offline', (e) => offlineBanner.set(e.detail, 'http'));

async function pollStale() {
  let j = null;
  try {
    const r = await fetch('/api/desktop/info');
    j = r.ok ? await r.json().catch(() => null) : null;
  } catch {
    return setTimeout(pollStale, 5000)?.unref?.(); // desktop proxy briefly away: try again (unref: Node tests must not hang)
  }
  if (!j || !j.desktop) return; // web UI: no polling
  const next = j.staleNotice || '';
  if (next !== stale) {
    stale = next;
    if (!stale) minimized = false;
    render();
  }
  setTimeout(pollStale, 5000)?.unref?.();
}
pollStale();
