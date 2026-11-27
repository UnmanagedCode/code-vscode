'use strict';
// The cc editor tab: the webview's HTML and CSP, and message routing between the extension and the webview.

const VIEW_TYPE = 'codeConductor.session';
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

/** deps: {vscode, extensionUri, randomBytes(n)}. Holds at most one WebviewPanel. */
function createView({ vscode, extensionUri, randomBytes }) {
  let panel = null;
  let ready = false;
  let readyWaiters = [];
  const pending = new Map();
  let nextReq = 1;
  const listeners = { resolve: [], ready: [], connect: [], close: [] };
  const emit = (name) => { for (const fn of listeners[name]) fn(); };
  const mediaRoot = () => vscode.Uri.joinPath(extensionUri, 'media');
  const notOpen = () => ({ ok: false, code: 'REQUEST_FAILED', error: 'the cc tab is not open' });

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
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the cc tab reloaded or closed' }); pending.delete(id); }
  }

  function render(args) {
    if (!panel) throw new Error('the cc tab is not open');
    resetChannel();
    const { webview } = panel;
    webview.html = renderHtml({
      nonce: newNonce(randomBytes),
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')).toString(),
      ...args,
    });
  }

  /** Takes over a new or restored panel. */
  function adopt(p) {
    panel = p;
    p.title = 'cc';
    p.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg') };
    p.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot()] };
    p.webview.onDidReceiveMessage(onMessage);
    p.onDidDispose(() => {
      panel = null;
      resetChannel();
      for (const w of readyWaiters) w.reject(new Error('the cc tab closed'));
      readyWaiters = [];
      emit('close');
    });
    emit('resolve');
  }

  return {
    /** Registered for VIEW_TYPE so a window reload restores the tab. */
    serializer: {
      async deserializeWebviewPanel(restored) { if (panel) restored.dispose(); else adopt(restored); },
    },
    on(name, fn) { listeners[name].push(fn); },
    isOpen() { return panel !== null; },
    /** Shows the tab, beside the current editor when it has to be created. */
    reveal() {
      if (panel) { panel.reveal(); return; }
      adopt(vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'cc',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [mediaRoot()], retainContextWhenHidden: true },
      ));
    },
    /** Loads the relay (and cc, when `documentUrl` is given) for `ccOrigin`. */
    load({ ccOrigin, relayUrl, documentUrl = null }) { render({ ccOrigin, relayUrl, documentUrl }); },
    /** Shows text with a Connect button and no frames; a closed tab shows it when it is next opened (connection.resume). */
    showMessage(message) { if (panel) render({ message }); },
    /** Points the cc frame at `url`; the relay frame must already be loaded for the same origin. */
    setDocument(url) {
      if (!panel) throw new Error('the cc tab is not open');
      panel.webview.postMessage({ type: 'showDocument', url });
    },
    /** Resolves once the relay frame reports ready; rejects after `ms` or when the tab closes. */
    whenReady(ms) {
      if (ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
        const timer = setTimeout(() => { readyWaiters = readyWaiters.filter((w) => w !== waiter); reject(new Error('relay not ready')); }, ms);
        readyWaiters.push(waiter);
      });
    },
    /** One relay request; always resolves to {ok, ...}. */
    request(msg) {
      if (!panel) return Promise.resolve(notOpen());
      const reqId = String(nextReq++);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the relay did not answer' }); }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, { resolve, timer });
        panel.webview.postMessage({ type: 'relayRequest', msg: { ...msg, reqId } });
      });
    },
  };
}

module.exports = { VIEW_TYPE, REQUEST_TIMEOUT_MS, renderHtml, createView };
