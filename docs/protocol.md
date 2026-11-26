# Protocol

## Plugin routes (`plugin/server.mjs`, served by cc under `/plugins/code-vscode/`)

| Route | Response |
|---|---|
| `GET /`, `/index.html` (any query) | cc's `/` document from `$CONDUCTOR_URL`, with `<base href="<ccRoot>/">` as first child of `<head>`. 502 `text/plain` if cc is unreachable, answers non-200, or the document has no `<head>`. |
| `GET /relay` | The relay page. No `<base>`; `data-cc-root="<ccRoot>"` on `<html>`. |
| `GET /relay.mjs`, `/relayCore.mjs` | Relay scripts, `text/javascript`. |
| `GET /health` | `ok` (the manifest's `healthPath`). |
| other | 404; non-GET 405. |

- `ccRoot`: `X-Forwarded-Prefix` (set by cc's plugin proxy) minus the trailing `/plugins/code-vscode`; empty at the root, `/cc` under `CC_BASE_PATH=/cc`. Values that are not plain paths are treated as empty.
- Document headers: `content-security-policy` is cc's own with its `frame-ancestors` directive replaced by `frame-ancestors 'self' vscode-webview: vscode-file:` (`FRAME_ANCESTOR_SOURCES` in `plugin/embed.mjs`; appended when cc sent none; other directives kept); no `x-frame-options`; `x-content-type-options: nosniff`; `cache-control: no-store`.
- Relay headers: `default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors <same sources>`, `nosniff`, `no-store`.
- The manifest declares a backend and no `frontend`, so cc's app switcher has no entry for it; cc's proxy still serves the routes for any enabled plugin with a backend.

## Relay messages (`plugin/relayCore.mjs`)

The relay accepts window messages only from `window.parent` with an origin whose scheme is `vscode-webview:`, and replies to that origin. On load it reads `GET api/health` once, then posts `{type: 'ready'}`. If that read fails no `ready` is posted, so the extension reports the relay as unreachable (`RELAY_TIMEOUT`).

Request `{reqId, op, ...args}`; response `{type: 'result', reqId, ok: true, value?}` or `{type: 'result', reqId, ok: false, code, error}`.

| `op` | cc call | `value` |
|---|---|---|
| `listConductors` | `GET api/instances`, keeping rows with `project === '.conduct'`, not `conducted`, `status` not `exited`/`crashed`, and a `sessionId` (cc's `isTopLevelConductor`, `shared/conductors.ts`) | `[{sessionId, displayLabel, status}]` |
| `newConductor` | `POST api/instances` `{project: '.conduct', role: 'conductor', mode: 'bypassPermissions', pristine: true}` (cc's `newConductorSpawnBody('code')`) | `{sessionId}` from the response |
| `health` | `GET api/health` | `{uiMode, focusSessionId}` |
| `setChip {sid, title, data}` | `PUT api/sessions/<sid>/chip` | none |
| `clearChip {sid}` | `DELETE api/sessions/<sid>/chip` without `rev` | none |

- View-only gate: chip ops answer `VIEW_ONLY` without writing when `uiMode === 'view'`, or `'interact'` and `focusSessionId !== sid` (cc's `sessionViewOnly`, `shared/viewOnly.ts`). The mode read at load is the only health read, so every op makes exactly one cc call and its worst case (the relay's 10 s timeout) stays below the extension's 12 s request timeout.
- Codes: cc's pass through (`SESSION_NOT_LIVE`, `INVALID_ARGUMENT`); the relay adds `VIEW_ONLY`, `REQUEST_FAILED` (network error or 10 s timeout) and `HOST_ERROR` (non-2xx with no `code`, or a conductor started without a session id).
- Chip limits (title 200 characters, data 256 KiB) are cc's `CHIP_TITLE_MAX` / `CHIP_DATA_MAX` in `src/contextChip.ts`, duplicated in `extension/src/chipShape.js`.

## What reaps a new conductor

- A pristine conductor (before its first prompt) is unlisted in `GET /api/instances` and kept alive only by websocket viewers (`pristine_view`), tracked by cc's `PristineTracker` (`src/pristine.ts`).
- With no viewer it is abandoned: at once on `pristine_leave`, after `PRISTINE_REAP_GRACE_MS` (60 s) after a socket close or when nothing ever viewed it. Abandoned with a blank draft it is reaped.
- The panel's embedded cc under `?focus=<sid>` registers as a viewer, so showing the conductor right after `newConductor` keeps it; chip writes have no effect on reaping.
- Consequence: absence from `listConductors` never means ended; only `SESSION_NOT_LIVE` does.

## Webview ↔ extension messages (`extension/media/webview.js`, `extension/src/view.js`)

| Direction | Message |
|---|---|
| extension → webview | `{type: 'relayRequest', msg: {reqId, op, ...}}`; `{type: 'showDocument', url}` (applied only for cc's origin) |
| webview → extension | `{type: 'relayReady'}`; `{type: 'relayResult', msg}` (only from the relay frame with cc's origin); `{type: 'connect'}` (Connect button) |

- Extension → relay uses an explicit target origin (cc's). The extension times a request out at 12 s (`REQUEST_TIMEOUT_MS`), above the relay's 10 s.
- Webview CSP: `default-src 'none'; frame-src <ccOrigin>` (or `'none'`); `script-src 'nonce-<n>'`; `style-src <cspSource> 'unsafe-inline'`.
- Messages from the embedded cc frame are ignored.

## cc routes relied on

`GET /api/instances` (fields `id`, `sessionId`, `project`, `conducted`, `status`, `displayLabel`), `POST /api/instances`, `GET /api/health` (`uiMode`, `focus.sessionId`), `PUT`/`DELETE /api/sessions/:sid/chip`, and the plugin proxy. The gated smoke test (`tests/real-cc.smoke.test.mjs`) catches drift.
