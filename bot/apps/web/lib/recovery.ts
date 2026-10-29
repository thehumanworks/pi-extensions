import { runData, validId, type RunState } from './chat';

const key = (sessionId: string) => `bot-ui:run:${sessionId}`;

/** References only, never a second transcript. A URL reference outranks stale storage. */
export function recoveryRun(sessionId: string, stored: string | null, href: string): RunState | undefined {
  let cached: RunState | undefined;
  try { cached = runData(JSON.parse(stored ?? 'null')); } catch { /* Corrupt/old storage. */ }
  if (cached?.sessionId !== sessionId) cached = undefined;
  const url = new URL(href);
  const runId = url.searchParams.get('run');
  if (url.searchParams.get('session') === sessionId && validId(runId)) {
    // Queued is provisional: the reconnect endpoint checks the actual run/session
    // and emits authoritative status before any response content.
    return cached?.runId === runId ? cached : { runId, sessionId, status: 'queued' };
  }
  return cached;
}

export function loadRunReference(sessionId: string): RunState | undefined {
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(key(sessionId)); } catch { /* URL still works. */ }
  return recoveryRun(sessionId, stored, window.location.href);
}

export function saveRunReference(run: RunState): void {
  try { window.localStorage.setItem(key(run.sessionId), JSON.stringify(run)); } catch { /* URL still works. */ }
  const url = new URL(window.location.href);
  if (url.searchParams.get('session') === run.sessionId) {
    url.searchParams.set('run', run.runId);
    window.history.replaceState(null, '', url);
  }
}
