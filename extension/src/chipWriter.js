'use strict';
// One session's chip write queue: at most one write in flight, newest state wins, and the file-chip dedupe.

/**
 * deps:
 *   send({op: 'setChip', title, data}) — resolves to {ok, code?}; may reject
 *   onResult(result) — each write's outcome
 */
function createChipWriter({ send, onResult }) {
  let enabled = false;
  // Path of the file chip most recently queued; a repeat is skipped so the composer's × sticks until something changes.
  let lastFileKey = null;
  let pending = null;
  let writing = false;

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

  return {
    enable() { enabled = true; },
    disable() { enabled = false; pending = null; lastFileKey = null; },
    /** Queues `chip` ({kind, key?, title, data}); a file chip repeating the last written path is skipped unless `force`. */
    offer(chip, { force = false } = {}) {
      if (!enabled) return;
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
    },
    dispose() { this.disable(); },
  };
}

module.exports = { createChipWriter };
