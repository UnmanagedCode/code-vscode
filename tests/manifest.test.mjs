import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { VIEW_TYPE } = createRequire(import.meta.url)('../extension/src/view.js');
const manifest = JSON.parse(readFileSync(new URL('../extension/package.json', import.meta.url), 'utf8'));

test('the tab can be restored: activation includes onWebviewPanel for the view type', () => {
  assert.ok(manifest.activationEvents.includes(`onWebviewPanel:${VIEW_TYPE}`));
});

test('activation includes onStartupFinished so the status bar entry exists without a tab', () => {
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
});

test('the editor-title button covers file and untitled text editors', () => {
  const item = manifest.contributes.menus['editor/title'].find((m) => m.command === 'codeConductor.open');
  assert.equal(item.when, 'activeEditor == workbench.editors.files.textFileEditor || activeEditor == workbench.editors.textResourceEditor');
});

test('every command used in a menu is contributed', () => {
  const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const items of Object.values(manifest.contributes.menus ?? {})) {
    for (const { command } of items) assert.ok(contributed.has(command), command);
  }
});

test('every command the extension registers is contributed', () => {
  const src = readFileSync(new URL('../extension/src/extension.js', import.meta.url), 'utf8');
  const registered = [...src.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]);
  const contributed = new Set(manifest.contributes.commands.map((c) => c.command));
  assert.ok(registered.length > 0);
  for (const c of registered) assert.ok(contributed.has(c), c);
});

test('the command icons point at files that exist', () => {
  const icon = manifest.contributes.commands.find((c) => c.icon).icon;
  for (const path of [icon.light, icon.dark]) readFileSync(new URL(`../extension/${path}`, import.meta.url));
});
