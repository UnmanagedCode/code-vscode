import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../extension/media/webview.js', import.meta.url), 'utf8');

function run({ sessionId = '', ccOrigin = 'http://cc.test' } = {}) {
  const states = [];
  const posted = [];
  const listeners = {};
  const frames = { cc: { src: '', contentWindow: {} }, relay: { contentWindow: { postMessage: (m, o) => posted.push(['relay', m, o]) } } };
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(['host', m]), setState: (s) => states.push(JSON.parse(JSON.stringify(s))) }),
    document: { body: { dataset: { ccOrigin, sessionId } }, getElementById: (id) => frames[id] ?? null },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    URL,
  };
  vm.runInNewContext(script, sandbox);
  return { states, frames, posted, message: (ev) => listeners.message(ev) };
}

test('on load the script persists data-session-id as webview state', () => {
  assert.deepEqual(run({ sessionId: 's1' }).states, [{ sessionId: 's1' }]);
  assert.deepEqual(run({ sessionId: '' }).states, [{ sessionId: null }]);
});

test('showDocument for cc\'s origin sets the frame src and persists its sessionId; another origin changes neither', () => {
  const t = run();
  t.message({ source: null, origin: 'vscode-webview://x', data: { type: 'showDocument', url: 'http://cc.test/p/?focus=s2', sessionId: 's2' } });
  assert.equal(t.frames.cc.src, 'http://cc.test/p/?focus=s2');
  assert.deepEqual(t.states.at(-1), { sessionId: 's2' });
  const before = t.states.length;
  t.message({ source: null, origin: 'vscode-webview://x', data: { type: 'showDocument', url: 'http://evil.test/', sessionId: 's3' } });
  assert.equal(t.frames.cc.src, 'http://cc.test/p/?focus=s2');
  assert.equal(t.states.length, before);
});
