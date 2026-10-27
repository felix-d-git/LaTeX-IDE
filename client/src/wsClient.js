// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
let ws;
let subscribed = null;

// Tell the server which project this window shows (events are filtered per project).
export function wsSubscribe(projectId) {
  subscribed = projectId || null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', projectId: subscribed }));
}

// onReconnect: events were missed while disconnected -> caller reloads its state.
// onUnauthorized: session ended (logout elsewhere / expired) -> no endless reconnects.
// Returns stop().
export function connectWs(handlers, { onReconnect, onUnauthorized } = {}) {
  let retryDelay = 1000;
  let stopped = false;
  let everOpened = false;
  let watchdog = null;
  let timer = null;

  // No traffic for 45 s = dead connection (sleep, NAT). Only once the server answered a ping
  // (older servers don't know it - then no watchdog, as before).
  let pongSeen = false;
  const arm = () => {
    clearTimeout(watchdog);
    if (pongSeen) watchdog = setTimeout(() => ws && ws.close(), 45000);
  };
  const ping = setInterval(() => ws && ws.readyState === 1 && ws.send('{"type":"ping"}'), 20000);

  async function sessionEnded() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      return r.status === 401;
    } catch {
      return false; // server unreachable: keep trying
    }
  }

  function connect() {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = (ws = new WebSocket(`${proto}://${location.host}/ws`));
    sock.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') pongSeen = true;
      arm();
      const handler = handlers[msg.type];
      if (handler) handler(msg);
    };
    sock.onopen = () => {
      retryDelay = 1000;
      if (subscribed) wsSubscribe(subscribed);
      if (everOpened && onReconnect) onReconnect();
      everOpened = true;
    };
    sock.onclose = async () => {
      clearTimeout(watchdog);
      if (stopped || sock !== ws) return;
      if (await sessionEnded()) {
        stopped = true;
        clearInterval(ping);
        if (onUnauthorized) onUnauthorized();
        return;
      }
      timer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, 10000);
    };
    sock.onerror = () => sock.close();
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(watchdog);
    clearInterval(ping);
    if (ws) ws.close();
  };
}
