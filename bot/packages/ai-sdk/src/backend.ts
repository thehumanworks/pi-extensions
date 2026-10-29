import type { BotBackend, BotEvent, BotSubmitOptions, BotWatchOptions } from './types.js';
import { BotAdapterError, LIMITS, boundedText, event, id, info, invalid, record, run, safeError, sessions } from './safety.js';

export interface ConnectBotBackendOptions { token?: string; fetch?: typeof globalThis.fetch }

/** Bounded UTF-8 NDJSON parser; EOF without a newline is valid, malformed or oversized events are not. */
async function* events(reader: ReadableStreamDefaultReader<Uint8Array>, sessionId?: string): AsyncGenerator<BotEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
  const parse = (line: string) => { try { return event(JSON.parse(line), sessionId); } catch { invalid(); } };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.byteLength > LIMITS.eventBytes) invalid();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        if (Buffer.byteLength(line) > LIMITS.eventBytes) invalid();
        if (line.trim()) yield parse(line);
      }
      if (Buffer.byteLength(pending) > LIMITS.eventBytes) invalid();
      if (done) { if (pending.trim()) yield parse(pending); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A transport only. It never opens a local runtime, owns a provider, or cancels work on disconnect. */
export function connectBotBackend(url: string, options: ConnectBotBackendOptions = {}): BotBackend {
  let base: URL;
  try { base = new URL(url); } catch { throw new BotAdapterError(500, 'INVALID_CONFIG', 'Invalid bot server configuration'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new BotAdapterError(500, 'INVALID_CONFIG', 'Bot URL must be HTTP(S) without credentials, query or fragment');
  }
  if (options.token !== undefined && (typeof options.token !== 'string' || !options.token.trim() || /[\r\n]/.test(options.token))) {
    throw new BotAdapterError(500, 'INVALID_CONFIG', 'Invalid bot authentication configuration');
  }
  const root = base.href.replace(/\/$/, ''); const fetcher = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` };
  const response = async (path: string, controller: AbortController, method = 'GET', body?: unknown, stream = false): Promise<Response> => {
    try {
      const res = await fetcher(root + path, {
        method, headers: { ...headers, Accept: stream ? 'application/x-ndjson' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: controller.signal,
      });
      if (!res.ok) {
        // Backend error bodies and fetch exception strings may contain tokens. Never use them as UI text.
        await res.body?.cancel().catch(() => {});
        const mapping: Record<number, [string, string]> = {
          401: ['BACKEND_AUTH', 'Bot server authentication failed'], 403: ['BACKEND_AUTH', 'Bot server access was denied'],
          404: ['NOT_FOUND', 'Bot resource was not found'], 409: ['CONFLICT', 'Request ID conflicts with an earlier submission'],
          400: ['INVALID_INPUT', 'Bot rejected the request'], 413: ['BODY_TOO_LARGE', 'Bot message exceeds the size limit'],
        };
        const [code, message] = mapping[res.status] ?? ['BACKEND_UNAVAILABLE', 'Bot server is unavailable'];
        throw new BotAdapterError(mapping[res.status] ? res.status : 503, code, message);
      }
      return res;
    } catch (error) { throw safeError(error); }
  };
  const json = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const res = await response(path, controller, method, body);
      try { return JSON.parse(await boundedText(res.body, LIMITS.responseBytes, controller.signal)); }
      catch { if (controller.signal.aborted) throw new BotAdapterError(503, 'BACKEND_UNAVAILABLE', 'Bot request timed out; inspect history before retrying'); invalid(); }
    } catch (error) { throw safeError(error); }
    finally { clearTimeout(timer); }
  };
  const open = async (path: string, method = 'GET', body?: unknown) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const res = await response(path, controller, method, body, true);
      if (!res.body || !res.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson')) {
        await res.body?.cancel().catch(() => {}); invalid();
      }
      const reader = res.body.getReader();
      controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
      if (controller.signal.aborted) { await reader.cancel().catch(() => {}); throw new BotAdapterError(503, 'BACKEND_UNAVAILABLE', 'Bot request timed out; inspect history before retrying'); }
      return { controller, reader, iterator: events(reader), timer };
    } catch (error) { clearTimeout(timer); controller.abort(); throw safeError(error); }
  };
  return {
    async info() { return info(await json('/v1/info')); },
    async listSessions() { return sessions(await json('/v1/sessions')); },
    async getRun(runId) {
      id(runId, 'run ID'); const result = run(await json(`/v1/runs/${encodeURIComponent(runId)}`));
      if (result.runId !== runId) invalid(); return result;
    },
    async cancel(runId) {
      id(runId, 'run ID');
      if (record(await json(`/v1/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {})).ok !== true) invalid();
    },
    async submit(message: string, opts: BotSubmitOptions = {}) {
      if (typeof message !== 'string' || !message.trim() || message.length > LIMITS.textChars || message.includes('\0')) throw new BotAdapterError(400, 'INVALID_INPUT', 'Invalid user text');
      if (opts.session !== undefined) id(opts.session, 'session ID');
      if (opts.requestId !== undefined && (typeof opts.requestId !== 'string' || !opts.requestId.trim() || Buffer.byteLength(opts.requestId) > 1024 || /[\u0000-\u001f\u007f]/.test(opts.requestId))) throw new BotAdapterError(400, 'INVALID_INPUT', 'Invalid request ID');
      const body = { message, session: opts.session, requestId: opts.requestId };
      if (!opts.onEvent) {
        const accepted = run(await json('/v1/runs', 'POST', body));
        if (opts.session && accepted.sessionId !== opts.session) invalid(); return accepted;
      }
      const opened = await open('/v1/runs', 'POST', body);
      try {
        const first = await opened.iterator.next();
        if (first.done || first.value.type !== 'run_accepted') invalid();
        const accepted = run(first.value.data);
        if (opts.session && accepted.sessionId !== opts.session) invalid();
        clearTimeout(opened.timer);
        const notify = (value: BotEvent) => { try { opts.onEvent!(value); } catch { /* caller observer does not own backend work */ } };
        notify(first.value);
        void (async () => {
          try {
            for await (const value of opened.iterator) {
              event(value, accepted.sessionId);
              if (value.runId !== undefined && value.runId !== accepted.runId) invalid();
              notify(value);
              if (value.type === 'run_settled') return;
            }
            notify({ type: 'adapter_stream_error', sessionId: accepted.sessionId, runId: accepted.runId });
          } catch { notify({ type: 'adapter_stream_error', sessionId: accepted.sessionId, runId: accepted.runId }); }
          finally { opened.controller.abort(); await opened.reader.cancel().catch(() => {}); }
        })();
        return accepted;
      } catch (error) { opened.controller.abort(); await opened.reader.cancel().catch(() => {}); throw safeError(error); }
      finally { clearTimeout(opened.timer); }
    },
    async watch(sessionId: string, listener: (event: BotEvent) => void, opts: BotWatchOptions = {}) {
      id(sessionId, 'session ID'); const opened = await open(`/v1/sessions/${encodeURIComponent(sessionId)}/stream`);
      clearTimeout(opened.timer); let stopped = false; let stopping: Promise<void> | undefined;
      const task = (async () => {
        try {
          for await (const value of opened.iterator) { event(value, sessionId); listener(value); }
          if (!stopped) opts.onError?.(new BotAdapterError(503, 'STREAM_INTERRUPTED', 'Bot stream disconnected; reconnect to inspect the run'));
        } catch (error) {
          if (!stopped) { try { opts.onError?.(safeError(error)); } catch { /* no background rejection */ } }
        }
      })();
      return () => stopping ??= (async () => { stopped = true; opened.controller.abort(); await opened.reader.cancel().catch(() => {}); await task; })();
    },
  };
}
