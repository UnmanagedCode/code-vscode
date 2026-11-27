import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createConnection, SESSION_KEY } = createRequire(import.meta.url)('../extension/src/connection.js');

function setup({ serverUrl = 'http://127.0.0.1:8787', external = serverUrl, stored, conductors = [], pick, readyFails = false, handlers = {}, open = true, externalGate = null, updateGate = null, wireResolve = false } = {}) {
  const store = new Map(stored ? [[SESSION_KEY, stored]] : []);
  const log = { view: [], sync: [], messages: [], requests: [], picks: [] };
  const bar = { text: '', show() {}, dispose() {} };
  const vscode = {
    window: {
      createStatusBarItem: () => bar,
      showQuickPick: async (items) => { log.picks.push(items); return typeof pick === 'function' ? pick(items) : pick; },
      showErrorMessage: (m) => log.messages.push(['error', m]),
      showWarningMessage: (m) => log.messages.push(['warning', m]),
      showInformationMessage: (m) => log.messages.push(['info', m]),
    },
    env: { asExternalUri: async (uri) => { if (externalGate) await externalGate; return { toString: () => external, uri }; } },
    Uri: { parse: (s) => s },
  };
  const tab = { open };
  const view = {
    isOpen: () => tab.open,
    // As in extension.js, adopting a new panel emits `resolve` into resume().
    reveal: () => {
      const created = !tab.open;
      tab.open = true;
      log.view.push(['reveal']);
      if (created && wireResolve) void conn.resume();
    },
    // Like the real view, which throws without a panel.
    load: (a) => { if (!tab.open) throw new Error('the cc tab is not open'); log.view.push(['load', a]); },
    showMessage: (t) => log.view.push(['message', t]),
    setDocument: (u) => { if (!tab.open) throw new Error('the cc tab is not open'); log.view.push(['document', u]); },
    whenReady: () => (readyFails ? Promise.reject(new Error('timeout')) : Promise.resolve()),
    request: async (msg) => {
      log.requests.push(msg);
      if (handlers[msg.op]) return handlers[msg.op](msg);
      if (msg.op === 'listConductors') return { ok: true, value: conductors };
      if (msg.op === 'newConductor') return { ok: true, value: { sessionId: 'new-sid' } };
      return { ok: true };
    },
  };
  const sync = { enable: () => log.sync.push('enable'), disable: () => log.sync.push('disable'), pushNow: () => log.sync.push('pushNow') };
  const workspaceState = { get: (k) => store.get(k), update: async (k, v) => { if (updateGate) await updateGate; if (v === undefined) store.delete(k); else store.set(k, v); } };
  const conn = createConnection({ vscode, workspaceState, getServerUrl: () => serverUrl, view, sync });
  return { conn, log, store, bar, tab };
}

const live = [{ sessionId: 's1', displayLabel: 'Refactor auth', status: 'idle' }, { sessionId: 's2', displayLabel: 'Fix build', status: 'busy' }];

test('connect offers each live conductor and New conductor, stores the choice, and opens it focused', async () => {
  const t = setup({ conductors: live, pick: (items) => items[1] });
  await t.conn.connect();
  assert.deepEqual(t.log.picks[0].map((i) => i.label), ['Refactor auth', 'Fix build', '$(add) New conductor']);
  assert.equal(t.store.get(SESSION_KEY), 's2');
  assert.deepEqual(t.log.view.find((v) => v[0] === 'document'), ['document', 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s2']);
  assert.equal(t.bar.text, 'cc: Fix build');
  assert.ok(t.log.sync.includes('enable') && t.log.sync.at(-1) === 'pushNow');
});

test('with no conductors the picker offers only New conductor, which starts one and connects to it', async () => {
  const t = setup({ conductors: [], pick: (items) => items[0] });
  await t.conn.connect();
  assert.equal(t.log.picks[0].length, 1);
  assert.ok(t.log.requests.some((r) => r.op === 'newConductor'));
  assert.equal(t.store.get(SESSION_KEY), 'new-sid');
});

test('cancelling the picker connects nothing', async () => {
  const t = setup({ conductors: live, pick: undefined });
  await t.conn.connect();
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.log.view.some((v) => v[0] === 'document'), false);
  assert.equal(t.log.sync.includes('enable'), false);
});

test('a failed conductor start reports an error and stores nothing', async () => {
  const t = setup({ conductors: [], pick: (i) => i[0], handlers: { newConductor: () => ({ ok: false, code: 'HOST_ERROR', error: 'nope' }) } });
  await t.conn.connect();
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.log.messages[0][0], 'error');
});

test('relay URLs join onto the external URL, with and without a base path', async () => {
  const root = setup({ conductors: live, pick: (i) => i[0], external: 'http://127.0.0.1:50001' });
  await root.conn.connect();
  assert.deepEqual(root.log.view.find((v) => v[0] === 'load')[1], { ccOrigin: 'http://127.0.0.1:50001', relayUrl: 'http://127.0.0.1:50001/plugins/code-vscode/relay' });
  const based = setup({ conductors: live, pick: (i) => i[0], external: 'https://host.example/cc' });
  await based.conn.connect();
  assert.deepEqual(based.log.view.find((v) => v[0] === 'load')[1], { ccOrigin: 'https://host.example', relayUrl: 'https://host.example/cc/plugins/code-vscode/relay' });
  assert.equal(based.log.view.find((v) => v[0] === 'document')[1], 'https://host.example/cc/plugins/code-vscode/?focus=s1');
});

test('a relay that never reports ready gives an error naming the URL and no session is stored', async () => {
  const t = setup({ serverUrl: 'http://10.0.0.5:8787', readyFails: true, conductors: live, pick: (i) => i[0] });
  await t.conn.connect();
  const [kind, text] = t.log.messages[0];
  assert.equal(kind, 'error');
  assert.ok(text.includes('http://10.0.0.5:8787'));
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.bar.text, 'cc: RELAY_TIMEOUT');
});

test('a stored session reconnects without a picker, showing its label', async () => {
  const t = setup({ stored: 's2', conductors: live });
  await t.conn.resume();
  assert.equal(t.log.picks.length, 0);
  const load = t.log.view.find((v) => v[0] === 'load')[1];
  assert.equal(load.documentUrl, 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s2');
  assert.equal(t.bar.text, 'cc: Fix build');
  assert.ok(t.log.sync.includes('enable'));
});

test('with no stored session, resume shows the not-connected page', async () => {
  const t = setup();
  await t.conn.resume();
  assert.equal(t.bar.text, 'cc: not connected');
  assert.ok(t.log.view.some((v) => v[0] === 'message'));
  assert.equal(t.log.view.some((v) => v[0] === 'load'), false);
});

test('a stored session absent from the list (a pristine conductor) still reconnects; only SESSION_NOT_LIVE ends it', async () => {
  const t = setup({ stored: 'abcdefghijkl', conductors: live });
  await t.conn.resume();
  assert.equal(t.store.get(SESSION_KEY), 'abcdefghijkl');
  assert.equal(t.bar.text, 'cc: abcdefgh');
  assert.ok(t.log.sync.includes('enable'));
});

test('SESSION_NOT_LIVE on a chip write clears the stored id, stops syncing and tells the user once', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.resume();
  await t.conn.onChipResult({ ok: false, code: 'SESSION_NOT_LIVE' });
  await t.conn.onChipResult({ ok: false, code: 'SESSION_NOT_LIVE' });
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.bar.text, 'cc: session ended');
  assert.equal(t.log.sync.at(-1), 'disable');
  assert.equal(t.log.messages.filter(([k]) => k === 'warning').length, 1);
  assert.ok(t.log.view.some((v) => v[0] === 'message' && /Session ended — run cc: Connect/.test(v[1])));
});

test('VIEW_ONLY and other failures change the status once per state change, and success restores it', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.resume();
  for (let i = 0; i < 3; i++) await t.conn.onChipResult({ ok: false, code: 'VIEW_ONLY' });
  assert.equal(t.bar.text, 'cc: view-only (no chip)');
  assert.equal(t.log.messages.length, 1);
  for (let i = 0; i < 3; i++) await t.conn.onChipResult({ ok: false, code: 'REQUEST_FAILED' });
  assert.equal(t.bar.text, 'cc: REQUEST_FAILED');
  assert.equal(t.log.messages.length, 2);
  await t.conn.onChipResult({ ok: true });
  assert.equal(t.bar.text, 'cc: Refactor auth');
  assert.equal(t.log.messages.length, 2);
});

test('disconnect clears the chip on the session, forgets it and stops syncing', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.resume();
  await t.conn.disconnect();
  assert.deepEqual(t.log.requests.find((r) => r.op === 'clearChip'), { op: 'clearChip', sid: 's1' });
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.log.sync.at(-1), 'disable');
  assert.equal(t.bar.text, 'cc: not connected');
});

test('chip writes are addressed to the stored session; with none they report SESSION_NOT_LIVE', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.sendChip({ op: 'setChip', title: 't', data: 'd' });
  assert.deepEqual(t.log.requests.at(-1), { op: 'setChip', title: 't', data: 'd', sid: 's1' });
  const none = setup();
  assert.equal((await none.conn.sendChip({ op: 'clearChip' })).code, 'SESSION_NOT_LIVE');
});

test('a relay (re)load while connected pushes the current chip; while not connected it does not', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.resume();
  t.log.sync.length = 0;
  t.conn.onRelayReady();
  assert.deepEqual(t.log.sync, ['pushNow']);
  const off = setup();
  await off.conn.resume();
  off.log.sync.length = 0;
  off.conn.onRelayReady();
  assert.deepEqual(off.log.sync, []);
});

test('init shows the tab as closed when a session is stored, not connected otherwise', () => {
  const stored = setup({ stored: 's1' });
  stored.conn.init();
  assert.equal(stored.bar.text, 'cc: tab closed');
  const none = setup();
  none.conn.init();
  assert.equal(none.bar.text, 'cc: not connected');
});

test('the status bar item opens the tab', () => {
  const t = setup();
  assert.equal(t.bar.command, 'codeConductor.open');
});

test('open with a stored session reveals the tab with no picker and no new conductor', async () => {
  const t = setup({ stored: 's1', conductors: live, open: false });
  await t.conn.open();
  assert.deepEqual(t.log.view, [['reveal']]);
  assert.equal(t.log.picks.length, 0);
  assert.ok(!t.log.requests.some((r) => r.op === 'newConductor'));
});

test('open with no stored session runs the picker', async () => {
  const t = setup({ conductors: live, pick: (i) => i[0] });
  await t.conn.open();
  assert.equal(t.log.picks.length, 1);
  assert.equal(t.store.get(SESSION_KEY), 's1');
});

test('closing the tab while connected stops syncing, keeps the session, and later failed chip results change nothing', async () => {
  const t = setup({ stored: 's1', conductors: live });
  await t.conn.resume();
  const before = t.log.messages.length;
  t.tab.open = false;
  t.conn.onClosed();
  assert.equal(t.log.sync.at(-1), 'disable');
  assert.equal(t.store.get(SESSION_KEY), 's1');
  assert.equal(t.bar.text, 'cc: tab closed');
  await t.conn.onChipResult({ ok: false, code: 'REQUEST_FAILED' });
  assert.equal(t.bar.text, 'cc: tab closed');
  assert.equal(t.log.messages.length, before);
});

test('reopening after a close reconnects to the stored session without a picker and pushes the chip', async () => {
  const t = setup({ stored: 's2', conductors: live });
  await t.conn.resume();
  t.conn.onClosed();
  t.log.view.length = 0;
  t.log.sync.length = 0;
  await t.conn.resume();
  assert.equal(t.log.picks.length, 0);
  assert.equal(t.log.view.find((v) => v[0] === 'load')[1].documentUrl, 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s2');
  assert.equal(t.log.sync.at(-1), 'pushNow');
  assert.equal(t.bar.text, 'cc: Fix build');
});

test('a relay timeout after the tab closed mid-connect shows no error', async () => {
  const t = setup({ readyFails: true, conductors: live, pick: (i) => i[0], open: false });
  const done = t.conn.connect();
  t.tab.open = false;
  t.conn.onClosed();
  await done;
  assert.equal(t.log.messages.length, 0);
  assert.notEqual(t.bar.text, 'cc: RELAY_TIMEOUT');
});

test('disconnect with the tab closed forgets the session and sends no request', async () => {
  const t = setup({ stored: 's1', open: false });
  await t.conn.disconnect();
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.log.requests.length, 0);
  assert.equal(t.bar.text, 'cc: not connected');
});

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise((r) => setImmediate(r));

test('a close during connect\'s listConductors leaves the bar closed with no message and no document', async () => {
  const gate = deferred();
  const t = setup({ stored: 's1', pick: (i) => i[0], handlers: { listConductors: () => gate.promise } });
  const done = t.conn.connect();
  await settle();
  t.tab.open = false;
  t.conn.onClosed();
  gate.resolve({ ok: false, code: 'REQUEST_FAILED', error: 'closed' });
  await done;
  assert.equal(t.bar.text, 'cc: tab closed');
  assert.equal(t.log.messages.length, 0);
  assert.equal(t.log.picks.length, 0);
});

test('a close during connect\'s newConductor shows no error and stores nothing', async () => {
  const gate = deferred();
  const t = setup({ conductors: [], pick: (i) => i[0], handlers: { newConductor: () => gate.promise } });
  const done = t.conn.connect();
  await settle();
  t.tab.open = false;
  t.conn.onClosed();
  gate.resolve({ ok: false, code: 'REQUEST_FAILED', error: 'closed' });
  await done;
  assert.equal(t.log.messages.length, 0);
  assert.equal(t.store.has(SESSION_KEY), false);
});

test('a close during resume\'s label lookup leaves sync disabled and the bar closed', async () => {
  const gate = deferred();
  const t = setup({ stored: 's1', handlers: { listConductors: () => gate.promise } });
  const done = t.conn.resume();
  await settle();
  t.tab.open = false;
  t.conn.onClosed();
  gate.resolve({ ok: true, value: live });
  await done;
  assert.equal(t.bar.text, 'cc: tab closed');
  assert.ok(!t.log.sync.includes('enable'));
  assert.ok(!t.log.sync.includes('pushNow'));
  assert.equal(t.log.sync.at(-1), 'disable');
});

test('a close during endpoints leaves no rejection from resume or connect', async () => {
  for (const run of ['resume', 'connect']) {
    const gate = deferred();
    const t = setup({ stored: 's1', conductors: live, pick: (i) => i[0], externalGate: gate.promise });
    const done = t.conn[run]();
    await settle();
    t.tab.open = false;
    t.conn.onClosed();
    gate.resolve();
    await done;
    assert.equal(t.log.view.some((v) => v[0] === 'load'), false, run);
    assert.equal(t.bar.text, 'cc: tab closed', run);
  }
});

test('a close during connect\'s session store leaves no rejection and no document', async () => {
  const gate = deferred();
  const t = setup({ conductors: live, pick: (i) => i[0], updateGate: gate.promise });
  const done = t.conn.connect();
  await settle(); await settle();
  t.tab.open = false;
  t.conn.onClosed();
  gate.resolve();
  await done;
  assert.equal(t.log.view.some((v) => v[0] === 'document'), false);
  assert.ok(!t.log.sync.includes('enable'));
});

test('a reopen that arrives while a connect is still running is retried once that connect abandons', async () => {
  const picked = deferred();
  const t = setup({ stored: 's1', conductors: live, pick: () => picked.promise });
  const done = t.conn.connect();
  await settle();
  t.tab.open = false;
  t.conn.onClosed();
  t.tab.open = true; // cc: Open adopts a new panel; its resolve calls resume()
  await t.conn.resume();
  const loadsBefore = t.log.view.filter((v) => v[0] === 'load').length;
  picked.resolve({ label: 'x', sessionId: 's2' });
  await done;
  await settle(); await settle();
  assert.equal(t.log.view.filter((v) => v[0] === 'load').length, loadsBefore + 1);
  assert.equal(t.log.view.filter((v) => v[0] === 'load').at(-1)[1].documentUrl, 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s1');
  assert.equal(t.bar.text, 'cc: Refactor auth');
  assert.equal(t.store.get(SESSION_KEY), 's1');
});

test('connect opening the panel itself ignores the resolve its own reveal emits', async () => {
  const t = setup({ stored: 's1', open: false, wireResolve: true, conductors: live, pick: (items) => items[1] });
  await t.conn.connect();
  await settle(); await settle();
  assert.equal(t.log.view.filter((v) => v[0] === 'load').length, 1);
  assert.equal(t.log.sync.filter((e) => e === 'enable').length, 1);
  assert.equal(t.bar.text, 'cc: Fix build');
  assert.equal(t.store.get(SESSION_KEY), 's2');
});
