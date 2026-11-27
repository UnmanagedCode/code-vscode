'use strict';
// The cc tabs of a window: which exist, which session each shows, the picker that opens or reveals them,
// the chip fan-out to the visible ones, and the status bar.

const { createPanel, createTabView } = require('./view');
const { createTab } = require('./tab');
const { createChipWriter } = require('./chipWriter');
const { endpoints } = require('./endpoints');
const { pickerItems, pickConductor } = require('./picker');

const STATUS_TEXT = {
  connecting: () => 'cc: connecting',
  connected: (tab) => `cc: ${tab.label}`,
  unbound: () => 'cc: no conductor',
  'view-only': () => 'cc: view-only (no chip)',
  ended: () => 'cc: session ended',
  error: (tab) => `cc: ${tab.state.code}`,
};

/**
 * deps:
 *   vscode — window.createWebviewPanel / showQuickPick / showErrorMessage / createStatusBarItem and the tabs' own needs
 *   extensionUri, randomBytes(n)
 *   getServerUrl() — the codeConductor.serverUrl setting
 *   source — chipSync's refresh() and latestShown(column)
 *   takeLegacySessionId() — migrations: the session of the pre-upgrade single tab, once
 */
function createTabs({ vscode, extensionUri, randomBytes, getServerUrl, source, takeLegacySessionId }) {
  const bar = vscode.window.createStatusBarItem();
  bar.command = 'codeConductor.open';
  // Every tab, in creation order; bySid holds the bound ones — at most one tab per session.
  const all = new Set();
  const bySid = new Map();
  let lastActive = null;
  let picking = false;

  function refreshBar() {
    bar.text = lastActive ? STATUS_TEXT[lastActive.state?.kind ?? 'unbound'](lastActive) : 'cc: no tab open';
    bar.show();
  }

  const reportFailure = (e) => vscode.window.showErrorMessage(`cc: ${e?.message ?? e}`);

  /** A visible tab gets the current chip, forced past the file-chip dedupe; a hidden one gets nothing by any path. */
  function pushTo(tab) {
    if (!tab.view.isVisible()) return;
    const chip = source.refresh();
    if (chip) tab.writer.offer(chip, { force: true });
  }

  /** A tab shown again gets the chip it missed, when the editor that produced it is still visible beside it. */
  function catchUp(tab) {
    if (!tab.sid) return;
    const chip = source.latestShown(tab.view.viewColumn());
    if (chip && !tab.writer.has(chip.seq)) tab.writer.offer(chip); // not forced: the file-key dedupe keeps a × on a file chip
  }

  function adopt(panel) {
    const view = createTabView({ vscode, extensionUri, randomBytes, panel });
    let tab;
    const writer = createChipWriter({
      send: (message) => (tab.sid ? view.request({ ...message, sid: tab.sid }) : Promise.resolve({ ok: false, code: 'SESSION_NOT_LIVE' })),
      onResult: (result) => tab.onChipResult(result),
    });
    tab = createTab({
      vscode, view, writer,
      endpoints: () => endpoints({ vscode, getServerUrl }),
      onState: refreshBar,
      onUnbound: (t, sid) => { if (bySid.get(sid) === t) bySid.delete(sid); },
      pushTo,
    });
    all.add(tab);
    if (panel.active) lastActive = tab;
    view.on('ready', () => tab.onRelayReady());
    view.on('connect', () => { void open({ target: tab }); });
    let shown = view.isVisible();
    view.on('viewState', ({ active, visible }) => {
      if (active) { lastActive = tab; refreshBar(); }
      const becameVisible = visible && !shown;
      shown = visible;
      if (becameVisible) catchUp(tab);
    });
    view.on('close', () => {
      tab.dispose();
      all.delete(tab);
      for (const [sid, t] of bySid) if (t === tab) bySid.delete(sid);
      if (lastActive === tab) lastActive = [...all].at(-1) ?? null;
      refreshBar();
    });
    refreshBar();
    return tab;
  }

  /** Binds an unbound tab whose relay is loaded. A session that already has a tab reveals that tab instead. */
  async function bindTab(tab, sid, label) {
    const existing = bySid.get(sid);
    if (existing && existing !== tab) { existing.view.reveal(); return; }
    bySid.set(sid, tab);
    await tab.bind(sid, label);
  }

  /** A new tab beside the editor, created bound to `sid`. */
  async function openNew(sid, label) {
    const tab = adopt(createPanel(vscode, extensionUri));
    bySid.set(sid, tab);
    await tab.start(sid, label);
  }

  const readyTabs = () => [...all].filter((t) => t.hasRelay());

  function pickHost() {
    const ready = readyTabs();
    return (lastActive && ready.includes(lastActive) ? lastActive : ready.at(-1)) ?? null;
  }

  /**
   * The picker: lists conductors through a ready tab's relay (the one given as `target`, else the last-active, else any,
   * else a new one) and opens, reveals or rebinds a tab for the pick.
   */
  async function open({ target = null } = {}) {
    if (picking) return;
    picking = true;
    let host = target ?? pickHost();
    const transient = !host;
    try {
      if (transient) host = adopt(createPanel(vscode, extensionUri));
      const done = () => {
        if (transient) host.view.dispose();
        else host.showNotice();
      };
      if (!host.hasRelay() && !(await host.loadRelay())) { if (transient && !host.view.isDisposed()) host.view.dispose(); return; }

      const list = await host.view.request({ op: 'listConductors' });
      if (host.view.isDisposed()) return;
      if (!list.ok) {
        vscode.window.showErrorMessage(`cc: could not list conductors (${list.code}: ${list.error ?? ''}).`);
        done();
        return;
      }
      const pick = await pickConductor(vscode, pickerItems(list.value, [...bySid].map(([sid, t]) => ({ sid, label: t.label ?? sid.slice(0, 8) }))));
      if (host.view.isDisposed()) return;
      if (!pick) { done(); return; }

      let sid = pick.sessionId;
      let label = pick.label;
      if (pick.isNew) {
        const made = await host.view.request({ op: 'newConductor' });
        if (host.view.isDisposed()) return;
        if (!made.ok) {
          vscode.window.showErrorMessage(`cc: could not start a conductor (${made.code}: ${made.error ?? ''}).`);
          done();
          return;
        }
        sid = made.value.sessionId;
        label = 'New conductor';
      }
      const existing = bySid.get(sid);
      if (existing) {
        existing.view.reveal();
        if (existing !== host) done();
      } else if (!host.sid) {
        await bindTab(host, sid, label);
      } else {
        await openNew(sid, label);
      }
    } catch (e) {
      reportFailure(e);
      // A transient host that never got a session would be a blank tab.
      if (transient && host && !host.sid && !host.view.isDisposed()) host.view.dispose();
    } finally { picking = false; }
  }

  refreshBar();

  return {
    open,
    /** Chips go to bound tabs that are visible right now; a hidden tab catches up when shown (see catchUp). */
    onChip(chip) {
      for (const tab of all) if (tab.sid && tab.view.isVisible()) tab.writer.offer(chip);
    },
    /** Registered for VIEW_TYPE so a window reload restores each tab with the session its panel state names. */
    serializer: {
      async deserializeWebviewPanel(panel, state) {
        let sid = state?.sessionId ?? null;
        if (sid && bySid.has(sid)) { panel.dispose(); return; }
        const tab = adopt(panel);
        // A panel with no state of its own (no sessionId key at all; an unbound or ended tab persists null) is the single
        // tab of the pre-upgrade extension: its session is in workspaceState.
        if (!sid && !(state && 'sessionId' in state)) sid = (await takeLegacySessionId()) ?? null;
        if (sid && !bySid.has(sid)) {
          bySid.set(sid, tab);
          tab.start(sid).catch(reportFailure);
        } else {
          tab.unbind('none');
        }
      },
    },
    dispose() { bar.dispose(); },
  };
}

module.exports = { createTabs };
