import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFakeVscode, settle } from './fakes/vscode.mjs';
const require = createRequire(import.meta.url);
const { activate } = require('../extension/src/extension.js');
const { VIEW_TYPE } = require('../extension/src/view.js');
const { SELECTION_DEBOUNCE_MS } = require('../extension/src/chipSync.js');

// Real extension.js, tabs, tab, view, chipSync, chipWriter, picker, endpoints; only `vscode` is fake.
const live = [{ sessionId: 's1', displayLabel: 'Refactor auth', status: 'idle' }, { sessionId: 's2', displayLabel: 'Fix build', status: 'busy' }];

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

function boot() {
  const fake = createFakeVscode({ conductors: live });
  const context = { extensionUri: 'ext', subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
  activate(context, fake.vscode);
  const open = () => fake.commands.get('codeConductor.open')();
  const pickSid = (sid) => (items) => items.find((i) => i.sessionId === sid);
  return { fake, context, open, pickSid };
}

const editor = (text = 'foo') => ({
  document: { fileName: '/w/a.ts', languageId: 'typescript', isClosed: false, uri: { scheme: 'file', fsPath: '/w/a.ts', toString: () => 'file:///w/a.ts' }, getText: () => text },
  selection: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } },
});

test('cc: Open → picker → panel: lists through a new tab\'s relay, binds it to the pick, and a second Open picking the same session reveals it', async () => {
  const t = boot();
  assert.deepEqual([...t.fake.commands.keys()], ['codeConductor.open']);
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.open();
  assert.equal(t.fake.panels.length, 1);
  assert.equal(t.fake.requests('listConductors').length, 1);
  const show = t.fake.panels[0].webview.posted.find((m) => m.type === 'showDocument');
  assert.equal(show.sessionId, 's1');
  assert.match(show.url, /focus=s1/);
  assert.equal(t.fake.statusBars[0].text, 'cc: Refactor auth');

  t.fake.pickScript.push(t.pickSid('s1'));
  await t.open();
  assert.equal(t.fake.panels.length, 1);
  assert.equal(t.fake.panels[0].revealed, 1);
});

test('selection change → setChip reaches only the visible tab\'s relay', async () => {
  const t = boot();
  t.fake.pickScript.push(t.pickSid('s1'));
  await t.open();
  t.fake.pickScript.push(t.pickSid('s2'));
  await t.open();
  assert.equal(t.fake.panels.length, 2);
  t.fake.panels[1].setVisible(false);
  const before = t.fake.requests('setChip').length;
  t.fake.fireSelection(editor('foo'));
  mock.timers.tick(SELECTION_DEBOUNCE_MS);
  await settle();
  const writes = t.fake.requests('setChip').slice(before);
  assert.deepEqual(writes.map((m) => m.sid), ['s1']);
  assert.match(writes[0].title, /a\.ts/);
  assert.match(writes[0].data, /foo$/);
});

test('the serializer registered for VIEW_TYPE restores two panels bound to their own sessions', async () => {
  const t = boot();
  const serializer = t.fake.serializers.get(VIEW_TYPE);
  assert.ok(serializer);
  const p1 = t.fake.makePanel();
  const p2 = t.fake.makePanel();
  await serializer.deserializeWebviewPanel(p1, { sessionId: 's1' });
  await serializer.deserializeWebviewPanel(p2, { sessionId: 's2' });
  await settle();
  assert.deepEqual([p1.title, p2.title], ['cc: Refactor auth', 'cc: Fix build']);
  assert.match(p1.webview.html, /focus=s1/);
  assert.match(p2.webview.html, /focus=s2/);
});
