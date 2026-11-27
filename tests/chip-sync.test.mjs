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

// `editor.chip` is what the fake shape() returns for that editor; selection events carry {textEditor}.
const sel = (editor) => ({ textEditor: editor });
const fileChip = (key) => ({ kind: 'file', key, title: key, data: `path: ${key}` });

function setup() {
  const selection = emitter();
  const active = emitter();
  const state = { editor: { chip: { kind: 'selection', title: 't1', data: 'd1' } } };
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

const fire = (t) => t.selection.fire(sel(t.state.editor));

test('a burst of selection changes gives one write after the debounce', async () => {
  const t = setup();
  fire(t); tick(100); fire(t); tick(100); fire(t);
  tick(SELECTION_DEBOUNCE_MS - 1);
  assert.equal(t.writes.length, 0);
  tick(1);
  await settle();
  assert.deepEqual(t.writes, [{ op: 'setChip', title: 't1', data: 'd1' }]);
});

test('an empty selection in a file writes its file chip, never a clearChip', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  fire(t); tick(); await settle();
  assert.deepEqual(t.writes, [{ op: 'setChip', title: '/a.ts', data: 'path: /a.ts' }]);
});

test('a state that shapes to nothing writes nothing, and pushNow still writes the previously tracked chip', async () => {
  const t = setup();
  const a = { chip: fileChip('/a.ts') };
  t.active.fire(a); tick(); await settle();
  assert.equal(t.writes.length, 1);
  const out = { chip: null };
  t.state.editor = out;
  t.selection.fire(sel(out)); t.active.fire(out); tick(); await settle();
  assert.equal(t.writes.length, 1);
  t.state.editor = undefined;
  t.sync.pushNow(); await settle();
  assert.equal(t.writes.length, 2);
  assert.equal(t.writes[1].title, '/a.ts');
});

test('cursor moves in the same file after its file chip write nothing, so the composer × sticks', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  t.active.fire(t.state.editor); tick(); await settle();
  fire(t); tick(); await settle();
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 1);
});

test('selecting then collapsing in the same file writes the selection chip, then the file chip again', async () => {
  const t = setup();
  const file = fileChip('/a.ts');
  t.state.editor = { chip: file };
  t.active.fire(t.state.editor); tick(); await settle();
  t.state.editor.chip = { kind: 'selection', title: 'a.ts:1', data: 'x' };
  fire(t); tick(); await settle();
  t.state.editor.chip = file;
  fire(t); tick(); await settle();
  assert.deepEqual(t.writes.map((w) => w.title), ['/a.ts', 'a.ts:1', '/a.ts']);
});

test('switching files A then B then A writes each file chip', async () => {
  const t = setup();
  const a = { chip: fileChip('/a.ts') };
  const b = { chip: fileChip('/b.ts') };
  for (const ed of [a, b, a]) { t.state.editor = ed; t.active.fire(ed); tick(); await settle(); }
  assert.deepEqual(t.writes.map((w) => w.title), ['/a.ts', '/b.ts', '/a.ts']);
});

test('a selection debounced when focus leaves the editors is still written', async () => {
  const t = setup();
  fire(t);
  t.state.editor = undefined;
  t.active.fire(undefined);
  tick(); await settle();
  assert.deepEqual(t.writes.map((w) => w.title), ['t1']);
});

test('the active editor becoming undefined alone writes nothing', async () => {
  const t = setup();
  t.state.editor = undefined;
  t.active.fire(undefined); tick(); await settle();
  assert.equal(t.writes.length, 0);
});

test('switching to another editor writes that editor\'s state', async () => {
  const t = setup();
  t.state.editor = { chip: { kind: 'selection', title: 'other', data: 'o' } };
  t.active.fire(t.state.editor); tick(); await settle();
  assert.deepEqual(t.writes, [{ op: 'setChip', title: 'other', data: 'o' }]);
});

test('the same selection is written again after the previous write (no dedupe)', async () => {
  const t = setup();
  fire(t); tick(); await settle();
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 2);
  assert.deepEqual(t.writes[0], t.writes[1]);
});

test('while a write is in flight only the latest newer state is sent next', async () => {
  const t = setup();
  let release;
  t.gates.push(new Promise((r) => { release = r; }));
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 1);
  for (const n of [2, 3, 4]) { t.state.editor = { chip: { kind: 'selection', title: `t${n}`, data: `d${n}` } }; fire(t); tick(); }
  assert.equal(t.writes.length, 1);
  release({ ok: true }); await settle(); await settle();
  assert.deepEqual(t.writes.map((w) => w.title), ['t1', 't4']);
});

test('nothing is sent while disabled; pending work is dropped on disable', async () => {
  const t = setup();
  t.sync.disable();
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 0);
  t.sync.enable();
  fire(t); t.sync.disable(); tick(); await settle();
  assert.equal(t.writes.length, 0);
});

test('pushNow writes the current state immediately and cancels the debounce', async () => {
  const t = setup();
  fire(t);
  t.sync.pushNow(); await settle();
  assert.equal(t.writes.length, 1);
  tick(); await settle();
  assert.equal(t.writes.length, 1);
});

test('pushNow bypasses the file-chip dedupe, using the tracked editor when none is active', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  t.active.fire(t.state.editor); tick(); await settle();
  t.state.editor = undefined;
  t.sync.pushNow(); await settle();
  assert.equal(t.writes.length, 2);
});

test('a failed file-chip write does not suppress the next attempt for the same file', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  t.gates.push(Promise.resolve({ ok: false, code: 'REQUEST_FAILED' }));
  t.active.fire(t.state.editor); tick(); await settle();
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 2);
});

test('after disable then enable and pushNow, the file chip is written again', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  t.active.fire(t.state.editor); tick(); await settle();
  t.sync.disable(); t.sync.enable();
  t.sync.pushNow(); await settle();
  assert.equal(t.writes.length, 2);
});

test('every write\'s result is reported, and a rejected send is a REQUEST_FAILED result', async () => {
  const t = setup();
  t.gates.push(Promise.resolve({ ok: false, code: 'VIEW_ONLY' }), () => Promise.reject(new Error('gone')));
  fire(t); tick(); await settle();
  fire(t); tick(); await settle();
  assert.deepEqual(t.results.map((r) => r.code ?? 'ok'), ['VIEW_ONLY', 'REQUEST_FAILED']);
});

test('a failed file-chip write does not reset the baseline when a forced write for the same file is already queued', async () => {
  const t = setup();
  t.state.editor = { chip: fileChip('/a.ts') };
  let fail;
  t.gates.push(new Promise((r) => { fail = r; }));
  t.active.fire(t.state.editor); tick(); await settle();
  t.sync.pushNow();
  fail({ ok: false, code: 'REQUEST_FAILED' });
  await settle(); await settle();
  assert.equal(t.writes.length, 2);
  fire(t); tick(); await settle();
  assert.equal(t.writes.length, 2);
});
