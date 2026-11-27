import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { renderHtml } = createRequire(import.meta.url)('../extension/src/view.js');

const base = { nonce: 'N0NCE', cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/media/webview.js' };
const csp = (html) => /Content-Security-Policy" content="([^"]*)"/.exec(html)[1];

test('frames are allowed only from cc\'s origin and scripts only with the nonce', () => {
  const html = renderHtml({ ...base, ccOrigin: 'http://127.0.0.1:8787', relayUrl: 'http://127.0.0.1:8787/plugins/code-vscode/relay' });
  const directives = csp(html).split('; ');
  assert.ok(directives.includes('frame-src http://127.0.0.1:8787'));
  assert.ok(directives.includes("script-src 'nonce-N0NCE'"));
  assert.ok(directives.includes("default-src 'none'"));
  assert.match(html, /<script nonce="N0NCE" src="vscode-resource:\/media\/webview\.js">/);
});

test('the relay frame is hidden and the cc frame loads the document when given one', () => {
  const html = renderHtml({ ...base, ccOrigin: 'http://h', relayUrl: 'http://h/r', documentUrl: 'http://h/plugins/code-vscode/?focus=s1' });
  assert.match(html, /<iframe id="relay"[^>]* hidden>/);
  assert.match(html, /<iframe id="cc" src="http:\/\/h\/plugins\/code-vscode\/\?focus=s1"/);
});

test('without a connection no frame is allowed and the message carries a Connect button', () => {
  const html = renderHtml({ ...base, message: 'Session <ended>' });
  assert.ok(csp(html).split('; ').includes("frame-src 'none'"));
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /Session &lt;ended&gt;/);
  assert.match(html, /id="connect"/);
});

test('URLs are escaped into attributes', () => {
  const html = renderHtml({ ...base, ccOrigin: 'http://h', relayUrl: 'http://h/r', documentUrl: 'http://h/?a="><script>x</script>' });
  assert.doesNotMatch(html, /<script>x/);
});

test('renderHtml puts the session id on body as data-session-id, empty when unbound', () => {
  const bound = renderHtml({ ...base, ccOrigin: 'http://h', relayUrl: 'http://h/r', sessionId: 's"1' });
  assert.match(bound, /<body[^>]* data-session-id="s&quot;1"/);
  assert.match(renderHtml({ ...base, message: 'x' }), /<body[^>]* data-session-id=""/);
});
