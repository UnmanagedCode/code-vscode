'use strict';
// Editor events → debounced, coalesced chip writes.

const SELECTION_DEBOUNCE_MS = 250;

/**
 * deps:
 *   onDidChangeTextEditorSelection, onDidChangeActiveTextEditor — vscode event registrations (return a disposable)
 *   getActiveEditor() — the active text editor or undefined
 *   shape(editor) — {title, data} or null (empty selection)
 *   send({op: 'setChip', title, data} | {op: 'clearChip'}) — resolves to {ok, code?}; may reject
 *   onResult(result) — each write's outcome
 */
function createChipSync({ onDidChangeTextEditorSelection, onDidChangeActiveTextEditor, getActiveEditor, shape, send, onResult }) {
  let enabled = false;
  let timer = null;
  let pending = null;
  let writing = false;

  function cancelTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  async function drain() {
    writing = true;
    try {
      while (pending) {
        const message = pending;
        pending = null;
        let result;
        try { result = await send(message); } catch (e) { result = { ok: false, code: 'REQUEST_FAILED', error: String(e?.message ?? e) }; }
        onResult(result);
      }
    } finally { writing = false; }
  }

  // Shapes the editor as it is now; only the newest state is ever left pending.
  function flush() {
    timer = null;
    if (!enabled) return;
    const editor = getActiveEditor();
    // No active editor means focus is elsewhere (the cc panel, a terminal): the chip stays.
    if (!editor) return;
    const chip = shape(editor);
    pending = chip ? { op: 'setChip', ...chip } : { op: 'clearChip' };
    if (!writing) void drain();
  }

  function schedule() {
    if (!enabled) return;
    cancelTimer();
    timer = setTimeout(flush, SELECTION_DEBOUNCE_MS);
  }

  const subscriptions = [
    onDidChangeTextEditorSelection(schedule),
    // An active editor that becomes undefined is focus leaving the editors, not a selection change.
    onDidChangeActiveTextEditor((editor) => { if (editor) schedule(); }),
  ];

  return {
    enable() { enabled = true; },
    disable() { enabled = false; cancelTimer(); pending = null; },
    /** Writes the current state now, skipping the debounce. */
    pushNow() { if (!enabled) return; cancelTimer(); flush(); },
    dispose() { cancelTimer(); for (const s of subscriptions) s.dispose(); },
  };
}

module.exports = { SELECTION_DEBOUNCE_MS, createChipSync };
