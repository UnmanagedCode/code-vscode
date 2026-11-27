import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFakeVscode } from './fakes/vscode.mjs';
const { createTabView, createPanel, VIEW_TYPE } = createRequire(import.meta.url)('../extension/src/view.js');

function setup() {
  const fake = createFakeVscode();
  const make = (opts) => {
    const panel = fake.makePanel({ auto: false, ...opts });
    const view = createTabView({ vscode: fake.vscode, extensionUri: 'ext', randomBytes: () => ({ toString: () => 'n' }), panel });
    const events = [];
    for (const n of ['ready', 'connect', 'close']) view.on(n, () => events.push(n));
    view.on('viewState', (s) => events.push(['viewState', s]));
    return { panel, view, events };
  };
  return { fake, make };
}

test('two tab views keep separate channels: a result reaches only its own request, ready only its own waiters', async () => {
  const { make } = setup();
  const a = make();
  const b = make();
  const reqA = a.view.request({ op: 'health' });
  const reqB = b.view.request({ op: 'health' });
  const readyB = b.view.whenReady(60_000);
  const idA = a.panel.webview.posted[0].msg.reqId;
  const idB = b.panel.webview.posted[0].msg.reqId;
  assert.equal(idA, idB, 'each view numbers its own requests');
  a.panel.webview.handler({ type: 'relayResult', msg: { type: 'result', reqId: idA, ok: true, value: 'A' } });
  assert.equal((await reqA).value, 'A');
  let bDone = false;
  void reqB.then(() => { bDone = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(bDone, false);
  a.panel.webview.handler({ type: 'relayReady' });
  assert.deepEqual(a.events, ['ready']);
  assert.deepEqual(b.events, []);
  b.panel.webview.handler({ type: 'relayReady' });
  await readyB;
  b.panel.webview.handler({ type: 'relayResult', msg: { type: 'result', reqId: idB, ok: true } });
  assert.equal((await reqB).ok, true);
});

test('disposing one panel fails only its own pending requests, rejects its waiters and emits close', async () => {
  const { make } = setup();
  const a = make();
  const b = make();
  const reqA = a.view.request({ op: 'health' });
  const reqB = b.view.request({ op: 'health' });
  const ready = a.view.whenReady(60_000);
  const rejected = assert.rejects(ready);
  a.panel.dispose();
  assert.equal((await reqA).code, 'REQUEST_FAILED');
  await rejected;
  assert.deepEqual(a.events, ['close']);
  assert.deepEqual(b.events, []);
  assert.equal(a.view.isDisposed(), true);
  assert.equal(b.view.isDisposed(), false);
  assert.equal((await a.view.request({ op: 'health' })).code, 'REQUEST_FAILED');
  b.panel.webview.handler({ type: 'relayResult', msg: { type: 'result', reqId: b.panel.webview.posted[0].msg.reqId, ok: true } });
  assert.equal((await reqB).ok, true);
});

test('setDocument posts showDocument with the url and the sessionId', () => {
  const { make } = setup();
  const a = make();
  a.view.setDocument('http://h/plugins/code-vscode/?focus=s1', 's1');
  assert.deepEqual(a.panel.webview.posted.at(-1), { type: 'showDocument', url: 'http://h/plugins/code-vscode/?focus=s1', sessionId: 's1' });
});

test('isVisible reads panel.visible; viewState events report active and visible', () => {
  const { make } = setup();
  const a = make({ visible: true, active: false });
  assert.equal(a.view.isVisible(), true);
  assert.equal(a.view.isActive(), false);
  a.panel.setVisible(false);
  assert.equal(a.view.isVisible(), false);
  a.panel.setActive(true);
  assert.deepEqual(a.events.filter((e) => Array.isArray(e)).map((e) => e[1]), [{ visible: false, active: false }, { visible: false, active: true }]);
});

test('viewColumn reads panel.viewColumn; undefined once disposed', () => {
  const { make } = setup();
  const a = make();
  a.panel.viewColumn = 3;
  assert.equal(a.view.viewColumn(), 3);
  a.panel.dispose();
  assert.equal(a.view.viewColumn(), undefined);
});

test('the page button and relay readiness are emitted; messages are tied to the panel that sent them', () => {
  const { make } = setup();
  const a = make();
  a.panel.webview.handler({ type: 'connect' });
  assert.deepEqual(a.events, ['connect']);
});

test('createPanel opens beside the editor, retained and scripted; reveal and setTitle reach the panel', () => {
  const { fake, make } = setup();
  const p = createPanel(fake.vscode, 'ext');
  assert.equal(fake.panels.length, 1);
  assert.equal(p.created.type, VIEW_TYPE);
  assert.equal(p.created.show.viewColumn, -2);
  assert.equal(p.created.options.retainContextWhenHidden, true);
  assert.equal(p.created.options.enableScripts, true);
  const a = make();
  a.view.reveal();
  assert.equal(a.panel.revealed, 1);
  a.view.setTitle('cc: x');
  assert.equal(a.panel.title, 'cc: x');
});

test('load renders the session id into the page, showMessage renders an unbound page', () => {
  const { make } = setup();
  const a = make();
  a.view.load({ ccOrigin: 'http://h', relayUrl: 'http://h/r', documentUrl: 'http://h/d', sessionId: 's1' });
  assert.match(a.panel.webview.html, /data-session-id="s1"/);
  a.view.showMessage('hello');
  assert.match(a.panel.webview.html, /data-session-id=""/);
  assert.doesNotMatch(a.panel.webview.html, /<iframe/);
});
