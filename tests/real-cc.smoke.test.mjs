// Runs against a scratch cc with this plugin enabled:
//   RUN_REAL_CC=1 CC_URL=http://127.0.0.1:<port> npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../plugin/relayCore.mjs';
import { FRAME_ANCESTOR_SOURCES } from '../plugin/embed.mjs';

const enabled = process.env.RUN_REAL_CC === '1' && !!process.env.CC_URL;
const skip = enabled ? false : 'set RUN_REAL_CC=1 and CC_URL to run against a scratch cc';
const cc = (process.env.CC_URL ?? '').replace(/\/+$/, '');

function realRelay() {
  const parent = {};
  const replies = [];
  parent.postMessage = (msg) => replies.push(msg);
  // The relay's URLs are origin-relative; in node they need cc's origin.
  const relay = createRelay({ fetch: (path, init) => fetch(cc + path, init), root: '', parent });
  let n = 0;
  return async (op, args = {}) => {
    const reqId = String(++n);
    await relay.onMessage({ source: parent, origin: 'vscode-webview://smoke', data: { reqId, op, ...args } });
    return replies.find((r) => r.reqId === reqId);
  };
}

test('cc serves its document under the plugin with a base and the VS Code framing policy', { skip }, async () => {
  const res = await fetch(`${cc}/plugins/code-vscode/?focus=x`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<head><base href="\/">/);
  assert.ok(res.headers.get('content-security-policy').includes(`frame-ancestors ${FRAME_ANCESTOR_SOURCES.join(' ')}`));
  assert.equal(res.headers.get('x-frame-options'), null);
  const relay = await fetch(`${cc}/plugins/code-vscode/relay`);
  assert.equal(relay.status, 200);
});

test('the relay starts a conductor, sets and clears its chip', { skip }, async () => {
  const call = realRelay();
  const made = await call('newConductor');
  assert.equal(made.ok, true, JSON.stringify(made));
  const sid = made.value.sessionId;
  assert.ok(sid);

  const set = await call('setChip', { sid, title: 'smoke.ts:1', data: 'path: smoke.ts' });
  assert.equal(set.ok, true, JSON.stringify(set));
  const clear = await call('clearChip', { sid });
  assert.equal(clear.ok, true, JSON.stringify(clear));

  const list = await call('listConductors');
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.value));
  for (const row of list.value) assert.deepEqual(Object.keys(row).sort(), ['displayLabel', 'sessionId', 'status']);

  const missing = await call('setChip', { sid: 'no-such-session', title: 't', data: 'd' });
  assert.equal(missing.code, 'SESSION_NOT_LIVE');
  const health = await call('health');
  assert.equal(health.ok, true);
  assert.equal(typeof health.value.uiMode, 'string');
});
