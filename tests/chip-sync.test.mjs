import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createChipSync, SELECTION_DEBOUNCE_MS } = createRequire(import.meta.url)('../extension/src/chipSync.js');

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

function emitter() {
  const listeners = new Set();
  return { on: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, fire: (...a) => listeners.forEach((fn) => fn(...a)) };
}

// `editor.chip` is what the fake shape() returns for the active editor.
function setup() {
  const selection = emitter();
  const active = emitter();
  const state = { editor: { chip: { title: 't1', data: 'd1' } } };
  const writes = [];
  const results = [];
  const gates = [];
  const sync = createChipSync({
    onDidChangeTextEditorSelection: selection.on,
    onDidChangeActiveTextEditor: active.on,
    getActiveEditor: () => state.editor,
    shape: (e) => e.chip,
    send: (m) => { writes.push(m); const g = gates.shift(); return typeof g === 'function' ? g() : (g ?? Promise.resolve({ ok: true })); },
    onResult: (r) => results.push(r),
  });
  sync.enable();
  return { sync, selection, active, state, writes, results, gates };
}
const settle = () => new Promise((r) => setImmediate(r));
const tick = (ms = SELECTION_DEBOUNCE_MS) => mock.timers.tick(ms);

test('a burst of selection changes gives one write after the debounce', async () => {
  const t = setup();
  t.selection.fire(); tick(100); t.selection.fire(); tick(100); t.selection.fire();
  tick(SELECTION_DEBOUNCE_MS - 1);
  assert.equal(t.writes.length, 0);
  tick(1);
  await settle();
  assert.deepEqual(t.writes, [{ op: 'setChip', title: 't1', data: 'd1' }]);
});

test('an empty selection is written as clearChip', async () => {
  const t = setup();
  t.state.editor = { chip: null };
  t.selection.fire(); tick(); await settle();
  assert.deepEqual(t.writes, [{ op: 'clearChip' }]);
});

test('the active editor becoming undefined writes nothing, also when the debounce was already running', async () => {
  const t = setup();
  t.active.fire(undefined); tick(); await settle();
  assert.equal(t.writes.length, 0);
  t.selection.fire();
  t.state.editor = undefined;
  tick(); await settle();
  assert.equal(t.writes.length, 0);
});

test('switching to another editor writes that editor\'s state', async () => {
  const t = setup();
  t.state.editor = { chip: { title: 'other', data: 'o' } };
  t.active.fire(t.state.editor); tick(); await settle();
  assert.deepEqual(t.writes, [{ op: 'setChip', title: 'other', data: 'o' }]);
});

test('the same selection is written again after the previous write (no dedupe)', async () => {
  const t = setup();
  t.selection.fire(); tick(); await settle();
  t.selection.fire(); tick(); await settle();
  assert.equal(t.writes.length, 2);
  assert.deepEqual(t.writes[0], t.writes[1]);
});

test('while a write is in flight only the latest newer state is sent next', async () => {
  const t = setup();
  let release;
  t.gates.push(new Promise((r) => { release = r; }));
  t.selection.fire(); tick(); await settle();
  assert.equal(t.writes.length, 1);
  for (const n of [2, 3, 4]) { t.state.editor = { chip: { title: `t${n}`, data: `d${n}` } }; t.selection.fire(); tick(); }
  assert.equal(t.writes.length, 1);
  release({ ok: true }); await settle(); await settle();
  assert.deepEqual(t.writes.map((w) => w.title), ['t1', 't4']);
});

test('nothing is sent while disabled; pending work is dropped on disable', async () => {
  const t = setup();
  t.sync.disable();
  t.selection.fire(); tick(); await settle();
  assert.equal(t.writes.length, 0);
  t.sync.enable();
  t.selection.fire(); t.sync.disable(); tick(); await settle();
  assert.equal(t.writes.length, 0);
});

test('pushNow writes the current state immediately and cancels the debounce', async () => {
  const t = setup();
  t.selection.fire();
  t.sync.pushNow(); await settle();
  assert.equal(t.writes.length, 1);
  tick(); await settle();
  assert.equal(t.writes.length, 1);
});

test('every write\'s result is reported, and a rejected send is a REQUEST_FAILED result', async () => {
  const t = setup();
  t.gates.push(Promise.resolve({ ok: false, code: 'VIEW_ONLY' }), () => Promise.reject(new Error('gone')));
  t.selection.fire(); tick(); await settle();
  t.selection.fire(); tick(); await settle();
  assert.deepEqual(t.results.map((r) => r.code ?? 'ok'), ['VIEW_ONLY', 'REQUEST_FAILED']);
});
