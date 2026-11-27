'use strict';
// One cc tab's session lifecycle: loading the relay and document for a session, the connected / view-only / ended /
// error states, and what a chip write's outcome does to them. Which tab exists and who gets chips is tabs.js's.

const RELAY_READY_TIMEOUT_MS = 15_000;

/**
 * deps:
 *   vscode — window.showErrorMessage / showWarningMessage / showInformationMessage
 *   view — this tab's createTabView
 *   writer — this tab's chip writer (enable, disable, dispose)
 *   endpoints() — async {serverUrl, ccOrigin, relayUrl, documentUrl(sid)}
 *   onState(tab) — the tab's state changed
 *   onUnbound(tab, sid) — the tab let go of `sid` (ended, or failed to connect)
 *   pushTo(tab) — bring the tab's chip up to date (forced; the registry skips hidden tabs)
 */
function createTab({ vscode, view, writer, endpoints, onState, onUnbound, pushTo }) {
  // Bumped when the tab closes; a start/bind/load that began earlier abandons its remaining steps.
  let generation = 0;
  let relay = false;
  // The page shown while no session is bound, and the session id the panel keeps in its state across a reload.
  let notice = null;
  let persistedSid = null;

  const tab = {
    view, writer, sid: null, state: null, label: null,
    hasRelay: () => relay && !view.isDisposed(),
  };

  function setState(next) {
    const changed = !tab.state || tab.state.kind !== next.kind || tab.state.code !== next.code;
    tab.state = next;
    onState(tab);
    return changed;
  }

  function release() {
    const old = tab.sid;
    tab.sid = null;
    writer.disable();
    if (old) onUnbound(tab, old);
  }

  // The connection failed: the panel keeps its session in its state, so a reload retries it.
  function fail(code, text, show) {
    persistedSid = tab.sid ?? persistedSid;
    release();
    relay = false;
    notice = text;
    setState({ kind: 'error', code });
    view.showMessage(text, persistedSid);
    if (show) show();
  }

  async function relayReady(ep) {
    try {
      await view.whenReady(RELAY_READY_TIMEOUT_MS);
      relay = true;
      return true;
    } catch {
      // A tab closed mid-connect is the user's doing, not an unreachable cc.
      if (view.isDisposed()) return false;
      fail('RELAY_TIMEOUT', 'cc is not reachable from the tab.', () => vscode.window.showErrorMessage(
        `cc: the cc tab could not reach ${ep.serverUrl}. Check that cc is running there, that the code-vscode plugin is enabled in cc (Settings → Plugins; a disabled plugin answers 404), `
        + 'that the URL is not plain http on a non-loopback address (blocked as mixed content), and that it needs no login.',
      ));
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
    tab.label = label;
    relay = true;
    notice = null;
    persistedSid = null;
    view.setTitle(`cc: ${label}`);
    setState({ kind: 'connected' });
    writer.enable();
    pushTo(tab);
  }

  Object.assign(tab, {
    /** Loads the relay and the document for `sid` into the panel, then connects (labelled from cc unless `label` is given). */
    async start(sid, label = null) {
      const g = generation;
      const stale = () => g !== generation || view.isDisposed();
      tab.sid = sid;
      setState({ kind: 'connecting' });
      try {
        const ep = await endpoints();
        if (stale()) return;
        view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl, documentUrl: ep.documentUrl(sid), sessionId: sid });
        relay = false;
        if (!(await relayReady(ep)) || stale()) return;
        const name = label ?? await labelOf(sid);
        if (stale()) return;
        showConnected(name);
      } catch (e) {
        if (!stale() && tab.sid === sid) fail('REQUEST_FAILED', 'Could not start the session.');
        throw e;
      }
    },

    /** Shows `sid` in a panel whose relay is already loaded, and connects. */
    async bind(sid, label) {
      const g = generation;
      tab.sid = sid;
      setState({ kind: 'connecting' });
      try {
        const ep = await endpoints();
        if (g !== generation || view.isDisposed()) return;
        view.setDocument(ep.documentUrl(sid), sid);
        showConnected(label);
      } catch (e) {
        if (g === generation && tab.sid === sid) fail('REQUEST_FAILED', 'Could not show the session.');
        throw e;
      }
    },

    /** Loads only the relay (no session), for the picker; resolves true once it is ready. */
    async loadRelay() {
      const g = generation;
      const ep = await endpoints();
      if (g !== generation || view.isDisposed()) return false;
      view.load({ ccOrigin: ep.ccOrigin, relayUrl: ep.relayUrl, sessionId: persistedSid });
      relay = false;
      return (await relayReady(ep)) && g === generation;
    },

    /** Lets go of the session: 'ended' (its conductor is gone) or 'none' (a panel that never had one). */
    unbind(kind) {
      const label = tab.label;
      persistedSid = null;
      release();
      relay = false;
      tab.label = null;
      view.setTitle('cc');
      if (kind === 'ended') {
        notice = 'Session ended.';
        setState({ kind: 'ended' });
        view.showMessage(notice);
        vscode.window.showWarningMessage(`cc: ${label ?? 'tab'}: session ended`);
      } else {
        notice = 'No conductor in this tab.';
        setState({ kind: 'unbound' });
        view.showMessage(notice);
      }
    },

    /** Shows the unbound page again (after the picker loaded the relay into it and ended without binding). */
    showNotice() {
      if (tab.sid || notice === null || view.isDisposed()) return;
      relay = false;
      view.showMessage(notice, persistedSid);
    },

    /** One chip write's outcome; the state changes and notifications only on a state change. */
    async onChipResult(result) {
      if (!tab.sid || tab.state?.kind === 'connecting') return;
      if (result.ok) {
        if (tab.state.kind !== 'connected') setState({ kind: 'connected' });
        return;
      }
      if (result.code === 'SESSION_NOT_LIVE') { tab.unbind('ended'); return; }
      if (result.code === 'VIEW_ONLY') {
        if (setState({ kind: 'view-only' })) vscode.window.showInformationMessage(`cc: ${tab.label}: cc runs with --ui view or interact, so this session takes no context chip.`);
        return;
      }
      if (setState({ kind: 'error', code: result.code })) vscode.window.showWarningMessage(`cc: ${tab.label}: chip update failed (${result.code}${result.error ? `: ${result.error}` : ''}).`);
    },

    /** The relay (re)loaded while connected: bring the chip up to date. */
    onRelayReady() {
      if (tab.state?.kind === 'connected' || tab.state?.kind === 'view-only') pushTo(tab);
    },

    dispose() { generation += 1; writer.dispose(); },
  });

  return tab;
}

module.exports = { RELAY_READY_TIMEOUT_MS, createTab };
