# Features

## The tab

- cc opens as an editor tab (`WebviewPanel`, view type `codeConductor.session`), so it can be split or dragged like any editor. One tab per window.
- Open it with the editor-title button (shown on file and untitled text editors: `activeEditor` is `workbench.editors.files.textFileEditor` or `workbench.editors.textResourceEditor`; hidden on the cc tab itself, diffs, notebooks, image previews and settings), **cc: Open**, or a click on the status bar item. A new tab opens beside the current editor; with a tab already open it is revealed, never duplicated.
- It keeps its state while hidden behind another tab of its group (`retainContextWhenHidden`), so chips keep flowing.
- A window reload restores the tab (serializer) and reconnects to the stored session.
- Closing the tab keeps the stored session and stops chip sync; the status bar shows `cc: tab closed` and reopening reconnects to the same session. A conductor that was never prompted is reaped by cc once its tab stays closed for longer than `PRISTINE_REAP_GRACE_MS` (60 s); reopening then shows "session ended".
- Not connected (or ended): text plus a **Connect** button.
- Connected: cc's conductor session for the stored session id, framed from `<cc>/plugins/code-vscode/?focus=<sid>`. The workers panel navigates normally.

## Commands and setting

| Item | Behavior |
|---|---|
| `codeConductor.open` (cc: Open) | Reveals the tab, creating it beside the current editor when closed; reconnects to the stored session with no picker. With no stored session it runs cc: Connect. Also the editor-title button and the status bar click. |
| `codeConductor.connect` (cc: Connect) | Opens the tab if needed, waits for the relay, lists live top-level conductors in a QuickPick plus "New conductor", stores the choice, shows it and pushes the current chip. |
| `codeConductor.disconnect` (cc: Disconnect) | Clears the chip, forgets the session id, shows the not-connected page. With the tab closed it only forgets the session: the relay is gone, so cc's chip is not cleared. |
| `codeConductor.serverUrl` | cc as seen from the machine the extension runs on. Default `http://127.0.0.1:8787`. |

- The session id is kept in `workspaceState` (`codeConductor.sessionId`): each window and workspace connects independently.
- When the tab opens or is restored with a stored id it reconnects without a picker.
- **New conductor** starts a conductor with cc's own New conductor request. It stays unlisted until its first prompt and is removed by cc if nothing views it; the tab views it immediately.
- If the relay does not report ready within 15 s an error names the URL and the likely causes (cc unreachable, plugin not enabled → 404, mixed content, login gate).

## Status bar

| State | Text |
|---|---|
| connected | `cc: <label>` |
| not connected | `cc: not connected` |
| closed | `cc: tab closed` — a session is stored but the tab is closed; chips do not sync |
| view-only | `cc: view-only (no chip)` — cc runs `--ui view`, or `--ui interact` for another session |
| session ended | `cc: session ended` — a chip write got `SESSION_NOT_LIVE`; the stored id is cleared and syncing stops |
| error | `cc: <code>` — e.g. `REQUEST_FAILED`, `RELAY_TIMEOUT` |

A notification appears once per state change, never once per write.

## Chip

The tracked editor is the last text editor whose state shapes to a chip. A state that shapes to nothing changes nothing.

| Editor state | Chip |
|---|---|
| Non-empty selection, any document scheme | Selection chip. Title `<basename>:<line>` for one line, `<basename>:<start>-<end> (<n> lines)` otherwise; lines are 1-based; a selection ending at column 0 of a later line excludes that line; a long name is truncated with `…`. Data: `path:` (file path, or the URI for non-file documents), `lines:`, `language:`, a blank line, then the selected text. Text past the chip data limit is cut with `… (truncated, <n> chars omitted)`; `path` (over 4096 characters) and `language` (over 256) are shortened with `…`, so the data never exceeds the limit. |
| Empty selection, `file` scheme, open document | File chip. Title `<basename>`. Data: `path:`, `language:`, a blank line and one line saying the file is open and its contents are not included. The path only: the conductor reads the saved file itself. |
| Empty selection, any other scheme (untitled, output, notebook cells, the original side of a diff) or a closed document | Nothing written; the chip stays. |
| No active text editor (the cc tab, a terminal, another webview) | Nothing written; the chip stays. |

- Debounce: 250 ms trailing (`SELECTION_DEBOUNCE_MS`). The flush shapes the editor that raised the event, so a selection made just before clicking into the cc tab is still written.
- ×: a file chip is skipped when the last queued write was a file chip for the same path, so clearing it in cc's composer sticks through cursor moves and typing in that file. A selection chip, a collapse back to the file chip, or switching to another file writes again. Selection chips are never deduped: re-selecting the same text sets it again. Connecting and the relay becoming ready write unconditionally. A failed write does not count as written.
- Notebooks give selection chips only (the cell's URI as `path:`).
- At most one write is in flight; newer states replace the pending one.
