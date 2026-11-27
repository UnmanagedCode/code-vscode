'use strict';
// Where cc is, as the webview reaches it.

const PLUGIN_PATH = 'plugins/code-vscode/';

/** deps: vscode (env.asExternalUri, Uri.parse), getServerUrl() — the codeConductor.serverUrl setting. */
async function endpoints({ vscode, getServerUrl }) {
  const external = String(await vscode.env.asExternalUri(vscode.Uri.parse(getServerUrl())));
  const base = new URL(external.endsWith('/') ? external : `${external}/`);
  return {
    serverUrl: getServerUrl(),
    ccOrigin: base.origin,
    relayUrl: new URL(`${PLUGIN_PATH}relay`, base).toString(),
    documentUrl: (sid) => `${new URL(PLUGIN_PATH, base).toString()}?focus=${encodeURIComponent(sid)}`,
  };
}

module.exports = { endpoints };
