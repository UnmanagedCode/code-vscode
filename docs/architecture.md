# Architecture

```
VS Code extension host            webview (outer)                       cc
 connection ── view ── postMessage ─► webview.js ─┬─ iframe  cc document  ─► /plugins/code-vscode/?focus=<sid>
 chipSync ──► (chip writes)                       └─ iframe  relay (hidden) ─► /plugins/code-vscode/relay ─► cc REST (same origin)
```

## Components

| Path | Responsibility |
|---|---|
| `conductor.plugin.json` | cc plugin manifest: backend `node plugin/server.mjs`, health `/health`, no frontend |
| `plugin/server.mjs` | HTTP wiring: routes to embed / relay / health, reads `$PORT` and `$CONDUCTOR_URL` |
| `plugin/embed.mjs` | `ccRootFromPrefix`, `injectBase`, `embedCsp`, `serveDocument` |
| `plugin/relayCore.mjs` | relay logic, imported by the browser page and by node tests |
| `plugin/relay.mjs`, `relay.html` | browser glue and the relay page |
| `extension/src/extension.js` | wiring only |
| `extension/src/connection.js` | session choice, persistence, reconnect, status bar |
| `extension/src/view.js`, `media/webview.js` | webview HTML and CSP, message routing |
| `extension/src/chipSync.js`, `chipShape.js` | selection events → debounced writes; selection → `{title, data}` |

## Why the relay

- Every cc call (list, create, health, chip) is made by the browser context that already renders cc, from cc's own origin. One network path: whatever reaches cc for the embed reaches the API, including `asExternalUri`-forwarded ports.
- No CORS (cc sends none) and no host/webview location mismatch in a Remote window. The extension host makes no network calls.
- A separate relay frame leaves cc's UI untouched apart from `<base>`; the relay is the plugin's own testable code.
- Cost: chips flow only while the webview is alive, hence `retainContextWhenHidden`; the relay reporting ready triggers a push of the current state.

## Why `<base>` and the CSP rewrite

cc's document uses root-relative assets, so a document served at `/plugins/code-vscode/` needs `<base href="<ccRoot>/">`. cc's proxy removes cc's own framing headers for plugin responses and honors the plugin's `frame-ancestors`, so the plugin widens it to the VS Code webview sources.

## Security notes

- Any `vscode-webview:` / `vscode-file:` context may frame the document and relay pages, so any extension's webview can drive cc through them. cc's API is open to anything reaching its port, so this adds no reach.
- The embedded cc runs under cc's own `--ui` mode; `?focus` grants no control.
- The relay accepts parent messages only from a `vscode-webview:` origin; the outer webview accepts relay messages only from the relay frame at cc's origin and ignores the cc frame.

## Tests (`npm test`)

- Plain `node:test`, no dependencies; extension modules are CommonJS and imported through `createRequire`.
- Injected fakes: a fake upstream `http.Server` for the plugin, a fake `fetch` and message events for `relayCore`, fake editor event emitters with `mock.timers` for `chipSync`, a fake `vscode`, view and sync for `connection`.
- `tests/real-cc.smoke.test.mjs` is skipped unless `RUN_REAL_CC=1` and `CC_URL` are set.
- VS Code itself is not automated; the end-to-end check is manual in desktop VS Code.
