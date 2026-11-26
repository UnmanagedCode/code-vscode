// Browser glue: wires window messages to relayCore and announces readiness to the embedding webview.
import { createRelay } from './relayCore.mjs';

const root = document.documentElement.dataset.ccRoot ?? '';
const relay = createRelay({ fetch: (...a) => fetch(...a), root, parent: window.parent });
window.addEventListener('message', (ev) => { relay.onMessage(ev); });
// Ready is announced once cc's UI mode is read, so every later op is a single cc call. When the read fails
// no ready is posted and the extension reports the relay as unreachable.
// The embedding webview's origin is not known here, so announce to any parent; the message carries no data
// and the parent accepts it only from this frame's origin.
relay.start().then((r) => {
  if (r.ok) window.parent.postMessage({ type: 'ready' }, '*');
  else console.error('code-vscode relay: cc health read failed', r.code, r.error);
});
