'use strict';
// Editor events → debounced chips. The tracked editor is the last one whose state shaped to a chip;
// states that shape to nothing (focus in the cc tab, a terminal, a non-file editor with no selection) change nothing.
// Each produced chip carries a `seq`; `latestShown` hands the last one to a cc tab that was shown again.
// Who receives a chip, and the file-chip dedupe, belong to the registry and each tab's chip writer.

const SELECTION_DEBOUNCE_MS = 250;

/**
 * deps:
 *   onDidChangeTextEditorSelection(listener({textEditor})), onDidChangeActiveTextEditor(listener(editor|undefined)) — vscode event registrations (return a disposable)
 *   getActiveEditor() — the active text editor or undefined
 *   getVisibleEditors() — the text editors visible now
 *   shape(editor) — {kind: 'selection'|'file', key?, title, data} or null (no chip for this state)
 *   onChip(chip) — each produced chip
 */
function createChipSync({ onDidChangeTextEditorSelection, onDidChangeActiveTextEditor, getActiveEditor, getVisibleEditors, shape, onChip }) {
  let timer = null;
  let scheduled = null;
  // `tracked` is the editor that produced `latest`: flush sets both, and refresh only assigns tracked when it was already
  // that editor or when no chip was produced yet.
  let tracked = null;
  let latest = null;
  let seq = 0;

  function cancelTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  function flush() {
    timer = null;
    const editor = scheduled;
    scheduled = null;
    if (!editor) return;
    const chip = shape(editor);
    if (!chip) return;
    tracked = editor;
    seq += 1;
    latest = { ...chip, seq };
    onChip(latest);
  }

  function schedule(editor) {
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
    /** The chip for the tracked editor's state now (the active editor when none is tracked), or null. */
    refresh() {
      const editor = tracked ?? getActiveEditor();
      if (!editor) return null;
      const chip = shape(editor);
      if (chip) tracked = editor;
      // Tagged with the current seq, never advancing it: a forced push to one tab must not make another look as if it missed a chip.
      return chip && { ...chip, seq };
    },
    /** The last produced chip while the editor that produced it is still visible and not in `column` (the receiving tab's group); else null. */
    latestShown(column) {
      if (!latest || !getVisibleEditors().includes(tracked)) return null;
      if (column !== undefined && tracked.viewColumn !== undefined && tracked.viewColumn === column) return null;
      return latest;
    },
    dispose() { cancelTimer(); for (const s of subscriptions) s.dispose(); },
  };
}

module.exports = { SELECTION_DEBOUNCE_MS, createChipSync };
