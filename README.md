# code-vscode

A [cc](https://github.com/UnmanagedCode/code-conductor) plugin plus a VS Code extension. The extension shows cc conductor sessions in VS Code editor tabs, one session per tab; the live editor selection, or the active file when nothing is selected, becomes the context chip of the sessions in the visible tabs, so the next prompt carries what you were looking at.

## What you get

- `cc` editor tabs, each embedding one conductor without cc's sidebar; split or drag them like any editor. **cc: Open** (also the editor-title button and the status bar) shows a picker of the live conductors plus "New conductor": a session that already has a tab is revealed, any other opens in a new tab. Each tab reconnects to its own session on reload.
- Select text in any editor and the chip `file.ts:12-18 (7 lines)` appears in the composer, with the selected code as its data. With nothing selected the chip names the active file (path only).
- A status bar item shows the last-active cc tab's state (`cc: <label>`, `no tab open`, `view-only (no chip)`, `session ended`, or an error code).

Details: [docs/features.md](docs/features.md).

## Quick start

1. **Plugin.** Put this repo in cc's projects root (`PROJECTS_ROOT`) as a project or clone. In cc: Settings → Plugins → Rescan → Enable `code-vscode`. Its backend starts lazily on the tab's first request.
2. **Extension.** `make install` builds `extension/code-vscode-<version>.vsix` and installs it with the `code` CLI. Without `code` on PATH, run `make package` and use Extensions → "Install from VSIX…".
3. Set `codeConductor.serverUrl` (default `http://127.0.0.1:8787`, cc's standard local URL) to cc as seen from the machine the extension runs on.
4. Run **cc: Open** (or click the editor-title button).

## Supported setups

- A local cc.
- A cc forwarded to loopback: `ssh -L 8787:127.0.0.1:8787 <host>` with the default URL, or in a VS Code Remote window the host's loopback URL (`asExternalUri` forwards it).
- Any HTTPS cc URL that needs no login.

## Known limitations

- code-hub shares behind its login are unsupported (its `hub_auth` cookie is `SameSite=Lax`, which Chromium drops in the tab's cross-site iframe).
- Plain `http://` on a non-loopback address is unsupported (presumed blocked as mixed content).
- Desktop VS Code only; browser-hosted VS Code (vscode.dev, code-server) is untested and not admitted.
- Chips reach only visible cc tabs. A tab shown later gets the chip it missed only if the editor that produced it is still visible and the tab didn't already get it. A cc tab in the same editor group as the file is therefore never caught up from it, and a chip cleared with × does not return on a switch.
- After a reload, a session whose background tab has not been shown yet opens a second tab when picked; the stale tab closes when shown.
- Only the primary selection of a multi-cursor selection is chipped; no path mapping for a remote cc.
- A never-prompted conductor whose cc tab is closed, or hidden behind another tab at window reload, is reaped by cc after 60 s.
- A file chip carries the path only; the conductor reads the saved file where cc runs.
- Any VS Code webview can frame the plugin's pages; cc's API is open to whatever reaches its port regardless.

## Development

Run from the repo root; needs `make`, node and npm.

| Target | Does |
|---|---|
| `make` | `test`, then `package` |
| `make test` | `npm test`: every suite (`node:test`, no dependencies) |
| `make package` | `npm ci` in `extension/` when its lockfile changed or deps are missing, then `npm run package` → `extension/code-vscode-<version>.vsix` |
| `make install` | `package`, then `code --install-extension` on that `.vsix`; fails with a message if `code` isn't on PATH |
| `make clean` | removes the built `extension/code-vscode-*.vsix` files |

- `RUN_REAL_CC=1 CC_URL=http://127.0.0.1:<port> npm test` — adds the smoke test against a scratch cc (`npm run start:isolated` in a cc checkout) with the plugin enabled. Never point it at a cc you use.
- Internals: [docs/architecture.md](docs/architecture.md); contracts: [docs/protocol.md](docs/protocol.md).
