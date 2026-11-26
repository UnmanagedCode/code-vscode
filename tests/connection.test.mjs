import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createConnection, SESSION_KEY } = createRequire(import.meta.url)('../extension/src/connection.js');

function setup({ serverUrl = 'http://127.0.0.1:8787', external = serverUrl, stored, conductors = [], pick, readyFails = false, handlers = {} } = {}) {
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
    env: { asExternalUri: async (uri) => ({ toString: () => external, uri }) },
    Uri: { parse: (s) => s },
  };
  const view = {
    reveal: async () => log.view.push(['reveal']),
    load: (a) => log.view.push(['load', a]),
    showMessage: (t) => log.view.push(['message', t]),
    setDocument: (u) => log.view.push(['document', u]),
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
  const workspaceState = { get: (k) => store.get(k), update: async (k, v) => { if (v === undefined) store.delete(k); else store.set(k, v); } };
  const conn = createConnection({ vscode, workspaceState, getServerUrl: () => serverUrl, view, sync });
  return { conn, log, store, bar };
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
