import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createChipWriter } = createRequire(import.meta.url)('../extension/src/chipWriter.js');

const file = (key) => ({ kind: 'file', key, title: key, data: `path: ${key}` });
const sel = (n) => ({ kind: 'selection', title: `t${n}`, data: `d${n}` });
const settle = () => new Promise((r) => setImmediate(r));

function setup() {
  const sent = [];
  const results = [];
  const gates = [];
  const writer = createChipWriter({
    send: (m) => { sent.push(m); const g = gates.shift(); return typeof g === 'function' ? g() : (g ?? Promise.resolve({ ok: true })); },
    onResult: (r) => results.push(r),
  });
  writer.enable();
  return { writer, sent, results, gates };
}

test('a file chip repeating the last written path is skipped, a selection chip never is', async () => {
  const t = setup();
  t.writer.offer(file('/a.ts')); await settle();
  t.writer.offer(file('/a.ts')); await settle();
  assert.equal(t.sent.length, 1);
  t.writer.offer(sel(1)); await settle();
  t.writer.offer(sel(1)); await settle();
  assert.equal(t.sent.length, 3);
  t.writer.offer(file('/a.ts')); await settle();
  assert.deepEqual(t.sent.map((m) => m.title), ['/a.ts', 't1', 't1', '/a.ts']);
});

test('switching files writes each file chip', async () => {
  const t = setup();
  for (const k of ['/a.ts', '/b.ts', '/a.ts']) { t.writer.offer(file(k)); await settle(); }
  assert.deepEqual(t.sent.map((m) => m.title), ['/a.ts', '/b.ts', '/a.ts']);
});

test('sent messages are setChip with the chip title and data only', async () => {
  const t = setup();
  t.writer.offer(sel(1)); await settle();
  assert.deepEqual(t.sent, [{ op: 'setChip', title: 't1', data: 'd1' }]);
});

test('force writes a repeated file chip', async () => {
  const t = setup();
  t.writer.offer(file('/a.ts')); await settle();
  t.writer.offer(file('/a.ts'), { force: true }); await settle();
  assert.equal(t.sent.length, 2);
});

test('at most one write is in flight; the newest pending state replaces older ones', async () => {
  const t = setup();
  let release;
  t.gates.push(new Promise((r) => { release = r; }));
  t.writer.offer(sel(1)); await settle();
  for (const n of [2, 3, 4]) t.writer.offer(sel(n));
  assert.equal(t.sent.length, 1);
  release({ ok: true }); await settle(); await settle();
  assert.deepEqual(t.sent.map((m) => m.title), ['t1', 't4']);
});

test('a failed write does not count as written, unless a newer write for that file is queued', async () => {
  const t = setup();
  t.gates.push(Promise.resolve({ ok: false, code: 'REQUEST_FAILED' }));
  t.writer.offer(file('/a.ts')); await settle();
  t.writer.offer(file('/a.ts')); await settle();
  assert.equal(t.sent.length, 2);

  const u = setup();
  let fail;
  u.gates.push(new Promise((r) => { fail = r; }));
  u.writer.offer(file('/a.ts')); await settle();
  u.writer.offer(file('/a.ts'), { force: true });
  fail({ ok: false, code: 'REQUEST_FAILED' });
  await settle(); await settle();
  assert.equal(u.sent.length, 2);
  u.writer.offer(file('/a.ts')); await settle();
  assert.equal(u.sent.length, 2);
});

test('two writers keep independent baselines', async () => {
  const a = setup();
  const b = setup();
  a.writer.offer(file('/a.ts')); b.writer.offer(file('/a.ts')); await settle();
  a.writer.offer(file('/a.ts')); await settle();
  b.writer.offer(sel(1)); b.writer.offer(file('/a.ts')); await settle(); await settle();
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 3);
});

test('nothing is written while disabled; disable drops pending work and the baseline', async () => {
  const t = setup();
  t.writer.disable();
  t.writer.offer(sel(1)); await settle();
  assert.equal(t.sent.length, 0);
  t.writer.enable();
  t.writer.offer(file('/a.ts')); await settle();
  t.writer.disable(); t.writer.enable();
  t.writer.offer(file('/a.ts')); await settle();
  assert.equal(t.sent.length, 2);
  let release;
  t.gates.push(new Promise((r) => { release = r; }));
  t.writer.offer(sel(1)); await settle();
  t.writer.offer(sel(2));
  t.writer.disable();
  release({ ok: true }); await settle(); await settle();
  assert.deepEqual(t.sent.map((m) => m.title).slice(2), ['t1']);
});

test('every result is reported, and a rejected send is a REQUEST_FAILED result', async () => {
  const t = setup();
  t.gates.push(Promise.resolve({ ok: false, code: 'VIEW_ONLY' }), () => Promise.reject(new Error('gone')));
  t.writer.offer(sel(1)); await settle();
  t.writer.offer(sel(2)); await settle();
  assert.deepEqual(t.results.map((r) => r.code ?? 'ok'), ['VIEW_ONLY', 'REQUEST_FAILED']);
});

const seqd = (chip, seq) => ({ ...chip, seq });

test('has(seq) is true after an offer of that seq, including a file chip the dedupe skipped', async () => {
  const t = setup();
  assert.equal(t.writer.has(1), false);
  t.writer.offer(seqd(file('/a.ts'), 1)); await settle();
  t.writer.offer(seqd(file('/a.ts'), 2)); await settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.writer.has(2), true);
  assert.equal(t.writer.has(3), false);
});

test('a failed write with nothing queued after it forgets the received seq; one with a newer write queued does not', async () => {
  const t = setup();
  t.gates.push(Promise.resolve({ ok: false, code: 'REQUEST_FAILED' }));
  t.writer.offer(seqd(sel(1), 1)); await settle();
  assert.equal(t.writer.has(1), false);

  const u = setup();
  let fail;
  u.gates.push(new Promise((r) => { fail = r; }));
  u.writer.offer(seqd(sel(1), 1)); await settle();
  u.writer.offer(seqd(sel(2), 2));
  fail({ ok: false, code: 'REQUEST_FAILED' });
  await settle(); await settle();
  assert.equal(u.sent.length, 2);
  assert.equal(u.writer.has(2), true);
});

test('disable forgets the received seq', async () => {
  const t = setup();
  t.writer.offer(seqd(sel(1), 1)); await settle();
  assert.equal(t.writer.has(1), true);
  t.writer.disable(); t.writer.enable();
  assert.equal(t.writer.has(1), false);
});

test('an offer while disabled records nothing, so the tab is still caught up later', async () => {
  const t = setup();
  t.writer.disable();
  t.writer.offer(seqd(sel(1), 1));
  t.writer.enable();
  assert.equal(t.writer.has(1), false);
});
