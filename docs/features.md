# Features

## The tab

- Each cc tab is an editor tab (`WebviewPanel`, view type `codeConductor.session`) showing one conductor session, so it can be split or dragged like any editor. A window can have several; a session has at most one.
- Open the picker with the editor-title button (shown on file and untitled text editors: `activeEditor` is `workbench.editors.files.textFileEditor` or `workbench.editors.textResourceEditor`; hidden on a cc tab itself, diffs, notebooks, image previews and settings), **cc: Open**, or a click on the status bar item.
- The picker lists the live top-level conductors in cc's order (status as description), then open tabs whose session is not listed (a new conductor is unlisted until its first prompt), then "New conductor". Sessions that have a tab are marked `· open`. Archived conductors are not listed.
  - A session with a tab: that tab is revealed.
  - Any other session: it opens in a new tab beside the current editor, or in the unbound tab the picker ran from.
  - New conductor: starts one with cc's own New conductor request and shows it in a tab. It stays unlisted until its first prompt and is removed by cc if nothing views it; the tab views it immediately.
- With no cc tab open the picker runs on a new tab; cancelling or a failed list/start closes it again.
- A tab's title is `cc: <label>`.
- A tab keeps its state while hidden behind another tab of its group (`retainContextWhenHidden`).
- A window reload restores every tab (serializer) and each reconnects to its own session. The session is kept in the panel's webview state, not in `workspaceState`.
- Closing a tab ends its binding. A conductor that was never prompted is reaped by cc once nothing views it for longer than `PRISTINE_REAP_GRACE_MS` (60 s).
- A tab with no session (restored without state) or whose session ended shows text plus a **Connect** button; the button runs the picker for that tab and a pick rebinds it in place. Cancelling leaves it as it was.

## Commands and setting

| Item | Behavior |
|---|---|
| `codeConductor.open` (cc: Open) | The picker above. Also the editor-title button and the status bar click. One picker at a time. |
| `codeConductor.serverUrl` | cc as seen from the machine the extension runs on. Default `http://127.0.0.1:8787`. |

- If the relay does not report ready within 15 s an error names the URL and the likely causes (cc unreachable, plugin not enabled → 404, mixed content, login gate); the tab shows a Connect page and keeps its session in its state for a reload.

## Status bar

One item, showing the last-active cc tab (the last one focused; the most recently created when it closes). Click opens the picker.

| State | Text |
|---|---|
| no cc tab | `cc: no tab open` |
| connected | `cc: <label>` |
| connecting | `cc: connecting` |
| no session in the tab | `cc: no conductor` |
| view-only | `cc: view-only (no chip)` — cc runs `--ui view`, or `--ui interact` for another session |
| session ended | `cc: session ended` — a chip write got `SESSION_NOT_LIVE`; the tab's syncing stops until it is rebound |
| error | `cc: <code>` — e.g. `REQUEST_FAILED`, `RELAY_TIMEOUT` |

A notification (prefixed with the tab's label) appears once per state change, never once per write.

## Chip

One chip per session, always replaced. The tracked editor is the last text editor whose state shapes to a chip. A state that shapes to nothing changes nothing.

| Editor state | Chip |
|---|---|
| Non-empty selection, any document scheme | Selection chip. Title `<basename>:<line>` for one line, `<basename>:<start>-<end> (<n> lines)` otherwise; lines are 1-based; a selection ending at column 0 of a later line excludes that line; a long name is truncated with `…`. Data: `path:` (file path, or the URI for non-file documents), `lines:`, `language:`, a blank line, then the selected text. Text past the chip data limit is cut with `… (truncated, <n> chars omitted)`; `path` (over 4096 characters) and `language` (over 256) are shortened with `…`, so the data never exceeds the limit. |
| Empty selection, `file` scheme, open document | File chip. Title `<basename>`. Data: `path:`, `language:`, a blank line and one line saying the file is open and its contents are not included. The path only: the conductor reads the saved file itself. |
| Empty selection, any other scheme (untitled, output, notebook cells, the original side of a diff) or a closed document | Nothing written; the chip stays. |
| No active text editor (the cc tab, a terminal, another webview) | Nothing written; the chip stays. |

- Debounce: 250 ms trailing (`SELECTION_DEBOUNCE_MS`). The flush shapes the editor that raised the event, so a selection made just before clicking into the cc tab is still written.
- Fan-out: a produced chip is written to every bound cc tab that is **visible at that moment** (`WebviewPanel.visible`: shown in its group, group visible). A hidden tab gets nothing then. **Catch-up:** when a tab goes hidden → visible it gets the last produced chip only if the editor that produced it (that editor, not another editor on the same document) is still in `visibleTextEditors`, is not in the tab's own editor group, and the tab has not already received that chip. Consequence: a cc tab in the same editor group as the file being edited is never caught up from it; put it in another group.
- ×: per tab. A file chip is skipped for a tab when the last queued write to it was a file chip for the same path, so clearing it in that tab's composer sticks through cursor moves and typing in that file; other tabs are unaffected. A selection chip, a collapse back to the file chip, or switching to another file writes again. Selection chips are never deduped: re-selecting the same text sets it again. A switch never brings back a chip the tab already received, including one cleared with ×; a catch-up file chip still obeys the per-tab file dedupe. A failed write does not count as written or received, so the next switch retries it.
- Connecting a tab (picker bind, restore) and its relay becoming ready write the current state unconditionally, but only when the tab is visible then.
- Notebooks give selection chips only (the cell's URI as `path:`).
- At most one write is in flight; newer states replace the pending one.
