'use strict';
// Wiring only: builds the collaborators and registers them once.
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { createView, VIEW_TYPE } = require('./view');
const { createChipSync } = require('./chipSync');
const { createConnection } = require('./connection');
const { shapeEditor } = require('./chipShape');

function activate(context) {
  const view = createView({ vscode, extensionUri: context.extensionUri, randomBytes });

  const sync = createChipSync({
    onDidChangeTextEditorSelection: vscode.window.onDidChangeTextEditorSelection,
    onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor,
    getActiveEditor: () => vscode.window.activeTextEditor,
    shape: shapeEditor,
    send: (message) => connection.sendChip(message),
    onResult: (result) => connection.onChipResult(result),
  });

  const connection = createConnection({
    vscode,
    workspaceState: context.workspaceState,
    getServerUrl: () => vscode.workspace.getConfiguration('codeConductor').get('serverUrl'),
    view,
    sync,
  });

  // Before the serializer is registered, so a restored tab's resume() wins.
  connection.init();

  view.on('resolve', () => { void connection.resume(); });
  view.on('close', () => connection.onClosed());
  view.on('ready', () => connection.onRelayReady());
  view.on('connect', () => { void connection.connect(); });

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, view.serializer),
    vscode.commands.registerCommand('codeConductor.open', () => connection.open()),
    vscode.commands.registerCommand('codeConductor.connect', () => connection.connect()),
    vscode.commands.registerCommand('codeConductor.disconnect', () => connection.disconnect()),
    { dispose: () => { sync.dispose(); connection.dispose(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
