import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTab, RELAY_READY_TIMEOUT_MS } = require('../extension/src/tab.js');
const { endpoints } = require('../extension/src/endpoints.js');

function setup({ serverUrl = 'http://127.0.0.1:8787', external = serverUrl, conductors = [], readyFails = false, readyGate = null } = {}) {
  const log = { view: [], messages: [], writer: [], pushes: 0, states: 0, unbound: [] };
  const vscode = {
    window: {
      showErrorMessage: (m) => log.messages.push(['error', m]),
      showWarningMessage: (m) => log.messages.push(['warning', m]),
      showInformationMessage: (m) => log.messages.push(['info', m]),
    },
    env: { asExternalUri: async () => ({ toString: () => external }) },
    Uri: { parse: (s) => s },
  };
  let disposed = false;
  const view = {
    isDisposed: () => disposed,
    isVisible: () => true,
    load: (a) => log.view.push(['load', a]),
    showMessage: (t, sid) => log.view.push(['message', t, sid]),
    setDocument: (u, sid) => log.view.push(['document', u, sid]),
    setTitle: (t) => log.view.push(['title', t]),
    whenReady: (ms) => { log.view.push(['whenReady', ms]); return readyGate ?? (readyFails ? Promise.reject(new Error('timeout')) : Promise.resolve()); },
    request: async (msg) => (msg.op === 'listConductors' ? { ok: true, value: conductors } : { ok: true }),
  };
  const writer = { enable: () => log.writer.push('enable'), disable: () => log.writer.push('disable'), dispose: () => log.writer.push('dispose') };
  const tab = createTab({
    vscode, view, writer,
    endpoints: () => endpoints({ vscode, getServerUrl: () => serverUrl }),
    onState: () => { log.states += 1; },
    onUnbound: (t, sid) => log.unbound.push(sid),
    pushTo: () => { log.pushes += 1; },
  });
  return { tab, log, close: () => { disposed = true; } };
}

const live = [{ sessionId: 's1', displayLabel: 'Refactor auth', status: 'idle' }, { sessionId: 's2', displayLabel: 'Fix build', status: 'busy' }];

test('start loads relay and document for the sid, labels from listConductors, enables the writer and pushes', async () => {
  const t = setup({ conductors: live });
  await t.tab.start('s2');
  const load = t.log.view.find((v) => v[0] === 'load')[1];
  assert.equal(load.documentUrl, 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s2');
  assert.equal(load.sessionId, 's2');
  assert.equal(t.tab.sid, 's2');
  assert.deepEqual([t.tab.state.kind, t.tab.label], ['connected', 'Fix build']);
  assert.ok(t.log.writer.includes('enable'));
  assert.equal(t.log.pushes, 1);
});

test('start labels an unlisted session with its sid prefix', async () => {
  const t = setup({ conductors: [] });
  await t.tab.start('abcdef0123456789');
  assert.equal(t.tab.label, 'abcdef01');
});

test('a connected tab\'s title carries its label', async () => {
  const t = setup({ conductors: live });
  await t.tab.start('s1');
  assert.deepEqual(t.log.view.filter((v) => v[0] === 'title').at(-1), ['title', 'cc: Refactor auth']);
});

test('bind uses the already loaded relay: shows the document for the sid and connects with the given label', async () => {
  const t = setup();
  await t.tab.bind('s9', 'New conductor');
  assert.equal(t.log.view.some((v) => v[0] === 'load'), false);
  assert.deepEqual(t.log.view.find((v) => v[0] === 'document'), ['document', 'http://127.0.0.1:8787/plugins/code-vscode/?focus=s9', 's9']);
  assert.equal(t.tab.state.kind, 'connected');
  assert.equal(t.log.pushes, 1);
});

test('a relay that never reports ready gives RELAY_TIMEOUT naming the URL', async () => {
  const t = setup({ serverUrl: 'http://10.0.0.5:8787', readyFails: true });
  await t.tab.start('s1');
  const [kind, text] = t.log.messages[0];
  assert.equal(kind, 'error');
  assert.ok(text.includes('http://10.0.0.5:8787'));
  assert.deepEqual([t.tab.state.kind, t.tab.state.code], ['error', 'RELAY_TIMEOUT']);
  assert.ok(t.log.view.some((v) => v[0] === 'whenReady' && v[1] === RELAY_READY_TIMEOUT_MS));
  assert.equal(t.log.pushes, 0);
});

test('relay URLs join onto the external URL, with and without a base path', async () => {
  const root = setup({ external: 'http://127.0.0.1:50001' });
  await root.tab.start('s1');
  const l = root.log.view.find((v) => v[0] === 'load')[1];
  assert.deepEqual([l.ccOrigin, l.relayUrl], ['http://127.0.0.1:50001', 'http://127.0.0.1:50001/plugins/code-vscode/relay']);
  const based = setup({ external: 'https://host.example/cc' });
  await based.tab.start('s1');
  const b = based.log.view.find((v) => v[0] === 'load')[1];
  assert.deepEqual([b.ccOrigin, b.relayUrl, b.documentUrl], ['https://host.example', 'https://host.example/cc/plugins/code-vscode/relay', 'https://host.example/cc/plugins/code-vscode/?focus=s1']);
});

test('SESSION_NOT_LIVE unbinds the tab: writer disabled, ended page shown, sid released, warning names the label', async () => {
  const t = setup({ conductors: live });
  await t.tab.start('s1');
  await t.tab.onChipResult({ ok: false, code: 'SESSION_NOT_LIVE' });
  assert.equal(t.tab.sid, null);
  assert.equal(t.tab.state.kind, 'ended');
  assert.deepEqual(t.log.unbound, ['s1']);
  assert.equal(t.log.writer.at(-1), 'disable');
  const page = t.log.view.filter((v) => v[0] === 'message').at(-1);
  assert.match(page[1], /Session ended/);
  assert.equal(page[2] ?? null, null);
  assert.match(t.log.messages.at(-1)[1], /Refactor auth/);
  // further results of an ended tab change nothing
  const n = t.log.messages.length;
  await t.tab.onChipResult({ ok: false, code: 'REQUEST_FAILED' });
  assert.equal(t.log.messages.length, n);
});

test('VIEW_ONLY notifies once per state change, prefixed with the label; success returns to connected', async () => {
  const t = setup({ conductors: live });
  await t.tab.start('s1');
  await t.tab.onChipResult({ ok: false, code: 'VIEW_ONLY' });
  await t.tab.onChipResult({ ok: false, code: 'VIEW_ONLY' });
  assert.equal(t.tab.state.kind, 'view-only');
  assert.equal(t.log.messages.length, 1);
  assert.match(t.log.messages[0][1], /Refactor auth/);
  await t.tab.onChipResult({ ok: true });
  assert.equal(t.tab.state.kind, 'connected');
});

test('a tab closed mid-start abandons its remaining steps', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup({ conductors: live, readyGate: gate });
  const started = t.tab.start('s1');
  await new Promise((r) => setImmediate(r));
  t.tab.dispose();
  t.close();
  release();
  await started;
  assert.equal(t.log.writer.includes('enable'), false);
  assert.equal(t.log.pushes, 0);
  assert.notEqual(t.tab.state?.kind, 'connected');
});

test('relay ready while connected pushes; while not connected it does not', async () => {
  const t = setup();
  t.tab.onRelayReady();
  assert.equal(t.log.pushes, 0);
  await t.tab.start('s1');
  const n = t.log.pushes;
  t.tab.onRelayReady();
  assert.equal(t.log.pushes, n + 1);
});

test('a chip result that arrives after the tab closed notifies nothing and changes no state', async () => {
  const t = setup({ conductors: live });
  await t.tab.start('s1');
  t.tab.dispose();
  t.close();
  const states = t.log.states;
  const shown = t.log.view.length;
  for (const code of ['REQUEST_FAILED', 'SESSION_NOT_LIVE', 'VIEW_ONLY']) await t.tab.onChipResult({ ok: false, code });
  assert.equal(t.log.messages.length, 0);
  assert.equal(t.log.states, states);
  assert.equal(t.log.view.length, shown);
  assert.equal(t.tab.state.kind, 'connected');
  assert.deepEqual(t.log.unbound, []);
});
