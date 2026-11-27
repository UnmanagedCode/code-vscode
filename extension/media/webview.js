// The outer webview script: hosts the cc iframe and the hidden relay iframe,
// and forwards messages between the extension host and the relay.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const ccOrigin = document.body.dataset.ccOrigin || '';
  const relayFrame = document.getElementById('relay');
  const ccFrame = document.getElementById('cc');

  // The panel's persisted state: VS Code hands it back to the serializer, so a restored tab knows its session.
  vscode.setState({ sessionId: document.body.dataset.sessionId || null });

  const connect = document.getElementById('connect');
  if (connect) connect.addEventListener('click', () => vscode.postMessage({ type: 'connect' }));

  const from = (ev, frame) => !!frame && ev.source === frame.contentWindow;

  window.addEventListener('message', (ev) => {
    if (from(ev, relayFrame)) {
      // Only the relay page, on cc's origin, speaks for the relay.
      if (ev.origin !== ccOrigin || !ev.data) return;
      if (ev.data.type === 'ready') vscode.postMessage({ type: 'relayReady' });
      else if (ev.data.type === 'result') vscode.postMessage({ type: 'relayResult', msg: ev.data });
      return;
    }
    // Nothing the embedded cc page posts is acted on.
    if (from(ev, ccFrame)) return;

    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'relayRequest' && relayFrame && ccOrigin) {
      relayFrame.contentWindow.postMessage(msg.msg, ccOrigin);
    } else if (msg.type === 'showDocument' && ccFrame && ccOrigin && new URL(msg.url).origin === ccOrigin) {
      ccFrame.src = msg.url;
      vscode.setState({ sessionId: msg.sessionId ?? null });
    }
  });
})();
