import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFakeVscode, settle } from './fakes/vscode.mjs';
const require = createRequire(import.meta.url);
const { createTabs } = require('../extension/src/tabs.js');
const { SESSION_KEY, takeLegacySessionId } = require('../extension/src/migrations.js');

const live = [{ sessionId: 's1', displayLabel: 'Refactor auth', status: 'idle' }, { sessionId: 's2', displayLabel: 'Fix build', status: 'busy' }];
const chip = { kind: 'selection', title: 'a.ts:1', data: 'x' };

function setup({ conductors = live, stored, current = null, relay, serverUrl } = {}) {
  const fake = createFakeVscode({ conductors, relay, serverUrl });
  const store = new Map(stored ? [[SESSION_KEY, stored]] : []);
  const workspaceState = { get: (k) => store.get(k), update: async (k, v) => { if (v === undefined) store.delete(k); else store.set(k, v); } };
  const source = { current, refresh: () => source.current };
  const tabs = createTabs({
    vscode: fake.vscode, extensionUri: 'ext', randomBytes: () => ({ toString: () => 'n' }),
    getServerUrl: () => fake.config.serverUrl, source,
    takeLegacySessionId: () => takeLegacySessionId(workspaceState),
  });
  const pickLabel = (label) => (items) => items.find((i) => i.label === label);
  const pickSid = (sid) => (items) => items.find((i) => i.sessionId === sid);
  const NEW = '$(add) New conductor';
  const writes = (sid) => fake.requests('setChip').filter((m) => !sid || m.sid === sid);
  return { fake, tabs, store, source, pickLabel, pickSid, NEW, writes };
}

async function openTwo(t) {
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  t.fake.pickScript.push(t.pickSid('s2'));
  await t.tabs.open();
}

test('picker lists live conductors, then open-but-unlisted tabs, then New conductor; open ones are marked', async () => {
  const t = setup({ conductors: live });
  t.fake.pickScript.push(t.pickLabel(t.NEW));
  await t.tabs.open();
  t.fake.pickScript.push(undefined);
  await t.tabs.open();
  const { items, options } = t.fake.quickPicks[1];
  assert.deepEqual(items.map((i) => i.label), ['Refactor auth', 'Fix build', 'New conductor', t.NEW]);
  assert.deepEqual(items.map((i) => i.description), ['idle', 'busy', 'open', undefined]);
  assert.ok(options.placeHolder);
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open(); // s1 opens in a second tab
  t.fake.pickScript.push(undefined);
  await t.tabs.open();
  assert.equal(t.fake.quickPicks[3].items[0].description, 'idle · open');
});

test('picking a session already in a tab reveals it and creates no panel', async () => {
  const t = setup();
  t.fake.pickScript.push(t.pickLabel(t.NEW));
  await t.tabs.open();
  assert.equal(t.fake.panels.length, 1);
  t.fake.pickScript.push((items) => items.find((i) => i.sessionId === 'new-sid'));
  await t.tabs.open();
  assert.equal(t.fake.panels.length, 1);
  assert.equal(t.fake.panels[0].revealed, 1);
});

test('picking an unopened session with a ready tab open creates a new tab bound to it', async () => {
  const t = setup();
  await openTwo(t);
  assert.equal(t.fake.panels.length, 2);
  assert.match(t.fake.panels[1].webview.html, /focus=s2/);
  assert.match(t.fake.panels[1].webview.html, /data-session-id="s2"/);
  assert.equal(t.fake.panels[1].title, 'cc: Fix build');
  assert.equal(t.fake.panels[0].disposed, false);
});

test('with no tab open, the picker runs on a new tab that the pick binds; cancel disposes it', async () => {
  const t = setup();
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  assert.equal(t.fake.panels.length, 1);
  assert.equal(t.fake.panels[0].disposed, false);
  assert.ok(t.fake.panels[0].webview.posted.some((m) => m.type === 'showDocument' && m.sessionId === 's1'));

  const u = setup();
  u.fake.pickScript.push(undefined);
  await u.tabs.open();
  assert.equal(u.fake.panels.length, 1);
  assert.equal(u.fake.panels[0].disposed, true);
  assert.equal(u.fake.statusBars[0].text, 'cc: no tab open');
});

test('New conductor starts one through the host relay and binds a tab to it; a failed start disposes a transient host', async () => {
  const t = setup();
  t.fake.pickScript.push(t.pickLabel(t.NEW));
  await t.tabs.open();
  assert.equal(t.fake.requests('newConductor').length, 1);
  assert.ok(t.fake.panels[0].webview.posted.some((m) => m.type === 'showDocument' && m.sessionId === 'new-sid'));
  assert.equal(t.fake.panels[0].title, 'cc: New conductor');

  const u = setup({ relay: (m) => (m.op === 'newConductor' ? { ok: false, code: 'HOST_ERROR', error: 'nope' } : null) });
  u.fake.pickScript.push(u.pickLabel(u.NEW));
  await u.tabs.open();
  assert.equal(u.fake.panels[0].disposed, true);
  assert.equal(u.fake.messages[0][0], 'error');
});

test('a failed list reports an error and disposes a transient host', async () => {
  const t = setup({ relay: (m) => (m.op === 'listConductors' ? { ok: false, code: 'REQUEST_FAILED', error: 'x' } : null) });
  await t.tabs.open();
  assert.equal(t.fake.messages[0][0], 'error');
  assert.equal(t.fake.panels[0].disposed, true);
  assert.equal(t.fake.quickPicks.length, 0);
});

test('a second open while the picker is showing is ignored', async () => {
  const t = setup();
  let release;
  t.fake.pickScript.push(() => new Promise((r) => { release = r; }));
  const first = t.tabs.open();
  await settle();
  await t.tabs.open();
  assert.equal(t.fake.quickPicks.length, 1);
  release(undefined);
  await first;
});

test('a restored panel binds to its state\'s sessionId; a second restored panel for a bound sid is disposed', async () => {
  const t = setup();
  const p1 = t.fake.makePanel();
  const p2 = t.fake.makePanel();
  await t.tabs.serializer.deserializeWebviewPanel(p1, { sessionId: 's1' });
  await t.tabs.serializer.deserializeWebviewPanel(p2, { sessionId: 's1' });
  await settle();
  assert.match(p1.webview.html, /data-session-id="s1"/);
  assert.equal(p1.title, 'cc: Refactor auth');
  assert.equal(p2.disposed, true);
  assert.equal(p1.disposed, false);
});

test('two restored panels bind to their own sessions', async () => {
  const t = setup();
  const p1 = t.fake.makePanel();
  const p2 = t.fake.makePanel();
  await t.tabs.serializer.deserializeWebviewPanel(p1, { sessionId: 's1' });
  await t.tabs.serializer.deserializeWebviewPanel(p2, { sessionId: 's2' });
  await settle();
  assert.deepEqual([p1.title, p2.title], ['cc: Refactor auth', 'cc: Fix build']);
});

test('a restored panel without state adopts the legacy stored id once and deletes the key; the next stateless restore is unbound', async () => {
  const t = setup({ stored: 's1' });
  const p1 = t.fake.makePanel();
  const p2 = t.fake.makePanel();
  await t.tabs.serializer.deserializeWebviewPanel(p1, undefined);
  await settle();
  assert.match(p1.webview.html, /data-session-id="s1"/);
  assert.equal(t.store.has(SESSION_KEY), false);
  await t.tabs.serializer.deserializeWebviewPanel(p2, null);
  await settle();
  assert.doesNotMatch(p2.webview.html, /<iframe/);
  assert.match(p2.webview.html, /id="connect"/);
  assert.equal(p2.disposed, false);
});

test('a chip goes to visible bound tabs only', async () => {
  const t = setup();
  await openTwo(t);
  t.fake.panels[1].setVisible(false);
  t.tabs.onChip(chip);
  await settle();
  assert.deepEqual(t.writes().map((m) => m.sid), ['s1']);
});

test('a hidden tab that becomes visible receives nothing until the next chip', async () => {
  const t = setup();
  await openTwo(t);
  t.fake.panels[1].setVisible(false);
  t.tabs.onChip(chip);
  await settle();
  const before = t.writes('s2').length;
  // a real current chip, so a visibility-triggered push would write it
  t.source.current = chip;
  t.fake.panels[1].setVisible(true);
  t.fake.panels[1].setActive(true);
  await settle();
  assert.equal(t.writes('s2').length, before);
  t.tabs.onChip(chip);
  await settle();
  assert.equal(t.writes('s2').length, before + 1);
});

test('a forced push (bind, start, relay ready) writes only to a visible tab', async () => {
  const t = setup({ current: chip });
  // restore while hidden: no write from start's push
  const hidden = t.fake.makePanel({ visible: false });
  await t.tabs.serializer.deserializeWebviewPanel(hidden, { sessionId: 's1' });
  await settle();
  assert.equal(t.writes('s1').length, 0);
  // relay ready while hidden: still none
  hidden.webview.handler({ type: 'relayReady' });
  await settle();
  assert.equal(t.writes('s1').length, 0);
  // relay ready while visible: one forced write
  hidden.setVisible(true);
  hidden.webview.handler({ type: 'relayReady' });
  await settle();
  assert.equal(t.writes('s1').length, 1);
  // a restore while visible writes on connect
  const shown = t.fake.makePanel({ visible: true });
  await t.tabs.serializer.deserializeWebviewPanel(shown, { sessionId: 's2' });
  await settle();
  assert.equal(t.writes('s2').length, 1);
  // a bind from the picker onto a visible host writes too
  const u = setup({ current: chip });
  u.fake.pickScript.push(u.pickSid('s1'));
  await u.tabs.open();
  assert.equal(u.writes('s1').length, 1);
});

test('an ended tab receives no chips; its button reruns the picker targeting it and a pick rebinds it', async () => {
  const t = setup({ relay: (m) => (m.op === 'setChip' && m.sid === 's1' ? { ok: false, code: 'SESSION_NOT_LIVE', error: 'gone' } : null) });
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  const panel = t.fake.panels[0];
  t.tabs.onChip(chip);
  await settle();
  assert.equal(t.writes('s1').length, 1);
  assert.doesNotMatch(panel.webview.html, /<iframe/);
  assert.match(panel.webview.html, /id="connect"/);
  assert.equal(t.fake.statusBars[0].text, 'cc: session ended');
  t.tabs.onChip(chip);
  await settle();
  assert.equal(t.writes('s1').length, 1);

  t.fake.pickScript.push(t.pickSid('s2'));
  panel.webview.handler({ type: 'connect' });
  await settle();
  assert.equal(t.fake.panels.length, 1, 'rebinds in place');
  assert.ok(panel.webview.posted.some((m) => m.type === 'showDocument' && m.sessionId === 's2'));
  assert.equal(panel.title, 'cc: Fix build');
  t.tabs.onChip(chip);
  await settle();
  assert.equal(t.writes('s2').length, 1);
});

test('cancelling the picker on an ended tab leaves it ended with its button', async () => {
  const t = setup({ relay: (m) => (m.op === 'setChip' ? { ok: false, code: 'SESSION_NOT_LIVE' } : null) });
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  t.tabs.onChip(chip);
  await settle();
  t.fake.pickScript.push(undefined);
  t.fake.panels[0].webview.handler({ type: 'connect' });
  await settle();
  assert.equal(t.fake.panels[0].disposed, false);
  assert.match(t.fake.panels[0].webview.html, /id="connect"/);
  assert.doesNotMatch(t.fake.panels[0].webview.html, /<iframe/);
});

test('the status bar follows the last-active tab and reads no tab open when none', async () => {
  const t = setup();
  const bar = t.fake.statusBars[0];
  assert.equal(bar.text, 'cc: no tab open');
  assert.equal(bar.command, 'codeConductor.open');
  await openTwo(t);
  assert.equal(bar.text, 'cc: Fix build');
  t.fake.panels[0].setActive(true);
  assert.equal(bar.text, 'cc: Refactor auth');
  t.fake.panels[0].dispose();
  assert.equal(bar.text, 'cc: Fix build');
  t.fake.panels[1].dispose();
  assert.equal(bar.text, 'cc: no tab open');
});

test('a closed tab releases its session so it can be opened again', async () => {
  const t = setup();
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  t.fake.panels[0].dispose();
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  assert.equal(t.fake.panels.length, 2);
  assert.equal(t.fake.panels[1].disposed, false);
});

test('a failing endpoints lookup (bad serverUrl) reports the error and disposes the transient host', async () => {
  const t = setup({ serverUrl: 'not a url' });
  await t.tabs.open();
  assert.equal(t.fake.messages[0][0], 'error');
  assert.equal(t.fake.panels.length, 1);
  assert.equal(t.fake.panels[0].disposed, true);
  assert.equal(t.fake.statusBars[0].text, 'cc: no tab open');
  // the picker is free again
  t.fake.config.serverUrl = 'http://127.0.0.1:8787';
  t.fake.pickScript.push(undefined);
  await t.tabs.open();
  assert.equal(t.fake.quickPicks.length, 1);
});

test('a relay reload re-sends a repeat file chip despite the dedupe baseline', async () => {
  const file = { kind: 'file', key: '/a.ts', title: 'a.ts', data: 'path: /a.ts' };
  const t = setup({ current: file });
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.tabs.open();
  assert.equal(t.writes('s1').length, 1);
  t.fake.panels[0].webview.handler({ type: 'relayReady' });
  await settle();
  const writes = t.writes('s1');
  assert.equal(writes.length, 2);
  assert.deepEqual([writes[1].title, writes[1].data], [writes[0].title, writes[0].data]);
});

test('a restored panel whose state has a null sessionId stays unbound and leaves the legacy key', async () => {
  const t = setup({ stored: 's1' });
  const p = t.fake.makePanel();
  await t.tabs.serializer.deserializeWebviewPanel(p, { sessionId: null });
  await settle();
  assert.doesNotMatch(p.webview.html, /<iframe/);
  assert.match(p.webview.html, /id="connect"/);
  assert.equal(t.store.get(SESSION_KEY), 's1');
});
