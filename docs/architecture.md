# Architecture

```
VS Code extension host            webview panels (one editor tab per session)             cc
 tabs ─┬─ tab+view ─ postMessage ─► webview.js ─┬─ iframe  cc document  ─► /plugins/code-vscode/?focus=<sid>
       ├─ tab+view ─ postMessage ─► webview.js  └─ iframe  relay (hidden) ─► /plugins/code-vscode/relay ─► cc REST (same origin)
 chipSync ─► tabs.onChip ─► visible tabs' chipWriter ─► (chip writes)           (each panel has both frames)
```

## Components

| Path | Responsibility |
|---|---|
| `conductor.plugin.json` | cc plugin manifest: backend `node plugin/server.mjs`, health `/health`, no frontend |
| `plugin/server.mjs` | HTTP wiring: routes to embed / relay / health, reads `$PORT` and `$CONDUCTOR_URL` |
| `plugin/embed.mjs` | `ccRootFromPrefix`, `injectBase`, `embedCsp`, `serveDocument` |
| `plugin/relayCore.mjs` | relay logic, imported by the browser page and by node tests |
| `plugin/relay.mjs`, `relay.html` | browser glue and the relay page |
| `extension/src/extension.js` | wiring only: `activate(context, vscode)` builds the chip source and the registry, registers the serializer and `codeConductor.open` |
| `extension/src/tabs.js` | registry of tabs (`all`, `bySid`), the picker flow (`open`), the serializer, chip fan-out (`onChip`, `pushTo`), the status bar |
| `extension/src/tab.js` | one tab's session lifecycle: start/bind, relay readiness (`RELAY_READY_TIMEOUT_MS`), states, `unbind`, chip results |
| `extension/src/view.js`, `media/webview.js` | one panel's channel (`createTabView`: ready flag, pending requests, render, visibility), `createPanel`, webview HTML and CSP, message routing; `webview.js` persists the session as webview state |
| `extension/src/chipSync.js`, `chipShape.js` | the chip source: editor events → debounced chips (each carries a `seq`), `refresh()`, `latestShown(column)` (catch-up source); editor state → `{kind, title, data}` |
| `extension/src/chipWriter.js` | one session's write queue: one write in flight, newest pending wins, file-chip dedupe, the last received `seq` (`has`) |
| `extension/src/picker.js`, `endpoints.js`, `migrations.js` | picker items and prompt; relay/document URLs from `serverUrl`; legacy-state migration |

## Why the relay

- Every cc call (list, create, health, chip) is made by the browser context that already renders cc, from cc's own origin. One network path: whatever reaches cc for the embed reaches the API, including `asExternalUri`-forwarded ports.
- No CORS (cc sends none) and no host/webview location mismatch in a Remote window. The extension host makes no network calls.
- A separate relay frame leaves cc's UI untouched apart from `<base>`; the relay is the plugin's own testable code.
- Cost: chips flow only to a tab that exists (a closed tab has no relay) and is alive, hence `retainContextWhenHidden`, and only while it is visible, plus catch-up when shown later under the rule in `docs/features.md` (Chip); the relay reporting ready triggers a push to that tab when it is visible. The picker's list call also needs a tab's relay, so it runs on a ready tab or on a transient new one.

## Why `<base>` and the CSP rewrite

cc's document uses root-relative assets, so a document served at `/plugins/code-vscode/` needs `<base href="<ccRoot>/">`. cc's proxy removes cc's own framing headers for plugin responses and honors the plugin's `frame-ancestors`, so the plugin widens it to the VS Code webview sources.

## Security notes

- Any `vscode-webview:` / `vscode-file:` context may frame the document and relay pages, so any extension's webview can drive cc through them. cc's API is open to anything reaching its port, so this adds no reach.
- The embedded cc runs under cc's own `--ui` mode; `?focus` grants no control.
- The relay accepts parent messages only from a `vscode-webview:` origin; the outer webview accepts relay messages only from the relay frame at cc's origin and ignores the cc frame.

## Tests (`npm test`)

- Plain `node:test`, no dependencies; extension modules are CommonJS and imported through `createRequire`.
- Injected fakes: a fake upstream `http.Server` for the plugin, a fake `fetch` and message events for `relayCore`, fake editor event emitters with `mock.timers` for `chipSync`, `tests/fakes/vscode.mjs` (`createFakeVscode`: panels with settable `visible`/`active`, scripted quick picks, a scripted relay behind `postMessage`, editor emitters, `window.visibleTextEditors`, per-panel `viewColumn`) for `tabs`, `view` and the wiring test; fake view and writer for `tab`; `media/webview.js` run in `node:vm`; `tests/extension-wiring.test.mjs` drives the real `activate()` (command → picker → panel → relay → chip); `tests/manifest.test.mjs` guards that the manifest's activation event, menu commands and contributed commands match the code.
- `tests/real-cc.smoke.test.mjs` is skipped unless `RUN_REAL_CC=1` and `CC_URL` are set.
- VS Code itself is not automated; the end-to-end check is manual in desktop VS Code.

## Tab lifecycle

- A tab is **bound** when it has a session (`tab.sid`, and an entry in `tabs`' `bySid`) and **unbound** otherwise (the transient picker host, a restored panel with no state, an ended tab). Invariant: at most one tab per session; every bind goes through `bindTab`, which reveals the existing tab instead of binding a second.
- Creation: the picker's `openNew` creates a panel bound from its first render (`documentUrl` and `sessionId` in the first `load`), so its webview state names the session from the start. Binding an unbound tab uses its loaded relay: `setDocument(url, sid)` posts `showDocument`, and `webview.js` stores the session.
- Picker host: the `target` tab, else the last-active ready tab, else any ready tab, else a new transient tab. A host without a loaded relay loads one first. A transient host is disposed on cancel or failure; an unbound target gets its message page back.
- Visibility: `view.isVisible()` reads `panel.visible` at the moment of use. A hidden → visible transition (tracked per tab in `adopt`) calls `catchUp`; any other view-state change only updates the last-active tab.
- `view` emits `ready`, `connect`, `viewState` and `close`. On `close` the tab is disposed (its generation bumped so an in-flight start/bind abandons its steps, its writer disabled), removed from the registry, and the status bar recomputed. No chip is cleared: the relay is gone.
- Ended: `SESSION_NOT_LIVE` from a chip write calls `tab.unbind('ended')`: writer disabled, session released, the page shows `Session ended.` with the button, and the re-render stores `sessionId: null` so a reload restores it unbound.
- Restore (`tabs.serializer`): `state.sessionId` not yet bound → adopt and `tab.start(sid)`; already bound → dispose the restored panel; no `sessionId` → try the legacy migration, else adopt unbound. VS Code revives a hidden (background) tab only when it is first shown, so a never-prompted conductor in a tab hidden at reload can be reaped (the 60 s reap in `docs/protocol.md`); no API reveals it without making it the group's active editor.

## On-disk state

- Webview state per panel (`{sessionId}`), owned by VS Code, written by `media/webview.js`.
- `workspaceState` key `codeConductor.sessionId` belonged to the single-tab extension. Migration: `takeLegacySessionId` (`migrations.js`) runs when a restored panel has no `sessionId` in its state (the one pre-upgrade tab): it returns the stored id and deletes the key, so it applies once and later stateless restores are unbound. It runs at restore, not at startup, because a background panel's state is only available when VS Code revives it. A leftover key whose tab was closed before the upgrade is never read.
