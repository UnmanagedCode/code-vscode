'use strict';
// The conductor picker's items and prompt.

const NEW_CONDUCTOR_LABEL = '$(add) New conductor';

/**
 * listed: [{sessionId, displayLabel, status}] from the relay's listConductors, in cc's order.
 * openTabs: [{sid, label}] — the bound tabs. One whose session is not listed (pristine, or a lagging cc) still gets an item.
 */
function pickerItems(listed, openTabs) {
  const open = new Set(openTabs.map((t) => t.sid));
  const listedSids = new Set(listed.map((c) => c.sessionId));
  return [
    ...listed.map((c) => ({ label: c.displayLabel, description: open.has(c.sessionId) ? `${c.status} · open` : c.status, sessionId: c.sessionId })),
    ...openTabs.filter((t) => !listedSids.has(t.sid)).map((t) => ({ label: t.label, description: 'open', sessionId: t.sid })),
    { label: NEW_CONDUCTOR_LABEL, isNew: true },
  ];
}

/** The chosen item, or undefined when cancelled. */
function pickConductor(vscode, items) {
  return vscode.window.showQuickPick(items, { placeHolder: 'Choose the conductor to show' });
}

module.exports = { NEW_CONDUCTOR_LABEL, pickerItems, pickConductor };
