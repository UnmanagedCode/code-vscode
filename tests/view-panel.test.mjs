import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createView } = createRequire(import.meta.url)('../extension/src/view.js');

function fakePanel() {
  const disposers = [];
  const posted = [];
  const p = {
    title: '', iconPath: null, revealed: 0, disposed: false,
    webview: { options: null, html: '', cspSource: 'csp:', posted, handler: null, asWebviewUri: (u) => u, postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => { p.webview.handler = fn; } },
    onDidDispose: (fn) => disposers.push(fn),
    reveal() { p.revealed += 1; },
    dispose() { p.disposed = true; disposers.forEach((fn) => fn()); },
  };
  return p;
}

function setup() {
  const created = [];
  const vscode = {
    ViewColumn: { Beside: -2 },
    Uri: { joinPath: (...a) => a.join('/') },
    window: { createWebviewPanel: (type, title, show, options) => { const p = fakePanel(); created.push({ p, type, show, options }); return p; } },
  };
  const view = createView({ vscode, extensionUri: 'ext', randomBytes: () => ({ toString: () => 'n' }) });
  const events = [];
  for (const n of ['resolve', 'close']) view.on(n, () => events.push(n));
  return { view, created, events };
}

test('reveal creates one panel beside the editor, retained and scripted, and a second reveal reuses it', () => {
  const t = setup();
  t.view.reveal();
  assert.equal(t.created.length, 1);
  assert.equal(t.created[0].show.viewColumn, -2);
  assert.equal(t.created[0].options.retainContextWhenHidden, true);
  assert.equal(t.created[0].options.enableScripts, true);
  assert.deepEqual(t.events, ['resolve']);
  t.view.reveal();
  assert.equal(t.created.length, 1);
  assert.equal(t.created[0].p.revealed, 1);
});

test('a restored panel is adopted and later reveals reuse it; a second restored panel is disposed', async () => {
  const t = setup();
  const restored = fakePanel();
  await t.view.serializer.deserializeWebviewPanel(restored);
  assert.deepEqual(t.events, ['resolve']);
  assert.equal(t.view.isOpen(), true);
  assert.equal(restored.webview.options.enableScripts, true);
  t.view.reveal();
  assert.equal(t.created.length, 0);
  assert.equal(restored.revealed, 1);
  const extra = fakePanel();
  await t.view.serializer.deserializeWebviewPanel(extra);
  assert.equal(extra.disposed, true);
  assert.equal(restored.disposed, false);
  assert.equal(t.view.isOpen(), true);
});

test('disposing the panel fails pending requests, rejects waiters, emits close and lets reveal create a new panel', async () => {
  const t = setup();
  t.view.reveal();
  const req = t.view.request({ op: 'health' });
  const ready = t.view.whenReady(60_000);
  t.created[0].p.dispose();
  assert.equal((await req).code, 'REQUEST_FAILED');
  await assert.rejects(ready);
  assert.deepEqual(t.events, ['resolve', 'close']);
  assert.equal(t.view.isOpen(), false);
  t.view.reveal();
  assert.equal(t.created.length, 2);
});

test('a request with no panel resolves REQUEST_FAILED', async () => {
  const t = setup();
  assert.equal((await t.view.request({ op: 'health' })).code, 'REQUEST_FAILED');
});
