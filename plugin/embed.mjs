// The embed document: cc's own `/` page, re-served under the plugin prefix so a
// VS Code webview may frame it.

/** The plugin's id; the proxy prefix this plugin is served under ends with `/plugins/<id>`. */
export const PLUGIN_ID = 'code-vscode';

/** The framing sources admitted next to cc's own origin: desktop VS Code webview and file contexts. */
export const FRAME_ANCESTOR_SOURCES = ["'self'", 'vscode-webview:', 'vscode-file:'];

const FRAME_ANCESTORS_DIRECTIVE = /^\s*frame-ancestors(?=\s|$)/i;
// A cc base path is a plain path; anything else is not interpolated into HTML.
const SAFE_ROOT = /^(?:\/[A-Za-z0-9._~%-]+)*$/;

/** The frame-ancestors directive this plugin sends. */
export function frameAncestorsDirective() {
  return `frame-ancestors ${FRAME_ANCESTOR_SOURCES.join(' ')}`;
}

/** cc's base path ('' at the root, '/cc' under CC_BASE_PATH) from the proxy's X-Forwarded-Prefix. */
export function ccRootFromPrefix(prefix) {
  const value = String(prefix ?? '').trim().replace(/\/+$/, '');
  const suffix = `/plugins/${PLUGIN_ID}`;
  const root = value.endsWith(suffix) ? value.slice(0, -suffix.length) : '';
  return SAFE_ROOT.test(root) ? root : '';
}

/** `html` with `<base href="<root>/">` as the first child of `<head>`, or null when it has no `<head>`. */
export function injectBase(html, root) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return null;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}<base href="${root}/">${html.slice(at)}`;
}

/** Upstream's CSP with its frame-ancestors directive replaced (or appended when it has none). */
export function embedCsp(upstreamCsp) {
  const directives = String(upstreamCsp ?? '').split(';').map((d) => d.trim()).filter(Boolean);
  const mine = frameAncestorsDirective();
  if (!directives.some((d) => FRAME_ANCESTORS_DIRECTIVE.test(d))) return [...directives, mine].join('; ');
  return directives.map((d) => (FRAME_ANCESTORS_DIRECTIVE.test(d) ? mine : d)).join('; ');
}

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

/** Serves cc's document with the base injected and the framing policy widened; 502 when it cannot. */
export async function serveDocument({ upstream, root, res, fetchImpl = fetch }) {
  let page;
  try {
    page = await fetchImpl(`${upstream}/`, { headers: { accept: 'text/html' } });
  } catch (e) {
    plain(res, 502, `cc is unreachable at ${upstream}: ${e?.message ?? e}`);
    return;
  }
  if (page.status !== 200) {
    plain(res, 502, `cc answered ${page.status} for its document at ${upstream}/`);
    return;
  }
  const body = injectBase(await page.text(), root);
  if (body === null) {
    plain(res, 502, 'cc\'s document has no <head>; cannot inject <base>');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': embedCsp(page.headers.get('content-security-policy')),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(body);
}
