# Features

## The view

- View container `codeConductor` ("cc", bottom panel) holding the webview view `codeConductor.session`. It keeps its state while hidden (`retainContextWhenHidden`).
- Not connected (or ended): text plus a **Connect** button.
- Connected: cc's conductor session for the stored session id, framed from `<cc>/plugins/code-vscode/?focus=<sid>`. The workers panel navigates normally.

## Commands and setting

| Item | Behavior |
|---|---|
| `codeConductor.connect` (cc: Connect) | Reveals the view, waits for the relay, lists live top-level conductors in a QuickPick plus "New conductor", stores the choice, shows it and pushes the current selection. |
| `codeConductor.disconnect` (cc: Disconnect) | Clears the chip, forgets the session id, shows the not-connected view. |
| `codeConductor.serverUrl` | cc as seen from the machine the extension runs on. Default `http://127.0.0.1:8787`. |

- The session id is kept in `workspaceState` (`codeConductor.sessionId`): each window and workspace connects independently.
- When the view resolves with a stored id it reconnects without a picker.
- **New conductor** starts a conductor with cc's own New conductor request. It stays unlisted until its first prompt and is removed by cc if nothing views it; the panel views it immediately.
- If the relay does not report ready within 15 s an error names the URL and the likely causes (cc unreachable, plugin not enabled → 404, mixed content, login gate).

## Status bar

| State | Text |
|---|---|
| connected | `cc: <label>` |
| not connected | `cc: not connected` |
| view-only | `cc: view-only (no chip)` — cc runs `--ui view`, or `--ui interact` for another session |
| session ended | `cc: session ended` — a chip write got `SESSION_NOT_LIVE`; the stored id is cleared and syncing stops |
| error | `cc: <code>` — e.g. `REQUEST_FAILED`, `RELAY_TIMEOUT` |

A notification appears once per state change, never once per write.

## Selection → chip

- Source: the active editor's primary selection only.
- Title: `<basename>:<line>` for one line, `<basename>:<start>-<end> (<n> lines)` otherwise; lines are 1-based; a selection ending at column 0 of a later line excludes that line; a long name is truncated with `…`.
- Data: `path:` (file path, or the URI for non-file documents), `lines:`, `language:`, a blank line, then the selected text. Text past the chip data limit is cut with `… (truncated, <n> chars omitted)`.
- Debounce: 250 ms trailing (`SELECTION_DEBOUNCE_MS`). An empty selection clears the chip.
- Focus: the active editor becoming undefined (focus moved to the cc panel, a terminal, another webview) changes nothing.
- ×: clearing the chip in cc's composer needs no handling here; the next selection change sets it again, even for the same text (no dedupe).
- At most one write is in flight; newer states replace the pending one.
