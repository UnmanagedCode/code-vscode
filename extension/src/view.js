'use strict';
// The cc panel view: the webview's HTML and CSP, and message routing between the extension and the webview.

const VIEW_ID = 'codeConductor.session';
// Above the relay's own 10 s request timeout, so the relay's answer wins when it can.
const REQUEST_TIMEOUT_MS = 12_000;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The webview document. `ccOrigin` + `relayUrl` embed the hidden relay frame; `documentUrl` also embeds cc;
 * `message` shows text with a Connect button. Scripts need `nonce`; frames are limited to `ccOrigin`.
 */
function renderHtml({ nonce, cspSource, scriptUri, ccOrigin = null, relayUrl = null, documentUrl = null, message = null }) {
  const csp = [
    "default-src 'none'",
    `frame-src ${ccOrigin ?? "'none'"}`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
  ].join('; ');
  const ccSrc = documentUrl ? ` src="${escapeHtml(documentUrl)}"` : '';
  const frames = ccOrigin
    ? `<iframe id="cc"${ccSrc} title="cc"></iframe><iframe id="relay" src="${escapeHtml(relayUrl)}" title="relay" hidden></iframe>`
    : '';
  const notice = message === null ? '' : `<main><p>${escapeHtml(message)}</p><button id="connect">Connect</button></main>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{height:100%;margin:0;padding:0}iframe{border:0;width:100%;height:100%}iframe[hidden]{display:none}main{padding:12px}</style>
</head><body data-cc-origin="${escapeHtml(ccOrigin ?? '')}">${notice}${frames}<script nonce="${nonce}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}

function newNonce(randomBytes) {
  return randomBytes(16).toString('hex');
}

/** deps: {vscode, extensionUri, randomBytes(n), setTimeout/clearTimeout via globals} */
function createView({ vscode, extensionUri, randomBytes }) {
  let webviewView = null;
  let resolvedWaiters = [];
  let ready = false;
  let readyWaiters = [];
  const pending = new Map();
  let nextReq = 1;
  const listeners = { resolve: [], ready: [], connect: [] };
  const emit = (name) => { for (const fn of listeners[name]) fn(); };

  function onMessage(msg) {
    if (msg?.type === 'relayReady') {
      ready = true;
      for (const w of readyWaiters) w.resolve();
      readyWaiters = [];
      emit('ready');
    } else if (msg?.type === 'relayResult') {
      const entry = pending.get(msg.msg?.reqId);
      if (entry) { pending.delete(msg.msg.reqId); clearTimeout(entry.timer); entry.resolve(msg.msg); }
    } else if (msg?.type === 'connect') {
      emit('connect');
    }
  }

  function resetChannel() {
    ready = false;
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the panel reloaded' }); pending.delete(id); }
  }

  function render(args) {
    if (!webviewView) throw new Error('the cc view has not been resolved');
    resetChannel();
    const { webview } = webviewView;
    webview.html = renderHtml({
      nonce: newNonce(randomBytes),
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')).toString(),
      ...args,
    });
  }

  return {
    /** The provider to register for VIEW_ID. */
    provider: {
      resolveWebviewView(view) {
        webviewView = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
        view.webview.onDidReceiveMessage(onMessage);
        view.onDidDispose(() => { webviewView = null; resetChannel(); });
        for (const w of resolvedWaiters) w();
        resolvedWaiters = [];
        emit('resolve');
      },
    },
    on(name, fn) { listeners[name].push(fn); },
    /** Shows the view, resolving the webview if it never was. */
    async reveal() {
      if (webviewView) { webviewView.show?.(true); return; }
      const resolved = new Promise((resolve) => resolvedWaiters.push(resolve));
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      await resolved;
    },
    /** Loads the relay (and cc, when `documentUrl` is given) for `ccOrigin`. */
    load({ ccOrigin, relayUrl, documentUrl = null }) { render({ ccOrigin, relayUrl, documentUrl }); },
    /** Shows text with a Connect button and no frames. A view not yet resolved shows it when it resolves (connection.resume). */
    showMessage(message) { if (webviewView) render({ message }); },
    /** Points the cc frame at `url`; the relay frame must already be loaded for the same origin. */
    setDocument(url) { webviewView.webview.postMessage({ type: 'showDocument', url }); },
    /** Resolves once the relay frame reports ready; rejects after `ms`. */
    whenReady(ms) {
      if (ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => { readyWaiters = readyWaiters.filter((w) => w !== waiter); reject(new Error('relay not ready')); }, ms);
        readyWaiters.push(waiter);
      });
    },
    /** One relay request; always resolves to {ok, ...}. */
    request(msg) {
      if (!webviewView) return Promise.resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the cc view is not open' });
      const reqId = String(nextReq++);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the relay did not answer' }); }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, { resolve, timer });
        webviewView.webview.postMessage({ type: 'relayRequest', msg: { ...msg, reqId } });
      });
    },
  };
}

module.exports = { VIEW_ID, REQUEST_TIMEOUT_MS, renderHtml, createView };
