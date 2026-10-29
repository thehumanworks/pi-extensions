import type { BotBackend, BotEvent, BotRun, BotSession, BotSubmitOptions, BotWatchOptions } from '../src/index.js';
export const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
export const baseRun = (overrides: Partial<BotRun> = {}): BotRun => ({
  runId: 'run-1', sessionId: 'session-1', bot: 'scripted', cwd: '/workspace', status: 'queued', output: '',
  usage: { ...zero }, toolCalls: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', ...overrides,
});
export const session: BotSession = { sessionId: 'session-1', cwd: '/workspace', createdAt: '2026-01-01', updatedAt: '2026-01-01', title: 'A session' };
export const user = (id: number, text: string) => ({ id, kind: 'message', model: [{ role: 'user', content: [{ type: 'text', text }] }] });
export const assistant = (id: number, text: string) => ({ id, kind: 'message', model: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
export function fixture() {
  let current = baseRun(); let snapshot: Record<string, unknown> = { entries: [], tools: [] };
  const listeners = new Set<(e: BotEvent) => void>(); const errorListeners = new Set<(e: Error) => void>();
  const submissions: Array<{ text: string; options?: BotSubmitOptions }> = []; const cancelled: string[] = [];
  let watches = 0; let stops = 0; let activeRun = false;
  const backend: BotBackend = {
    async info() { return { name: 'test', description: 'scripted', revision: 'r1', tools: [{ name: 'echo' }], skills: [] }; },
    async listSessions() { return [session]; },
    async getRun() { return { ...current, usage: { ...current.usage } }; },
    async submit(text, options) { submissions.push({ text, options }); return current; },
    async cancel(id) { cancelled.push(id); current = { ...current, status: 'cancelled' }; },
    async watch(sessionId, listener, options?: BotWatchOptions) {
      watches++; listeners.add(listener); if (options?.onError) errorListeners.add(options.onError);
      listener({ type: 'snapshot', sessionId, ...(activeRun ? { runId: current.runId } : {}), data: structuredClone(snapshot) });
      let stopped = false;
      return async () => { if (stopped) return; stopped = true; stops++; listeners.delete(listener); if (options?.onError) errorListeners.delete(options.onError); };
    },
  };
  return {
    backend, submissions, cancelled,
    get run() { return current; }, get observers() { return listeners.size; }, get watches() { return watches; }, get stops() { return stops; },
    setRun(value: Partial<BotRun>, active = false) { current = { ...current, ...value }; activeRun = active; },
    setSnapshot(value: Record<string, unknown>) { snapshot = value; },
    emit(type: string, data: unknown, runId: string | undefined = current.runId) { for (const listener of [...listeners]) listener({ type, sessionId: current.sessionId, runId, data }); },
    disconnect(error = new Error('backend-secret')) { for (const listener of errorListeners) listener(error); },
  };
}
export function request(body: unknown, init: RequestInit = {}) {
  return new Request('http://localhost/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
}
export const body = (text = 'hello', extras: Record<string, unknown> = {}) => ({ id: 'chat-1', messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text }] }], ...extras });
export function chunks(text: string): any[] {
  return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
}
export async function eventually(test: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (test()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error('Condition was not reached');
}
