// HTTP wiring only: routes to the embed document, the relay page and its scripts.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ccRootFromPrefix, frameAncestorsDirective, serveDocument } from './embed.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const RELAY_CSP = `default-src 'none'; script-src 'self'; connect-src 'self'; ${frameAncestorsDirective()}`;
const SCRIPTS = new Set(['/relay.mjs', '/relayCore.mjs']);

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

/** Builds the plugin server; `upstream` is cc's base URL (no trailing slash). */
export function createServer({ upstream, fetchImpl = fetch }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://plugin.invalid');
      const root = ccRootFromPrefix(req.headers['x-forwarded-prefix']);
      if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      if (pathname === '/' || pathname === '/index.html') return await serveDocument({ upstream, root, res, fetchImpl });
      if (pathname === '/health') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
      if (pathname === '/relay') {
        const html = (await readFile(here('relay.html'), 'utf8')).replace('__CC_ROOT__', root);
        return send(res, 200, 'text/html; charset=utf-8', html, { 'content-security-policy': RELAY_CSP });
      }
      if (SCRIPTS.has(pathname)) return send(res, 200, 'text/javascript; charset=utf-8', await readFile(here(`.${pathname}`)));
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', `plugin error: ${e?.message ?? e}`);
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const upstream = (process.env.CONDUCTOR_URL ?? '').replace(/\/+$/, '');
  const port = Number(process.env.PORT);
  if (!upstream) throw new Error('CONDUCTOR_URL is not set; run this as a cc plugin backend');
  if (!Number.isInteger(port)) throw new Error('PORT is not set; run this as a cc plugin backend');
  createServer({ upstream }).listen(port, '127.0.0.1');
}
