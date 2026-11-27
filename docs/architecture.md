# Architecture

```
VS Code extension host            webview panel (editor tab, outer)                       cc
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
| `extension/src/extension.js` | wiring only: init, panel serializer, commands |
| `extension/src/connection.js` | session choice, persistence, reconnect, tab open/close state, status bar |
| `extension/src/view.js`, `media/webview.js` | the single `WebviewPanel` (create, reveal, restore via `serializer`, dispose), webview HTML and CSP, message routing |
| `extension/src/chipSync.js`, `chipShape.js` | editor events → debounced writes and the file-chip dedupe; editor state → `{kind, title, data}` |

## Why the relay

- Every cc call (list, create, health, chip) is made by the browser context that already renders cc, from cc's own origin. One network path: whatever reaches cc for the embed reaches the API, including `asExternalUri`-forwarded ports.
- No CORS (cc sends none) and no host/webview location mismatch in a Remote window. The extension host makes no network calls.
- A separate relay frame leaves cc's UI untouched apart from `<base>`; the relay is the plugin's own testable code.
- Cost: chips flow only while the tab exists (a closed tab has no relay) and is alive, hence `retainContextWhenHidden`; the relay reporting ready triggers a push of the current state.

## Why `<base>` and the CSP rewrite

cc's document uses root-relative assets, so a document served at `/plugins/code-vscode/` needs `<base href="<ccRoot>/">`. cc's proxy removes cc's own framing headers for plugin responses and honors the plugin's `frame-ancestors`, so the plugin widens it to the VS Code webview sources.

## Security notes

- Any `vscode-webview:` / `vscode-file:` context may frame the document and relay pages, so any extension's webview can drive cc through them. cc's API is open to anything reaching its port, so this adds no reach.
- The embedded cc runs under cc's own `--ui` mode; `?focus` grants no control.
- The relay accepts parent messages only from a `vscode-webview:` origin; the outer webview accepts relay messages only from the relay frame at cc's origin and ignores the cc frame.

## Tests (`npm test`)

- Plain `node:test`, no dependencies; extension modules are CommonJS and imported through `createRequire`.
- Injected fakes: a fake upstream `http.Server` for the plugin, a fake `fetch` and message events for `relayCore`, fake editor event emitters with `mock.timers` for `chipSync`, a fake `vscode`, view and sync for `connection`, a fake `createWebviewPanel` and panels for `view`; `tests/manifest.test.mjs` guards that the manifest's activation event and menu commands match the code.
- `tests/real-cc.smoke.test.mjs` is skipped unless `RUN_REAL_CC=1` and `CC_URL` are set.
- VS Code itself is not automated; the end-to-end check is manual in desktop VS Code.

## Tab lifecycle

- `connection.init()` runs at activation, before the serializer is registered, and sets the bar to `closed` (a session is stored) or `not-connected`; a restored tab's `resume()` then wins.
- `view` emits `resolve` when it adopts a panel (new or restored; `connection.resume()` reads the session id from `workspaceState`, the webview's own state is unused) and `close` when it is disposed (`connection.onClosed()`: sync disabled, stored id kept).
- A second restored panel while one is open is disposed.
- VS Code revives a hidden (background) webview tab only when it is first shown, so a never-prompted conductor in a tab hidden at reload can be reaped (the 60 s reap in `docs/protocol.md`); no API reveals it without making it the group's active editor.
