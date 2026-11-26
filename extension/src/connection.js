'use strict';
// Which conductor session the panel shows: choosing, persisting and reconnecting it, and the status bar.

const SESSION_KEY = 'codeConductor.sessionId';
const PLUGIN_PATH = 'plugins/code-vscode/';
const RELAY_READY_TIMEOUT_MS = 15_000;
const NEW_CONDUCTOR_LABEL = '$(add) New conductor';

const STATUS_TEXT = {
  connected: (s) => `cc: ${s.label}`,
  'not-connected': () => 'cc: not connected',
  'view-only': () => 'cc: view-only (no chip)',
  ended: () => 'cc: session ended',
  error: (s) => `cc: ${s.code}`,
};

/**
 * deps:
 *   vscode — window.showQuickPick / showErrorMessage / showWarningMessage / showInformationMessage /
 *            createStatusBarItem, env.asExternalUri, Uri.parse
 *   workspaceState — get/update, one per window and workspace
 *   getServerUrl() — the codeConductor.serverUrl setting
 *   view — reveal, load, showMessage, setDocument, whenReady, request
 *   sync — chipSync's enable, disable, pushNow
 */
function createConnection({ vscode, workspaceState, getServerUrl, view, sync }) {
  const bar = vscode.window.createStatusBarItem();
  let state = null;
  let busy = false;
  let connectedLabel = null;

  function setState(next) {
    const changed = !state || state.kind !== next.kind || state.code !== next.code || state.label !== next.label;
    state = next;
    bar.text = STATUS_TEXT[next.kind](next);
    bar.show();
    return changed;
  }

  function notRunning(next, text, show) {
    sync.disable();
    setState(next);
    view.showMessage(text);
    if (show) show(text);
  }

  async function endpoints() {
    const external = String(await vscode.env.asExternalUri(vscode.Uri.parse(getServerUrl())));
    const base = new URL(external.endsWith('/') ? external : `${external}/`);
    return {
      serverUrl: getServerUrl(),
      ccOrigin: base.origin,
      relayUrl: new URL(`${PLUGIN_PATH}relay`, base).toString(),
      documentUrl: (sid) => `${new URL(PLUGIN_PATH, base).toString()}?focus=${encodeURIComponent(sid)}`,
    };
  }

  async function relayReady(ep) {
    try {
      await view.whenReady(RELAY_READY_TIMEOUT_MS);
      return true;
    } catch {
      notRunning({ kind: 'error', code: 'RELAY_TIMEOUT' }, 'cc is not reachable from the panel.');
      vscode.window.showErrorMessage(
        `cc: the panel could not reach ${ep.serverUrl}. Check that cc is running there, that the code-vscode plugin is enabled in cc (Settings → Plugins; a disabled plugin answers 404), `
        + 'that the URL is not plain http on a non-loopback address (blocked as mixed content), and that it needs no login.',
      );
      return false;
    }
  }

  async function labelOf(sid) {
    const list = await view.request({ op: 'listConductors' });
    // A conductor still pristine is not listed, so absence says nothing about whether it lives.
    const row = list.ok ? list.value.find((c) => c.sessionId === sid) : null;
    return row?.displayLabel ?? sid.slice(0, 8);
  }

  function showConnected(label) {
    connectedLabel = label;
    setState({ kind: 'connected', label });
    sync.enable();
    sync.pushNow();
  }

  async function connect() {
    if (busy) return;
    busy = true;
    try {
      await view.reveal();
      const ep = await endpoints();
      view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl });
      if (!(await relayReady(ep))) return;

      const list = await view.request({ op: 'listConductors' });
      if (!list.ok) {
        vscode.window.showErrorMessage(`cc: could not list conductors (${list.code}: ${list.error ?? ''}).`);
        return;
      }
      const items = [
        ...list.value.map((c) => ({ label: c.displayLabel, description: c.status, sessionId: c.sessionId })),
        { label: NEW_CONDUCTOR_LABEL, isNew: true },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose the conductor to show' });
      if (!pick) return;

      let sid = pick.sessionId;
      let label = pick.label;
      if (pick.isNew) {
        const made = await view.request({ op: 'newConductor' });
        if (!made.ok) {
          vscode.window.showErrorMessage(`cc: could not start a conductor (${made.code}: ${made.error ?? ''}).`);
          return;
        }
        sid = made.value.sessionId;
        label = 'New conductor';
      }
      await workspaceState.update(SESSION_KEY, sid);
      view.setDocument(ep.documentUrl(sid));
      showConnected(label);
    } finally { busy = false; }
  }

  /** The view resolved: reconnect to the stored session, or show the not-connected page. */
  async function resume() {
    const sid = workspaceState.get(SESSION_KEY);
    if (!sid) {
      notRunning({ kind: 'not-connected' }, 'Not connected to a cc session.');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const ep = await endpoints();
      view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl, documentUrl: ep.documentUrl(sid) });
      if (!(await relayReady(ep))) return;
      showConnected(await labelOf(sid));
    } finally { busy = false; }
  }

  async function ended() {
    await workspaceState.update(SESSION_KEY, undefined);
    notRunning({ kind: 'ended' }, 'Session ended — run cc: Connect', (t) => vscode.window.showWarningMessage(`cc: ${t}`));
  }

  async function disconnect() {
    const sid = workspaceState.get(SESSION_KEY);
    sync.disable();
    if (sid) await view.request({ op: 'clearChip', sid });
    await workspaceState.update(SESSION_KEY, undefined);
    notRunning({ kind: 'not-connected' }, 'Not connected to a cc session.');
  }

  /** The relay (re)loaded while connected: bring the chip up to date. */
  function onRelayReady() {
    if (state?.kind === 'connected' || state?.kind === 'view-only') sync.pushNow();
  }

  /** chipSync's write: addressed to the stored session. */
  function sendChip(message) {
    const sid = workspaceState.get(SESSION_KEY);
    if (!sid) return Promise.resolve({ ok: false, code: 'SESSION_NOT_LIVE' });
    return view.request({ ...message, sid });
  }

  /** One chip write's outcome; the status bar and notifications change only on a state change. */
  async function onChipResult(result) {
    if (!state) return;
    if (state?.kind === 'ended' || state?.kind === 'not-connected') return;
    if (result.ok) {
      if (state.kind !== 'connected') setState({ kind: 'connected', label: connectedLabel });
      return;
    }
    if (result.code === 'SESSION_NOT_LIVE') { await ended(); return; }
    if (result.code === 'VIEW_ONLY') {
      if (setState({ kind: 'view-only' })) vscode.window.showInformationMessage('cc runs with --ui view or interact: this session takes no context chip.');
      return;
    }
    if (setState({ kind: 'error', code: result.code })) vscode.window.showWarningMessage(`cc: chip update failed (${result.code}${result.error ? `: ${result.error}` : ''}).`);
  }

  return { connect, disconnect, resume, onRelayReady, sendChip, onChipResult, dispose() { bar.dispose(); } };
}

module.exports = { SESSION_KEY, RELAY_READY_TIMEOUT_MS, createConnection };
