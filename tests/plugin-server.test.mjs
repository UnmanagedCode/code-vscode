import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../plugin/server.mjs';
import { FRAME_ANCESTOR_SOURCES } from '../plugin/embed.mjs';

const CC_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>cc</title></head><body>cc</body></html>';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });

let upstreamBehavior;
let upstream, plugin, base;

before(async () => {
  upstream = http.createServer((req, res) => upstreamBehavior(req, res));
  const upPort = await listen(upstream);
  plugin = createServer({ upstream: `http://127.0.0.1:${upPort}` });
  base = `http://127.0.0.1:${await listen(plugin)}`;
});
after(async () => { await close(plugin); await close(upstream); });

const okUpstream = (csp = "frame-ancestors 'self'") => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' });
  res.end(CC_HTML);
};

const directives = (csp) => csp.split(';').map((d) => d.trim());

test('the document carries <base href="/"> as the first child of <head>, also with a ?focus query', async () => {
  upstreamBehavior = okUpstream();
  for (const path of ['/', '/?focus=abc', '/index.html']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<head><base href="\/">/);
  }
});

test('the base follows the proxy prefix, so a cc under a base path resolves its assets there', async () => {
  upstreamBehavior = okUpstream();
  const res = await fetch(base + '/', { headers: { 'x-forwarded-prefix': '/cc/plugins/code-vscode' } });
  assert.match(await res.text(), /<head><base href="\/cc\/">/);
});

test('a hostile prefix never reaches the HTML', async () => {
  upstreamBehavior = okUpstream();
  const res = await fetch(base + '/', { headers: { 'x-forwarded-prefix': '/"><script>x</script>/plugins/code-vscode' } });
  const html = await res.text();
  assert.match(html, /<base href="\/">/);
  assert.doesNotMatch(html, /<script>x/);
});

test('frame-ancestors is exactly cc self plus the VS Code sources; other upstream directives survive; no X-Frame-Options', async () => {
  upstreamBehavior = okUpstream("default-src 'self'; frame-ancestors 'self'; img-src data:");
  const res = await fetch(base + '/');
  const ds = directives(res.headers.get('content-security-policy'));
  const fa = ds.filter((d) => d.startsWith('frame-ancestors'));
  assert.deepEqual(fa, [`frame-ancestors ${FRAME_ANCESTOR_SOURCES.join(' ')}`]);
  assert.ok(ds.includes("default-src 'self'") && ds.includes('img-src data:'));
  assert.equal(res.headers.get('x-frame-options'), null);
});

test('an upstream CSP without frame-ancestors gets the directive appended', async () => {
  upstreamBehavior = okUpstream("default-src 'self'");
  const ds = directives((await fetch(base + '/')).headers.get('content-security-policy'));
  assert.ok(ds.includes("default-src 'self'"));
  assert.ok(ds.includes(`frame-ancestors ${FRAME_ANCESTOR_SOURCES.join(' ')}`));
});

test('the document is never sniffed or cached', async () => {
  upstreamBehavior = okUpstream();
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('an upstream that answers 500 gives 502 naming the status', async () => {
  upstreamBehavior = (_req, res) => { res.writeHead(500); res.end('boom'); };
  const res = await fetch(base + '/');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /500/);
});

test('an upstream document without <head> gives 502 instead of a broken page', async () => {
  upstreamBehavior = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>x</body></html>'); };
  assert.equal((await fetch(base + '/')).status, 502);
});

test('an unreachable upstream gives 502', async () => {
  const dead = http.createServer();
  const port = await listen(dead);
  await close(dead);
  const orphan = createServer({ upstream: `http://127.0.0.1:${port}` });
  const orphanBase = `http://127.0.0.1:${await listen(orphan)}`;
  try {
    const res = await fetch(orphanBase + '/');
    assert.equal(res.status, 502);
    assert.match(await res.text(), /unreachable/);
  } finally { await close(orphan); }
});

test('/relay is framable by VS Code, locked to its own scripts and origin, and names cc\'s root', async () => {
  const res = await fetch(base + '/relay', { headers: { 'x-forwarded-prefix': '/cc/plugins/code-vscode' } });
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, new RegExp(`frame-ancestors ${FRAME_ANCESTOR_SOURCES.join(' ')}$`));
  const html = await res.text();
  assert.match(html, /data-cc-root="\/cc"/);
  assert.doesNotMatch(html, /<base/i);
  assert.equal((await (await fetch(base + '/relay')).text()).match(/data-cc-root="([^"]*)"/)[1], '');
});

test('the relay scripts are served as JavaScript', async () => {
  for (const path of ['/relay.mjs', '/relayCore.mjs']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('/health answers ok and an unknown path answers 404', async () => {
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/relayCore.mjs/../server.mjs')).status, 404);
});
