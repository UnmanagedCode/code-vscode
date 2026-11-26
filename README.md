# code-vscode

A [cc](https://github.com/UnmanagedCode/code-conductor) plugin plus a VS Code extension. The extension shows **one** cc conductor session in a VS Code panel; the live editor selection becomes that session's context chip, so the next prompt carries the code you were looking at.

## What you get

- A `cc` view in the bottom panel (drag it to the secondary sidebar to sit beside the editor) that embeds a conductor, without cc's sidebar.
- **cc: Connect** picks a live conductor or starts a new one; the choice is remembered per window and workspace and reconnects on reload.
- Select text in any editor and the chip `file.ts:12-18 (7 lines)` appears in the composer, with the selected code as its data.
- A status bar item shows the state (`cc: <label>`, `not connected`, `view-only (no chip)`, `session ended`, or an error code).

Details: [docs/features.md](docs/features.md).

## Quick start

1. **Plugin.** Put this repo in cc's projects root (`PROJECTS_ROOT`) as a project or clone. In cc: Settings → Plugins → Rescan → Enable `code-vscode`. Its backend starts lazily on the panel's first request.
2. **Extension.** `cd extension && npm ci && npm run package` builds `code-vscode-<version>.vsix`. Install with `code --install-extension <file>.vsix` or Extensions → "Install from VSIX…".
3. Set `codeConductor.serverUrl` (default `http://127.0.0.1:8787`, cc's standard local URL) to cc as seen from the machine the extension runs on.
4. Run **cc: Connect**.

## Supported setups

- A local cc.
- A cc forwarded to loopback: `ssh -L 8787:127.0.0.1:8787 <host>` with the default URL, or in a VS Code Remote window the host's loopback URL (`asExternalUri` forwards it).
- Any HTTPS cc URL that needs no login.

## Known limitations

- code-hub shares behind its login are unsupported (its `hub_auth` cookie is `SameSite=Lax`, which Chromium drops in the panel's cross-site iframe).
- Plain `http://` on a non-loopback address is unsupported (presumed blocked as mixed content).
- Desktop VS Code only; browser-hosted VS Code (vscode.dev, code-server) is untested and not admitted.
- Chips sync only while the view's webview is alive; the primary selection only; no path mapping for a remote cc.
- Any VS Code webview can frame the plugin's pages; cc's API is open to whatever reaches its port regardless.

## Development

- `npm test` — all suites (`node:test`, no dependencies).
- `RUN_REAL_CC=1 CC_URL=http://127.0.0.1:<port> npm test` — adds the smoke test against a scratch cc (`npm run start:isolated` in a cc checkout) with the plugin enabled. Never point it at a cc you use.
- Internals: [docs/architecture.md](docs/architecture.md); contracts: [docs/protocol.md](docs/protocol.md).
