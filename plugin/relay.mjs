// Browser glue: wires window messages to relayCore and announces readiness to the embedding webview.
import { createRelay } from './relayCore.mjs';

const root = document.documentElement.dataset.ccRoot ?? '';
const relay = createRelay({ fetch: (...a) => fetch(...a), root, parent: window.parent });
window.addEventListener('message', (ev) => { relay.onMessage(ev); });
// The embedding webview's origin is not known here, so announce readiness to any parent;
// the message carries no data and the parent accepts it only from this frame's origin.
window.parent.postMessage({ type: 'ready' }, '*');
