let ws;
let subscribed = null;

// Tell the server which project this window shows (events are filtered per project).
export function wsSubscribe(projectId) {
  subscribed = projectId || null;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', projectId: subscribed }));
}

export function connectWs(handlers) {
  let retryDelay = 1000;
  let wasClosed = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      const handler = handlers[msg.type];
      if (handler) handler(msg);
    };
    ws.onopen = () => {
      retryDelay = 1000;
      if (subscribed) wsSubscribe(subscribed);
      // Events missed while the channel was down: let the app reload tree/comments.
      if (wasClosed && handlers.reconnected) handlers.reconnected({ type: 'reconnected' });
    };
    ws.onclose = () => {
      wasClosed = true;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, 10000);
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return () => ws && ws.close();
}
