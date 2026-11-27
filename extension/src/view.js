'use strict';
// One cc editor tab's webview: its HTML and CSP, and message routing between the extension and that webview.

const VIEW_TYPE = 'codeConductor.session';
// Above the relay's own 10 s request timeout, so the relay's answer wins when it can.
const REQUEST_TIMEOUT_MS = 12_000;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The webview document. `ccOrigin` + `relayUrl` embed the hidden relay frame; `documentUrl` also embeds cc;
 * `message` shows text with a Connect button. `sessionId` is persisted by webview.js as the panel's state so a restored
 * tab knows its session. Scripts need `nonce`; frames are limited to `ccOrigin`.
 */
function renderHtml({ nonce, cspSource, scriptUri, ccOrigin = null, relayUrl = null, documentUrl = null, message = null, sessionId = null }) {
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
</head><body data-cc-origin="${escapeHtml(ccOrigin ?? '')}" data-session-id="${escapeHtml(sessionId ?? '')}">${notice}${frames}<script nonce="${nonce}" src="${escapeHtml(scriptUri)}"></script></body></html>`;
}

function newNonce(randomBytes) {
  return randomBytes(16).toString('hex');
}

/** A new cc panel beside the current editor. */
function createPanel(vscode, extensionUri) {
  return vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'cc',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')], retainContextWhenHidden: true },
  );
}

/**
 * One panel's channel: adopts `panel` (new or restored) and owns its ready flag, pending requests and rendering.
 * deps: {vscode, extensionUri, randomBytes(n), panel}. Events (`on(name, fn)`): ready, connect, close, viewState({active, visible}).
 */
function createTabView({ vscode, extensionUri, randomBytes, panel }) {
  let ready = false;
  let disposed = false;
  let readyWaiters = [];
  const pending = new Map();
  let nextReq = 1;
  const listeners = { ready: [], connect: [], close: [], viewState: [] };
  const emit = (name, arg) => { for (const fn of listeners[name]) fn(arg); };
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
    if (disposed) throw new Error('the cc tab is not open');
    resetChannel();
    const { webview } = panel;
    webview.html = renderHtml({
      nonce: newNonce(randomBytes),
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')).toString(),
      ...args,
    });
  }

  panel.title = 'cc';
  panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg') };
  panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
  panel.webview.onDidReceiveMessage(onMessage);
  panel.onDidChangeViewState(() => emit('viewState', { active: panel.active, visible: panel.visible }));
  panel.onDidDispose(() => {
    disposed = true;
    resetChannel();
    for (const w of readyWaiters) w.reject(new Error('the cc tab closed'));
    readyWaiters = [];
    emit('close');
  });

  return {
    on(name, fn) { listeners[name].push(fn); },
    isDisposed() { return disposed; },
    /** Whether the panel is its group's shown editor in a visible group (not focus). */
    isVisible() { return !disposed && panel.visible; },
    /** The editor group the panel is in, or undefined once disposed. */
    viewColumn() { return disposed ? undefined : panel.viewColumn; },
    isActive() { return !disposed && panel.active; },
    reveal() { if (!disposed) panel.reveal(); },
    dispose() { if (!disposed) panel.dispose(); },
    setTitle(title) { if (!disposed) panel.title = title; },
    /** Loads the relay (and cc, when `documentUrl` is given) for `ccOrigin`; `sessionId` is persisted as the panel's state. */
    load({ ccOrigin, relayUrl, documentUrl = null, sessionId = null }) { render({ ccOrigin, relayUrl, documentUrl, sessionId }); },
    /** Shows text with a Connect button and no frames; `sessionId` keeps a session in the panel's state across a reload. */
    showMessage(message, sessionId = null) { if (!disposed) render({ message, sessionId }); },
    /** Points the cc frame at `url` and persists `sessionId`; the relay frame must already be loaded for the same origin. */
    setDocument(url, sessionId) {
      if (disposed) throw new Error('the cc tab is not open');
      panel.webview.postMessage({ type: 'showDocument', url, sessionId });
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
      if (disposed) return Promise.resolve(notOpen());
      const reqId = String(nextReq++);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve({ ok: false, code: 'REQUEST_FAILED', error: 'the relay did not answer' }); }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, { resolve, timer });
        panel.webview.postMessage({ type: 'relayRequest', msg: { ...msg, reqId } });
      });
    },
  };
}

module.exports = { VIEW_TYPE, REQUEST_TIMEOUT_MS, renderHtml, createPanel, createTabView };
