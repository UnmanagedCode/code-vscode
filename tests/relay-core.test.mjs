import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../plugin/relayCore.mjs';

const PARENT = { id: 'parent' };
const ORIGIN = 'vscode-webview://abc123';

// A fake cc: `routes` maps "METHOD path" to a response ({status, json}) or a function of the request.
function fakeCc(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url, body });
    const handler = routes[`${method} ${url}`];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    const r = typeof handler === 'function' ? handler({ body }) : handler;
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => { if (r.json === undefined) throw new Error('no body'); return r.json; } };
  };
  return { fetch, calls };
}

function harness(routes, opts = {}) {
  const cc = fakeCc(routes);
  const replies = [];
  const relay = createRelay({ fetch: cc.fetch, root: opts.root ?? '', parent: PARENT, timeoutMs: opts.timeoutMs });
  const source = { postMessage: (msg, origin) => replies.push({ msg, origin }) };
  const send = async (data, over = {}) => {
    await relay.onMessage({ source: over.source ?? PARENT, origin: over.origin ?? ORIGIN, data });
  };
  // Message events from PARENT answer through PARENT.postMessage.
  PARENT.postMessage = source.postMessage;
  return { cc, relay, replies, send, last: () => replies.at(-1)?.msg };
}

const FULL = { 'GET /api/health': { json: { ok: true, uiMode: 'full' } } };

test('only the parent window from a vscode-webview origin is answered; replies go to that origin', async () => {
  const h = harness({ ...FULL, 'GET /api/instances': { json: [] } });
  await h.send({ reqId: '1', op: 'listConductors' }, { origin: 'https://evil.example' });
  await h.send({ reqId: '2', op: 'listConductors' }, { origin: 'null' });
  await h.send({ reqId: '3', op: 'listConductors' }, { source: { postMessage() { throw new Error('must not reply'); } } });
  assert.equal(h.replies.length, 0);
  assert.equal(h.cc.calls.length, 0);
  await h.send({ reqId: '4', op: 'listConductors' });
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].origin, ORIGIN);
});

test('malformed or unknown requests are ignored', async () => {
  const h = harness(FULL);
  await h.send({ op: 'listConductors' });
  await h.send({ reqId: 'x', op: 'constructor' });
  await h.send({ reqId: 'x', op: 'rm -rf' });
  await h.send(null);
  assert.equal(h.replies.length, 0);
});

test('listConductors keeps live top-level conductors only', async () => {
  const row = (o) => ({ id: o.sessionId, project: '.conduct', conducted: false, status: 'idle', displayLabel: o.sessionId, ...o });
  const h = harness({ 'GET /api/instances': { json: [
    row({ sessionId: 'live', displayLabel: 'Live one', status: 'busy' }),
    row({ sessionId: 'lead', conducted: true }),
    row({ sessionId: 'gone', status: 'exited' }),
    row({ sessionId: 'dead', status: 'crashed' }),
    row({ sessionId: 'other', project: 'app' }),
    row({ sessionId: null }),
  ] } });
  await h.send({ reqId: '1', op: 'listConductors' });
  assert.deepEqual(h.last(), { type: 'result', reqId: '1', ok: true, value: [{ sessionId: 'live', displayLabel: 'Live one', status: 'busy' }] });
});

test('newConductor posts cc\'s own New conductor body, pristine included, and returns the session id from the response', async () => {
  const h = harness({ 'POST /api/instances': { status: 201, json: { id: 'i1', sessionId: 's1', pristine: true } } });
  await h.send({ reqId: '1', op: 'newConductor' });
  assert.deepEqual(h.cc.calls[0].body, { project: '.conduct', role: 'conductor', mode: 'bypassPermissions', pristine: true });
  assert.deepEqual(h.last().value, { sessionId: 's1' });
});

test('newConductor reports HOST_ERROR when cc answers without a session id, and passes cc\'s errors through', async () => {
  const h = harness({ 'POST /api/instances': { status: 201, json: { id: 'i1', sessionId: null } } });
  await h.send({ reqId: '1', op: 'newConductor' });
  assert.equal(h.last().code, 'HOST_ERROR');
  const bad = harness({ 'POST /api/instances': { status: 400, json: { error: 'x', code: 'INVALID_ARGUMENT' } } });
  await bad.send({ reqId: '1', op: 'newConductor' });
  assert.equal(bad.last().code, 'INVALID_ARGUMENT');
});

test('health reports the UI mode and the focused session', async () => {
  const h = harness({ 'GET /api/health': { json: { uiMode: 'interact', focus: { sessionId: 'f' } } } });
  await h.send({ reqId: '1', op: 'health' });
  assert.deepEqual(h.last().value, { uiMode: 'interact', focusSessionId: 'f' });
});

test('setChip PUTs title and data; clearChip DELETEs without rev; both under cc\'s base path', async () => {
  const h = harness({
    ...FULL,
    'PUT /cc/api/sessions/s%201/chip': { json: { ok: true } },
    'DELETE /cc/api/sessions/s%201/chip': { json: { ok: true, cleared: true } },
    'GET /cc/api/health': { json: { uiMode: 'full' } },
  }, { root: '/cc' });
  await h.send({ reqId: '1', op: 'setChip', sid: 's 1', title: 'a.ts:1', data: 'body' });
  assert.deepEqual(h.last(), { type: 'result', reqId: '1', ok: true });
  const put = h.cc.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { title: 'a.ts:1', data: 'body' });
  await h.send({ reqId: '2', op: 'clearChip', sid: 's 1' });
  assert.deepEqual(h.last(), { type: 'result', reqId: '2', ok: true });
  const del = h.cc.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.body, undefined);
  assert.doesNotMatch(del.url, /rev/);
});

test("cc's own error code passes through unchanged", async () => {
  const h = harness({
    ...FULL,
    'PUT /api/sessions/s/chip': { status: 404, json: { error: 'no live session', code: 'SESSION_NOT_LIVE' } },
    'DELETE /api/sessions/s/chip': { status: 400, json: { error: 'bad', code: 'INVALID_ARGUMENT' } },
  });
  await h.send({ reqId: '1', op: 'setChip', sid: 's', title: 't', data: 'd' });
  assert.equal(h.last().code, 'SESSION_NOT_LIVE');
  await h.send({ reqId: '2', op: 'clearChip', sid: 's' });
  assert.equal(h.last().code, 'INVALID_ARGUMENT');
});

test('a non-2xx answer without a code is HOST_ERROR; a network error is REQUEST_FAILED', async () => {
  const h = harness({
    ...FULL,
    'PUT /api/sessions/a/chip': { status: 500, json: undefined },
    'PUT /api/sessions/b/chip': () => new TypeError('fetch failed'),
  });
  await h.send({ reqId: '1', op: 'setChip', sid: 'a', title: 't', data: 'd' });
  assert.equal(h.last().code, 'HOST_ERROR');
  await h.send({ reqId: '2', op: 'setChip', sid: 'b', title: 't', data: 'd' });
  assert.equal(h.last().code, 'REQUEST_FAILED');
});

test('a request that outlives the timeout is REQUEST_FAILED', async () => {
  const relay = createRelay({
    fetch: (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))),
    root: '', parent: PARENT, timeoutMs: 5,
  });
  const replies = [];
  PARENT.postMessage = (msg) => replies.push(msg);
  await relay.onMessage({ source: PARENT, origin: ORIGIN, data: { reqId: '1', op: 'listConductors' } });
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].code, 'REQUEST_FAILED');
});

test('under --ui view, chip writes are refused without reaching cc', async () => {
  const h = harness({ 'GET /api/health': { json: { uiMode: 'view' } } });
  await h.send({ reqId: '1', op: 'setChip', sid: 's', title: 't', data: 'd' });
  await h.send({ reqId: '2', op: 'clearChip', sid: 's' });
  assert.equal(h.replies[0].msg.code, 'VIEW_ONLY');
  assert.equal(h.replies[1].msg.code, 'VIEW_ONLY');
  assert.deepEqual(h.cc.calls.map((c) => c.method), ['GET']);
});

test('under --ui interact, only the focused session takes a chip', async () => {
  const h = harness({
    'GET /api/health': { json: { uiMode: 'interact', focus: { sessionId: 'focused' } } },
    'PUT /api/sessions/focused/chip': { json: { ok: true } },
  });
  await h.send({ reqId: '1', op: 'setChip', sid: 'other', title: 't', data: 'd' });
  assert.equal(h.last().code, 'VIEW_ONLY');
  await h.send({ reqId: '2', op: 'setChip', sid: 'focused', title: 't', data: 'd' });
  assert.equal(h.last().ok, true);
});

test('after start(), the first gated op makes exactly one cc call, and health is never read again', async () => {
  const h = harness({ ...FULL, 'PUT /api/sessions/s/chip': { json: { ok: true } }, 'DELETE /api/sessions/s/chip': { json: { ok: true } } });
  const started = await h.relay.start();
  assert.equal(started.ok, true);
  assert.equal(h.cc.calls.length, 1);
  await h.send({ reqId: '1', op: 'setChip', sid: 's', title: 't', data: 'd' });
  assert.deepEqual(h.cc.calls.slice(1).map((c) => c.method), ['PUT']);
  await h.send({ reqId: '2', op: 'clearChip', sid: 's' });
  assert.deepEqual(h.cc.calls.slice(1).map((c) => c.method), ['PUT', 'DELETE']);
});

test('start() reports a failed health read, and the gate then refuses chip writes without reaching cc', async () => {
  const h = harness({ 'GET /api/health': () => new TypeError('down'), 'PUT /api/sessions/s/chip': { json: { ok: true } } });
  const started = await h.relay.start();
  assert.equal(started.ok, false);
  assert.equal(started.code, 'REQUEST_FAILED');
  await h.send({ reqId: '1', op: 'setChip', sid: 's', title: 't', data: 'd' });
  assert.equal(h.last().code, 'REQUEST_FAILED');
  assert.equal(h.cc.calls.some((c) => c.method === 'PUT'), false);
});
