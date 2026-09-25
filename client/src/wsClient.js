export function connectWs(handlers) {
  let ws;
  let retryDelay = 1000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      const handler = handlers[msg.type];
      if (handler) handler(msg);
    };
    ws.onopen = () => { retryDelay = 1000; };
    ws.onclose = () => {
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, 10000);
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return () => ws && ws.close();
}
