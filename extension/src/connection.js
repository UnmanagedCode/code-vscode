'use strict';
// Which conductor session the tab shows: choosing, persisting and reconnecting it, and the status bar.

const SESSION_KEY = 'codeConductor.sessionId';
const PLUGIN_PATH = 'plugins/code-vscode/';
const RELAY_READY_TIMEOUT_MS = 15_000;
const NEW_CONDUCTOR_LABEL = '$(add) New conductor';

const STATUS_TEXT = {
  connected: (s) => `cc: ${s.label}`,
  'not-connected': () => 'cc: not connected',
  closed: () => 'cc: tab closed',
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
 *   view — isOpen, reveal, load, showMessage, setDocument, whenReady, request
 *   sync — chipSync's enable, disable, pushNow
 */
function createConnection({ vscode, workspaceState, getServerUrl, view, sync }) {
  const bar = vscode.window.createStatusBarItem();
  bar.command = 'codeConductor.open';
  let state = null;
  let busy = false;
  let connectedLabel = null;
  // Bumped when the tab closes; a connect/resume that started earlier abandons its remaining steps.
  let closeGeneration = 0;

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
      // A tab closed mid-connect is the user's doing, not an unreachable cc.
      if (!view.isOpen()) return false;
      notRunning({ kind: 'error', code: 'RELAY_TIMEOUT' }, 'cc is not reachable from the tab.');
      vscode.window.showErrorMessage(
        `cc: the cc tab could not reach ${ep.serverUrl}. Check that cc is running there, that the code-vscode plugin is enabled in cc (Settings → Plugins; a disabled plugin answers 404), `
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
      view.reveal();
      const gen = closeGeneration;
      const stale = () => gen !== closeGeneration;
      const ep = await endpoints();
      if (stale()) return;
      view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl });
      if (!(await relayReady(ep)) || stale()) return;

      const list = await view.request({ op: 'listConductors' });
      if (stale()) return;
      if (!list.ok) {
        vscode.window.showErrorMessage(`cc: could not list conductors (${list.code}: ${list.error ?? ''}).`);
        return;
      }
      const items = [
        ...list.value.map((c) => ({ label: c.displayLabel, description: c.status, sessionId: c.sessionId })),
        { label: NEW_CONDUCTOR_LABEL, isNew: true },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose the conductor to show' });
      if (!pick || stale()) return;

      let sid = pick.sessionId;
      let label = pick.label;
      if (pick.isNew) {
        const made = await view.request({ op: 'newConductor' });
        if (stale()) return;
        if (!made.ok) {
          vscode.window.showErrorMessage(`cc: could not start a conductor (${made.code}: ${made.error ?? ''}).`);
          return;
        }
        sid = made.value.sessionId;
        label = 'New conductor';
      }
      await workspaceState.update(SESSION_KEY, sid);
      if (stale()) return;
      view.setDocument(ep.documentUrl(sid));
      showConnected(label);
    } finally { busy = false; }
  }

  /** The tab opened (new or restored): reconnect to the stored session, or show the not-connected page. */
  async function resume() {
    const sid = workspaceState.get(SESSION_KEY);
    if (!sid) {
      notRunning({ kind: 'not-connected' }, 'Not connected to a cc session.');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const gen = closeGeneration;
      const stale = () => gen !== closeGeneration;
      const ep = await endpoints();
      if (stale()) return;
      view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl, documentUrl: ep.documentUrl(sid) });
      if (!(await relayReady(ep)) || stale()) return;
      const label = await labelOf(sid);
      if (stale()) return;
      showConnected(label);
    } finally { busy = false; }
  }

  async function ended() {
    await workspaceState.update(SESSION_KEY, undefined);
    notRunning({ kind: 'ended' }, 'Session ended — run cc: Connect', (t) => vscode.window.showWarningMessage(`cc: ${t}`));
  }

  async function disconnect() {
    const sid = workspaceState.get(SESSION_KEY);
    sync.disable();
    // With the tab closed there is no relay to clear the chip through.
    if (sid && view.isOpen()) await view.request({ op: 'clearChip', sid });
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
    if (state.kind === 'ended' || state.kind === 'not-connected' || state.kind === 'closed') return;
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

  /** Window start: the bar shows the stored session's tab as closed, or not connected. */
  function init() {
    setState(workspaceState.get(SESSION_KEY) ? { kind: 'closed' } : { kind: 'not-connected' });
  }

  /** The command and status bar entry: reopen the stored session's tab, or choose one. */
  async function open() {
    if (workspaceState.get(SESSION_KEY)) view.reveal();
    else await connect();
  }

  /** The tab closed: syncing stops, the stored session stays for the next open. */
  function onClosed() {
    closeGeneration += 1;
    sync.disable();
    setState(workspaceState.get(SESSION_KEY) ? { kind: 'closed' } : { kind: 'not-connected' });
  }

  return { init, open, onClosed, connect, disconnect, resume, onRelayReady, sendChip, onChipResult, dispose() { bar.dispose(); } };
}

module.exports = { SESSION_KEY, RELAY_READY_TIMEOUT_MS, createConnection };
