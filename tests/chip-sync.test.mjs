import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createChipSync, SELECTION_DEBOUNCE_MS } = createRequire(import.meta.url)('../extension/src/chipSync.js');

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

function emitter() {
  const listeners = new Set();
  return { on: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; }, fire: (...a) => listeners.forEach((fn) => fn(...a)), size: () => listeners.size };
}

// `editor.chip` is what the fake shape() returns for that editor.
const selChip = (title) => ({ kind: 'selection', title, data: `d-${title}` });
const fileChip = (key) => ({ kind: 'file', key, title: key, data: `path: ${key}` });

function setup() {
  const selection = emitter();
  const active = emitter();
  const state = { editor: { chip: selChip('t1'), viewColumn: 1 }, visible: [] };
  const chips = [];
  const source = createChipSync({
    onDidChangeTextEditorSelection: selection.on,
    onDidChangeActiveTextEditor: active.on,
    getActiveEditor: () => state.editor,
    getVisibleEditors: () => state.visible,
    shape: (e) => e.chip,
    onChip: (c) => chips.push(c),
  });
  return { source, selection, active, state, chips };
}
const tick = (ms = SELECTION_DEBOUNCE_MS) => mock.timers.tick(ms);
const fire = (t, editor = t.state.editor) => t.selection.fire({ textEditor: editor });

test('a burst of selection changes gives one chip after the debounce', () => {
  const t = setup();
  fire(t); tick(100); fire(t); tick(100); fire(t);
  tick(SELECTION_DEBOUNCE_MS - 1);
  assert.equal(t.chips.length, 0);
  tick(1);
  assert.deepEqual(t.chips, [{ ...selChip('t1'), seq: 1 }]);
});

test('the flush shapes the editor that raised the event, even after focus left the editors', () => {
  const t = setup();
  fire(t);
  t.state.editor = undefined;
  t.active.fire(undefined);
  tick();
  assert.deepEqual(t.chips.map((c) => c.title), ['t1']);
});

test('an active editor becoming undefined produces nothing', () => {
  const t = setup();
  t.state.editor = undefined;
  t.active.fire(undefined); tick();
  assert.equal(t.chips.length, 0);
});

test('a state that shapes to nothing produces nothing', () => {
  const t = setup();
  const out = { chip: null };
  t.selection.fire({ textEditor: out }); t.active.fire(out); tick();
  assert.equal(t.chips.length, 0);
});

test('switching to another editor produces that editor\'s chip, and the source never dedupes', () => {
  const t = setup();
  const other = { chip: fileChip('/a.ts') };
  t.active.fire(other); tick();
  t.active.fire(other); tick();
  assert.deepEqual(t.chips, [{ ...fileChip('/a.ts'), seq: 1 }, { ...fileChip('/a.ts'), seq: 2 }]);
});

test('refresh() reshapes the tracked editor, falling back to the active one, and returns null for nothing', () => {
  const t = setup();
  assert.deepEqual(t.source.refresh(), { ...selChip('t1'), seq: 0 });
  const a = { chip: fileChip('/a.ts') };
  t.active.fire(a); tick();
  t.state.editor = undefined;
  assert.deepEqual(t.source.refresh(), { ...fileChip('/a.ts'), seq: 1 });
  const fresh = setup();
  fresh.state.editor = undefined;
  assert.equal(fresh.source.refresh(), null);
  fresh.state.editor = { chip: null };
  assert.equal(fresh.source.refresh(), null);
  assert.equal(fresh.chips.length, 0);
});

test('dispose unsubscribes and cancels a pending flush', () => {
  const t = setup();
  fire(t);
  t.source.dispose();
  tick();
  assert.equal(t.chips.length, 0);
  assert.equal(t.selection.size() + t.active.size(), 0);
});

test('each produced chip carries a seq one above the last; refresh() carries the current seq without advancing it', () => {
  const t = setup();
  fire(t); tick();
  fire(t); tick();
  assert.deepEqual(t.chips.map((c) => c.seq), [1, 2]);
  assert.equal(t.source.refresh().seq, 2);
  assert.equal(t.source.refresh().seq, 2);
  fire(t); tick();
  assert.equal(t.chips.at(-1).seq, 3);
});

test('latestShown returns the last produced chip only while the editor that produced it is visible', () => {
  const t = setup();
  assert.equal(t.source.latestShown(), null);
  const ed = t.state.editor;
  fire(t); tick();
  t.state.visible = [ed];
  assert.deepEqual(t.source.latestShown(), t.chips[0]);
  t.state.visible = [];
  assert.equal(t.source.latestShown(), null);
});

test('latestShown compares editor identity, not document', () => {
  const t = setup();
  fire(t); tick();
  t.state.visible = [{ ...t.state.editor }];
  assert.equal(t.source.latestShown(), null);
});

test('latestShown returns null when the producing editor is in the receiving tab\'s column', () => {
  const t = setup();
  fire(t); tick();
  t.state.visible = [t.state.editor];
  assert.equal(t.source.latestShown(1), null);
  assert.deepEqual(t.source.latestShown(2), t.chips[0]);
  assert.deepEqual(t.source.latestShown(undefined), t.chips[0]);
});

test('latestShown returns the produced chip, not a reshape of the editor now', () => {
  const t = setup();
  fire(t); tick();
  t.state.visible = [t.state.editor];
  t.state.editor.chip = selChip('t2');
  assert.equal(t.source.latestShown(2).title, 't1');
});
