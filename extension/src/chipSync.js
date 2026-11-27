'use strict';
// Editor events → debounced, coalesced chip writes. The tracked editor is the last one whose state shaped to a chip;
// states that shape to nothing (focus in the cc tab, a terminal, a non-file editor with no selection) change nothing.

const SELECTION_DEBOUNCE_MS = 250;

/**
 * deps:
 *   onDidChangeTextEditorSelection(listener({textEditor})), onDidChangeActiveTextEditor(listener(editor|undefined)) — vscode event registrations (return a disposable)
 *   getActiveEditor() — the active text editor or undefined
 *   shape(editor) — {kind: 'selection'|'file', key?, title, data} or null (no chip for this state)
 *   send({op: 'setChip', title, data}) — resolves to {ok, code?}; may reject
 *   onResult(result) — each write's outcome
 */
function createChipSync({ onDidChangeTextEditorSelection, onDidChangeActiveTextEditor, getActiveEditor, shape, send, onResult }) {
  let enabled = false;
  let timer = null;
  let scheduled = null;
  let tracked = null;
  // Path of the file chip most recently queued; a repeat is skipped so the composer's × sticks until something changes.
  let lastFileKey = null;
  let pending = null;
  let writing = false;

  function cancelTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  async function drain() {
    writing = true;
    try {
      while (pending) {
        const { message, key } = pending;
        pending = null;
        let result;
        try { result = await send(message); } catch (e) { result = { ok: false, code: 'REQUEST_FAILED', error: String(e?.message ?? e) }; }
        // Only when no newer write for this file is queued: that one owns the baseline now.
        if (!result.ok && key !== null && lastFileKey === key && pending?.key !== key) lastFileKey = null;
        onResult(result);
      }
    } finally { writing = false; }
  }

  // Shapes the editor as it is now; only the newest state is ever left pending.
  function apply(editor, force) {
    const chip = shape(editor);
    if (!chip) return;
    tracked = editor;
    let key = null;
    if (chip.kind === 'file') {
      if (!force && lastFileKey === chip.key) return;
      lastFileKey = chip.key;
      key = chip.key;
    } else {
      lastFileKey = null;
    }
    pending = { message: { op: 'setChip', title: chip.title, data: chip.data }, key };
    if (!writing) void drain();
  }

  function flush() {
    timer = null;
    const editor = scheduled;
    scheduled = null;
    if (enabled && editor) apply(editor, false);
  }

  function schedule(editor) {
    if (!enabled) return;
    scheduled = editor;
    cancelTimer();
    timer = setTimeout(flush, SELECTION_DEBOUNCE_MS);
  }

  const subscriptions = [
    onDidChangeTextEditorSelection((e) => schedule(e.textEditor)),
    // An active editor that becomes undefined is focus leaving the editors, not a selection change.
    onDidChangeActiveTextEditor((editor) => { if (editor) schedule(editor); }),
  ];

  return {
    enable() { enabled = true; },
    disable() { enabled = false; cancelTimer(); scheduled = null; pending = null; lastFileKey = null; },
    /** Writes the tracked editor's state now (the active editor when none is tracked), skipping the debounce and the file-chip dedupe. */
    pushNow() {
      if (!enabled) return;
      cancelTimer();
      scheduled = null;
      const editor = tracked ?? getActiveEditor();
      if (editor) apply(editor, true);
    },
    dispose() { cancelTimer(); for (const s of subscriptions) s.dispose(); },
  };
}

module.exports = { SELECTION_DEBOUNCE_MS, createChipSync };
