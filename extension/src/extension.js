'use strict';
// Wiring only: builds the collaborators and registers them once.
const { randomBytes } = require('node:crypto');
const { VIEW_TYPE } = require('./view');
const { createChipSync } = require('./chipSync');
const { createTabs } = require('./tabs');
const { takeLegacySessionId } = require('./migrations');
const { shapeEditor } = require('./chipShape');

function activate(context, vscode = require('vscode')) {
  const source = createChipSync({
    onDidChangeTextEditorSelection: vscode.window.onDidChangeTextEditorSelection,
    onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor,
    getActiveEditor: () => vscode.window.activeTextEditor,
    shape: shapeEditor,
    onChip: (chip) => tabs.onChip(chip),
  });

  const tabs = createTabs({
    vscode,
    extensionUri: context.extensionUri,
    randomBytes,
    getServerUrl: () => vscode.workspace.getConfiguration('codeConductor').get('serverUrl'),
    source,
    takeLegacySessionId: () => takeLegacySessionId(context.workspaceState),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, tabs.serializer),
    vscode.commands.registerCommand('codeConductor.open', () => tabs.open()),
    { dispose: () => { source.dispose(); tabs.dispose(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
