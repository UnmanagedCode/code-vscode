// The relay's logic, free of DOM globals so the browser page and node tests share it.
// The relay runs on cc's own origin and carries the VS Code extension's requests to cc's REST API.
//
// Request:  { reqId, op, ...args }   ops: listConductors | newConductor | health | setChip | clearChip
// Response: { type: 'result', reqId, ok: true, value? } | { type: 'result', reqId, ok: false, code, error }

export const CONDUCT_PROJECT = '.conduct';
export const REQUEST_TIMEOUT_MS = 10_000;

const WEBVIEW_SCHEME = 'vscode-webview:';

// Mirrors isTopLevelConductor (shared/conductors.ts) plus cc's isLiveStatus: a live conductor no conductor spawned.
function isLiveTopLevelConductor(row) {
  return row.project === CONDUCT_PROJECT && !row.conducted && row.status !== 'exited' && row.status !== 'crashed' && !!row.sessionId;
}

const fail = (code, error) => ({ ok: false, code, error });

/** A relay bound to its collaborators; `onMessage(ev)` handles one window message event. */
export function createRelay({
  fetch,
  root,
  parent,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${root}/api/${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return fail('REQUEST_FAILED', String(e?.message ?? e));
    }
    let json = null;
    try { json = await res.json(); } catch { /* a non-JSON body carries no code */ }
    if (!res.ok) return fail(json?.code ?? 'HOST_ERROR', json?.error ?? `cc answered ${res.status}`);
    return { ok: true, value: json };
  }

  let healthRead = null;
  async function health() {
    const r = await api('GET', 'health');
    if (!r.ok) return r;
    return { ok: true, value: { uiMode: r.value?.uiMode ?? 'full', focusSessionId: r.value?.focus?.sessionId ?? null } };
  }
  // Read once per relay load; a failed read is retried by the next call.
  async function cachedHealth() {
    healthRead ??= health();
    const r = await healthRead;
    if (!r.ok) healthRead = null;
    return r;
  }

  // Mirrors sessionViewOnly (shared/viewOnly.ts).
  async function viewOnlyGate(sid) {
    const h = await cachedHealth();
    if (!h.ok) return h;
    const { uiMode, focusSessionId } = h.value;
    if (uiMode === 'view' || (uiMode === 'interact' && focusSessionId !== sid)) {
      return fail('VIEW_ONLY', 'cc runs with --ui view or interact; this session is read-only');
    }
    return null;
  }

  async function listConductors() {
    const r = await api('GET', 'instances');
    if (!r.ok) return r;
    const rows = Array.isArray(r.value) ? r.value : [];
    return { ok: true, value: rows.filter(isLiveTopLevelConductor).map((i) => ({ sessionId: i.sessionId, displayLabel: i.displayLabel ?? i.sessionId, status: i.status })) };
  }

  // The body cc's New conductor sends (newConductorSpawnBody('code'), shared/newConductor.ts). The response
  // carries the session id although a pristine conductor is not listed until its first prompt.
  async function newConductor() {
    const r = await api('POST', 'instances', { project: CONDUCT_PROJECT, role: 'conductor', mode: 'bypassPermissions', pristine: true });
    if (!r.ok) return r;
    if (!r.value?.sessionId) return fail('HOST_ERROR', 'cc started a conductor without a session id');
    return { ok: true, value: { sessionId: r.value.sessionId } };
  }

  async function setChip({ sid, title, data }) {
    const blocked = await viewOnlyGate(sid);
    if (blocked) return blocked;
    const r = await api('PUT', `sessions/${encodeURIComponent(sid)}/chip`, { title, data });
    return r.ok ? { ok: true } : r;
  }

  async function clearChip({ sid }) {
    const blocked = await viewOnlyGate(sid);
    if (blocked) return blocked;
    const r = await api('DELETE', `sessions/${encodeURIComponent(sid)}/chip`);
    return r.ok ? { ok: true } : r;
  }

  const ops = { listConductors, newConductor, health, setChip, clearChip };

  function trusted(ev) {
    if (ev.source !== parent) return false;
    try { return new URL(ev.origin).protocol === WEBVIEW_SCHEME; } catch { return false; }
  }

  async function onMessage(ev) {
    if (!trusted(ev)) return;
    const { reqId, op, ...args } = ev.data ?? {};
    if (typeof reqId !== 'string' || !Object.hasOwn(ops, op)) return;
    let result;
    try { result = await ops[op](args); } catch (e) { result = fail('HOST_ERROR', String(e?.message ?? e)); }
    ev.source.postMessage({ type: 'result', reqId, ...result }, ev.origin);
  }

  return { onMessage };
}
