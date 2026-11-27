// A fresh fake `vscode` per call: panels, commands, quick picks, status bar, editor events, config. Panels answer the
// webview protocol like webview.js does: html with a relay frame reports relayReady; relayRequest posts get relayResult.

function emitter() {
  const listeners = new Set();
  return { on: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, fire: (...a) => [...listeners].forEach((fn) => fn(...a)) };
}

const defaultConductors = [];

export function createFakeVscode({ serverUrl = 'http://127.0.0.1:8787', conductors = defaultConductors, relay = null } = {}) {
  const panels = [];
  const commands = new Map();
  const serializers = new Map();
  const messages = [];
  const quickPicks = [];
  const pickScript = [];
  const statusBars = [];
  const relayLog = [];
  const selection = emitter();
  const activeEditor = emitter();
  const config = { serverUrl };
  const state = { conductors, relay };

  function answer(msg) {
    if (state.relay) { const r = state.relay(msg); if (r) return r; }
    if (msg.op === 'listConductors') return { ok: true, value: state.conductors };
    if (msg.op === 'newConductor') return { ok: true, value: { sessionId: 'new-sid' } };
    return { ok: true };
  }

  function makePanel({ visible = true, active = true, auto = true, viewColumn = 2 } = {}) {
    const disposers = [];
    const stateListeners = [];
    const posted = [];
    let html = '';
    const p = {
      title: '', iconPath: null, visible, active, viewColumn, disposed: false, revealed: 0,
      webview: {
        options: null, cspSource: 'csp:', posted, handler: null,
        get html() { return html; },
        set html(v) {
          html = v;
          if (auto && v.includes('id="relay"')) queueMicrotask(() => p.webview.handler?.({ type: 'relayReady' }));
        },
        asWebviewUri: (u) => u,
        postMessage(m) {
          posted.push(m);
          if (m.type === 'relayRequest') relayLog.push(m.msg);
          if (auto && m.type === 'relayRequest') {
            const result = answer(m.msg);
            queueMicrotask(() => p.webview.handler?.({ type: 'relayResult', msg: { type: 'result', reqId: m.msg.reqId, ...result } }));
          }
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (fn) => { p.webview.handler = fn; },
      },
      onDidDispose: (fn) => { disposers.push(fn); },
      onDidChangeViewState: (fn) => { stateListeners.push(fn); },
      reveal() { p.revealed += 1; },
      dispose() { if (p.disposed) return; p.disposed = true; disposers.forEach((fn) => fn()); },
      setVisible(v) { p.visible = v; stateListeners.forEach((fn) => fn({ webviewPanel: p })); },
      setActive(v) { p.active = v; stateListeners.forEach((fn) => fn({ webviewPanel: p })); },
    };
    return p;
  }

  const vscode = {
    ViewColumn: { Beside: -2 },
    Uri: { parse: (s) => s, joinPath: (...a) => a.join('/') },
    window: {
      createWebviewPanel: (type, title, show, options) => { const p = makePanel(); p.created = { type, title, show, options }; panels.push(p); return p; },
      registerWebviewPanelSerializer: (type, s) => { serializers.set(type, s); return { dispose() {} }; },
      createStatusBarItem: () => { const b = { text: '', command: null, shown: false, show() { b.shown = true; }, dispose() {} }; statusBars.push(b); return b; },
      showQuickPick: async (items, options) => {
        quickPicks.push({ items, options });
        const s = pickScript.shift();
        return typeof s === 'function' ? s(items) : s;
      },
      showErrorMessage: (m) => messages.push(['error', m]),
      showWarningMessage: (m) => messages.push(['warning', m]),
      showInformationMessage: (m) => messages.push(['info', m]),
      onDidChangeTextEditorSelection: selection.on,
      onDidChangeActiveTextEditor: activeEditor.on,
      activeTextEditor: undefined,
      visibleTextEditors: [],
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    workspace: { getConfiguration: () => ({ get: (k) => config[k] }) },
    env: { asExternalUri: async (u) => ({ toString: () => u }) },
  };

  return {
    vscode, panels, commands, serializers, messages, quickPicks, pickScript, statusBars, relayLog, config, state, makePanel,
    fireSelection: (editor) => selection.fire({ textEditor: editor }),
    fireActiveEditor: (editor) => activeEditor.fire(editor),
    /** relay requests of one op, in order */
    requests: (op) => relayLog.filter((m) => m.op === op),
  };
}

export const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
