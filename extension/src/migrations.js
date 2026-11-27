'use strict';
// One-shot upgrades of state this extension owns.

// The pre-multi-tab extension kept its single session id here.
const SESSION_KEY = 'codeConductor.sessionId';

/** The session id the single pre-upgrade tab was bound to, consumed (deleted) on first read; undefined once taken. */
async function takeLegacySessionId(workspaceState) {
  const sid = workspaceState.get(SESSION_KEY);
  if (!sid) return undefined;
  await workspaceState.update(SESSION_KEY, undefined);
  return sid;
}

module.exports = { SESSION_KEY, takeLegacySessionId };
