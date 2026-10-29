import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import type { BotBackend, BotChatAdapter, BotEvent, BotRun, BotRunData } from './types.js';
import { BotAdapterError, LIMITS, bad, boundedText, errorResponse, event, id, info, invalid, record, run, safeError, sameOrigin, sessions, stableId, terminal } from './safety.js';
import { Transcript, type ProjectedMessage } from './transcript.js';

type Chunk = UIMessageChunk;
interface Observation {
  first: BotEvent;
  listen(listener: (e: BotEvent) => void, onError: (e: unknown) => void): void;
  stop(): Promise<void>;
}
/** Handles synchronous initial snapshots and asynchronous unsubscribe acquisition without leaking either. */
async function observe(backend: BotBackend, sessionId: string): Promise<Observation> {
  let listener: ((e: BotEvent) => void) | undefined; let onError: ((e: unknown) => void) | undefined;
  let first: BotEvent | undefined; let stopped = false; let failed: unknown;
  let unsubscribe: (() => Promise<void>) | undefined; let stopping: Promise<void> | undefined;
  const queue: BotEvent[] = []; let queuedBytes = 0;
  let resolve!: () => void; let reject!: (e: unknown) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const fail = (error: unknown) => { failed = safeError(error); if (onError && !stopped) onError(failed); else reject(failed); };
  let timeoutReject!: (e: unknown) => void;
  const deadline = new Promise<never>((_, no) => { timeoutReject = no; });
  const timer = setTimeout(() => timeoutReject(new BotAdapterError(503, 'SNAPSHOT_TIMEOUT', 'Bot snapshot timed out; reconnect to inspect the run')), LIMITS.snapshotTimeoutMs);
  const stop = (): Promise<void> => {
    stopped = true; clearTimeout(timer); queue.length = 0;
    return stopping ??= unsubscribe ? unsubscribe().catch(() => {}) : Promise.resolve();
  };
  const opening = Promise.resolve().then(() => backend.watch(sessionId, value => {
    if (stopped || failed) return;
    try {
      const e = event(value, sessionId);
      if (!first) { if (e.type !== 'snapshot') invalid(); first = e; resolve(); }
      if (listener) listener(e);
      else {
        queuedBytes += Buffer.byteLength(JSON.stringify(e));
        if (queuedBytes > LIMITS.responseBytes) invalid();
        queue.push(e);
      }
    } catch (error) { fail(error); }
  }, { onError: fail })).then(async release => {
    if (typeof release !== 'function') invalid();
    unsubscribe = release;
    if (stopped) await release().catch(() => {});
  });
  void opening.catch(fail);
  try {
    // Both the initial snapshot and asynchronous subscription acquisition share one deadline.
    await Promise.race([Promise.all([ready, opening]), deadline]);
    if (failed) throw failed;
    return { first: first!, stop, listen(next, error) {
      listener = next; onError = error;
      if (failed) { error(failed); return; }
      for (const e of queue.splice(0)) { if (!stopped) next(e); }
      queuedBytes = 0;
    } };
  } catch (error) { void stop().catch(() => {}); throw safeError(error); }
  finally { clearTimeout(timer); }
}
async function snapshot(backend: BotBackend, sessionId: string): Promise<BotEvent> {
  const watch = await observe(backend, sessionId);
  try { return watch.first; } finally { await watch.stop(); }
}
interface Input { chatId: string; userKey: string; text: string; sessionId?: string; requestId: string }
async function input(request: Request): Promise<Input> {
  if (request.method !== 'POST') throw new BotAdapterError(405, 'METHOD_NOT_ALLOWED', 'Expected POST');
  sameOrigin(request);
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type && type !== 'application/json') throw new BotAdapterError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > LIMITS.requestBytes)) throw new BotAdapterError(413, 'BODY_TOO_LARGE', 'Request exceeds the size limit');
  let value: unknown;
  try { value = JSON.parse(await boundedText(request.body, LIMITS.requestBytes, AbortSignal.any([request.signal, AbortSignal.timeout(LIMITS.requestTimeoutMs)]))); }
  catch (error) { if (error instanceof BotAdapterError) throw error; bad('Malformed JSON request'); }
  const body = record(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('Expected a JSON object');
  const allowed = ['id', 'messages', 'sessionId', 'requestId', 'trigger', 'messageId'];
  if (Object.keys(body).some(key => !allowed.includes(key))) bad('Unsupported request fields; edits and regeneration are not supported');
  const chatId = id(body.id, 'chat ID');
  if (body.trigger !== undefined && body.trigger !== 'submit-message') bad('Regeneration and edit requests are not supported');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > LIMITS.messages) bad('Invalid message list');
  const ids = new Set<string>();
  for (const value of body.messages) {
    const message = record(value); const messageId = id(message.id, 'message ID');
    if (ids.has(messageId)) bad('Duplicate message IDs'); ids.add(messageId);
    if (!['user', 'assistant', 'system'].includes(message.role) || !Array.isArray(message.parts) || message.parts.length > LIMITS.parts) bad('Invalid UI message');
  }
  const latest = record(body.messages.at(-1));
  if (latest.role !== 'user') bad('Only a new final user message can be submitted; regeneration is not supported');
  if (body.messageId !== undefined && body.messageId !== latest.id) bad('Editing earlier messages is not supported');
  if (!latest.parts.length || latest.parts.some((p: unknown) => record(p).type !== 'text' || typeof record(p).text !== 'string')) bad('Only user text is supported; attachments and tool submissions are not supported');
  const text = latest.parts.map((p: { text: string }) => p.text).join('');
  if (!text.trim() || text.length > LIMITS.textChars || text.includes('\0')) bad('User text must be non-empty and at most 100000 characters');
  const sessionId = body.sessionId === undefined ? undefined : id(body.sessionId, 'session ID');
  const requestId = body.requestId ?? stableId('request', chatId, latest.id);
  if (typeof requestId !== 'string' || !requestId.trim() || Buffer.byteLength(requestId) > 1024 || /[\u0000-\u001f\u007f]/.test(requestId)) bad('Invalid request ID');
  return { chatId, userKey: stableId(chatId, latest.id), text, sessionId, requestId };
}

/** One UI message per durable user turn, with AI SDK 7 reset-step reconciliation on retries/replacements. */
class Emitter {
  private current: string | undefined;
  private previous: ProjectedMessage | undefined;
  constructor(private readonly send: (chunk: Chunk) => void) {}
  private endParts() {
    if (!this.previous) return;
    this.previous.message.parts.forEach((part, index) => {
      if (part.type === 'text' || part.type === 'reasoning') this.send({ type: part.type === 'text' ? 'text-end' : 'reasoning-end', id: this.previous!.keys[index] });
    });
  }
  update(next: ProjectedMessage): void {
    if (next.message.id !== this.current) {
      if (this.current) { this.endParts(); this.send({ type: 'finish-step' }); }
      this.current = next.message.id; this.previous = undefined;
      this.send({ type: 'start', messageId: this.current }); this.send({ type: 'start-step' });
    }
    const previous = this.previous;
    const needsReset = previous && (previous.keys.some((key, index) => next.keys[index] !== key)
      || previous.message.parts.some((part, index) => {
        const n = next.message.parts[index];
        return (part.type === 'text' || part.type === 'reasoning') && (!n || n.type !== part.type || !('text' in n) || !n.text.startsWith(part.text));
      }));
    if (needsReset) { this.send({ type: 'reset-step' }); this.previous = undefined; }
    next.message.parts.forEach((part, index) => {
      const before = this.previous?.message.parts[index]; const key = next.keys[index];
      if (part.type === 'text' || part.type === 'reasoning') {
        if (!before) this.send({ type: part.type === 'text' ? 'text-start' : 'reasoning-start', id: key });
        const delta = part.text.slice(before && 'text' in before ? before.text.length : 0);
        for (let at = 0; at < delta.length; at += 16_384) this.send({ type: part.type === 'text' ? 'text-delta' : 'reasoning-delta', id: key, delta: delta.slice(at, at + 16_384) });
      } else if (part.type === 'data-bot-tool' && JSON.stringify(before) !== JSON.stringify(part)) this.send({ type: 'data-bot-tool', id: part.id, data: part.data });
    });
    this.previous = structuredClone(next);
  }
  finish(): void { this.endParts(); if (this.current) this.send({ type: 'finish-step' }); }
}

export function createBotChatAdapter({ backend }: { backend: BotBackend }): BotChatAdapter {
  if (!backend || ['info', 'submit', 'getRun', 'listSessions', 'watch', 'cancel'].some(key => typeof (backend as unknown as Record<string, unknown>)[key] !== 'function')) throw new BotAdapterError(500, 'INVALID_CONFIG', 'A structural BotBackend is required');
  // Bounded correlation cache stores fingerprints and accepted IDs, never browser transcripts.
  const requests = new Map<string, { userKey: string; fingerprint: string; session?: string; promise: Promise<Pick<BotRun, 'runId' | 'sessionId'>> }>();
  const users = new Map<string, string>();
  const accept = async (body: Input): Promise<BotRun> => {
    const fingerprint = stableId(body.chatId, body.text);
    const key = users.get(body.userKey) ?? body.requestId;
    const existing = requests.get(key);
    if (existing) {
      const accepted = await existing.promise;
      if (existing.userKey !== body.userKey || existing.fingerprint !== fingerprint || body.sessionId !== existing.session) throw new BotAdapterError(409, 'CONFLICT', 'Request ID conflicts with an earlier submission');
      const current = run(await backend.getRun(accepted.runId));
      if (current.runId !== accepted.runId || current.sessionId !== accepted.sessionId) invalid(); return current;
    }
    if (requests.size >= 1024) {
      const oldest = requests.keys().next().value!; const evicted = requests.get(oldest)!;
      users.delete(evicted.userKey); requests.delete(oldest);
    }
    const promise = backend.submit(body.text, { session: body.sessionId, requestId: body.requestId }).then(value => {
      const accepted = run(value); if (body.sessionId && accepted.sessionId !== body.sessionId) invalid(); return accepted;
    });
    const correlation = promise.then(({ runId, sessionId }) => ({ runId, sessionId }));
    void correlation.catch(() => {}); // Rejected acceptance must not create an unobserved cache rejection.
    requests.set(body.requestId, { userKey: body.userKey, fingerprint, session: body.sessionId, promise: correlation });
    users.set(body.userKey, body.requestId);
    try { return await promise; } catch (error) { requests.delete(body.requestId); users.delete(body.userKey); throw error; }
  };
  const stream = async (request: Request, sessionId: string, accepted?: BotRun, replay = false): Promise<Response> => {
    const observation = await observe(backend, sessionId);
    const transcript = new Transcript(sessionId);
    let known = accepted;
    try {
      transcript.apply(observation.first);
      if (!known && observation.first.runId) {
        known = run(await backend.getRun(observation.first.runId));
        if (known.runId !== observation.first.runId || known.sessionId !== sessionId) invalid();
      }
    } catch (error) { await observation.stop().catch(() => {}); throw error; }
    let done = false; let finishing = false; let controller: ReadableStreamDefaultController<Chunk>;
    let poll: ReturnType<typeof setTimeout> | undefined; let polling = false;
    let active = replay || !!known && terminal(known) || !!known && observation.first.runId === known.runId;
    const baselineUser = transcript.latestUserId;
    let targetUserId = active && known?.status !== 'queued' ? baselineUser : undefined;
    let targetId = known && terminal(known) && known.output ? transcript.forOutput(known.output, known)?.message.id : undefined;
    const cleanup = () => { clearTimeout(poll); request.signal.removeEventListener('abort', detach); void observation.stop().catch(() => {}); };
    const close = () => { if (done) return; done = true; cleanup(); controller.close(); };
    const fail = (error: unknown) => { if (done) return; const e = safeError(error); controller.enqueue({ type: 'error', errorText: e.message }); close(); };
    const detach = () => close();
    const send = (chunk: Chunk) => {
      if (done) return;
      const bytes = Buffer.byteLength(JSON.stringify(chunk));
      if (bytes > LIMITS.bufferBytes || (controller.desiredSize ?? 0) < bytes) throw new BotAdapterError(503, 'SLOW_CONSUMER', 'Chat stream buffer exceeded; reload history to reconnect');
      controller.enqueue(chunk);
    };
    const emitter = new Emitter(send);
    let lastStatus: string | undefined;
    const metadata = () => {
      if (!known || known.status === lastStatus) return; lastStatus = known.status;
      const data: BotRunData = { runId: known.runId, sessionId, status: known.status };
      send({ type: 'data-bot-run', id: stableId(known.runId, 'status'), data, transient: true });
    };
    const emit = () => {
      if (!active || known && terminal(known) && known.output && !targetId) return;
      const latest = targetId ? transcript.project().find(item => item.message.id === targetId) : transcript.latest();
      if (!latest || !targetId && targetUserId !== transcript.latestUserId) return;
      targetId ??= latest.message.id;
      emitter.update(latest);
    };
    const settle = async () => {
      if (done || finishing || !known || !terminal(known)) return;
      const settled = known; // Immutable decision across the final snapshot await.
      finishing = true;
      try {
        // A poll may beat the final event; take another canonical, read-only snapshot before closing.
        transcript.apply(await snapshot(backend, sessionId));
        if (done) return;
        active = true;
        if (!targetId && settled.output) targetId = transcript.forOutput(settled.output, settled)?.message.id;
        if (settled.status === 'completed' && settled.output && !targetId) throw new BotAdapterError(502, 'TRANSCRIPT_UNAVAILABLE', 'Run transcript is unavailable; reload history to inspect the run');
        emit(); metadata(); emitter.finish();
        send({ type: 'data-bot-usage', data: settled.usage, transient: true });
        if (settled.status === 'failed') { fail(new BotAdapterError(502, 'RUN_FAILED', 'Bot run failed; inspect history or backend logs')); return; }
        if (settled.status === 'cancelled') send({ type: 'abort', reason: 'Bot run was cancelled' });
        else send({ type: 'finish', finishReason: 'stop' });
        close();
      } catch (error) { fail(error); }
    };
    const check = async () => {
      if (done || finishing || polling || !known) return;
      polling = true;
      try {
        const current = run(await backend.getRun(known.runId));
        // Settlement may have arrived while this older poll was in flight.
        if (done || finishing || terminal(known)) return;
        if (current.runId !== known.runId || current.sessionId !== sessionId) invalid();
        if (known.status === 'running' && current.status === 'queued') return;
        known = current; metadata();
        if (terminal(known)) await settle();
      } catch (error) { if (!done && !finishing) fail(error); }
      finally { polling = false; if (!done && !finishing) poll = setTimeout(() => void check(), LIMITS.pollIntervalMs); }
    };
    const chunks = new ReadableStream<Chunk>({
      start(value) {
        controller = value;
        if (request.signal.aborted) { close(); return; }
        request.signal.addEventListener('abort', detach, { once: true });
        try {
          metadata();
          observation.listen(e => {
            if (done || finishing) return;
            try {
              if (known && e.runId && e.runId !== known.runId && e.type !== 'snapshot') return;
              if (['adapter_stream_error', 'stream_error', 'error'].includes(e.type)) throw new BotAdapterError(503, 'STREAM_INTERRUPTED', 'Bot stream disconnected; reconnect to inspect the run');
              transcript.apply(e);
              if (known && e.runId === known.runId && (e.type !== 'snapshot' || transcript.busy || terminal(known))) active = true;
              if (!targetUserId && transcript.latestUserId !== baselineUser && (!known || e.runId === undefined || e.runId === known.runId)) {
                active = true; targetUserId = transcript.latestUserId;
              }
              if (e.type === 'run_settled' && (!known || e.runId === undefined || e.runId === known.runId)) {
                const current = run(e.data); if (current.sessionId !== sessionId || known && current.runId !== known.runId) invalid();
                known = current; metadata(); void settle(); return;
              }
              if (e.type === 'run_end' && !known) throw new BotAdapterError(503, 'RUN_STATUS_UNKNOWN', 'Run ended without an authoritative status; inspect history');
              if (['auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end', 'deferred_poll'].includes(e.type)) {
                const attempt = record(e.data).attempt;
                send({ type: 'data-bot-progress', data: { type: e.type, ...(Number.isSafeInteger(attempt) && attempt >= 0 ? { attempt } : {}) }, transient: true });
              }
              if (known && e.runId && e.runId !== known.runId && !replay) return;
              emit();
            } catch (error) { fail(error); }
          }, error => { if (!finishing) fail(error); });
          if (!done) {
            emit();
            if (known) { if (terminal(known)) void settle(); else void check(); }
            else if (!transcript.busy) { emitter.finish(); send({ type: 'finish', finishReason: 'stop' }); close(); }
          }
        } catch (error) { fail(error); }
      },
      cancel() { if (!done) { done = true; cleanup(); } },
    }, { highWaterMark: LIMITS.bufferBytes, size: chunk => Buffer.byteLength(JSON.stringify(chunk)) });
    return createUIMessageStreamResponse({ stream: chunks, headers: { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  };
  return {
    async chat(request) {
      try { const body = await input(request); if (request.signal.aborted) throw new BotAdapterError(400, 'REQUEST_ABORTED', 'Request was disconnected');
        const accepted = await accept(body); return await stream(request, accepted.sessionId, accepted); }
      catch (error) { return errorResponse(error); }
    },
    async resume(request, sessionId, runId) {
      try {
        if (request.method !== 'GET') throw new BotAdapterError(405, 'METHOD_NOT_ALLOWED', 'Expected GET');
        id(sessionId, 'session ID');
        let current: BotRun | undefined;
        if (runId !== undefined) { id(runId, 'run ID'); current = run(await backend.getRun(runId)); if (current.runId !== runId) invalid();
          if (current.sessionId !== sessionId) throw new BotAdapterError(400, 'SESSION_MISMATCH', 'Run does not belong to this session'); }
        return await stream(request, sessionId, current, true);
      } catch (error) { return errorResponse(error); }
    },
    async history(sessionId) {
      try {
        id(sessionId, 'session ID'); const session = sessions(await backend.listSessions()).find(item => item.sessionId === sessionId);
        if (!session) throw new BotAdapterError(404, 'NOT_FOUND', 'Bot session was not found');
        const initial = await snapshot(backend, sessionId); const transcript = new Transcript(sessionId); transcript.apply(initial);
        const current = initial.runId ? run(await backend.getRun(initial.runId)) : undefined;
        if (current && (current.sessionId !== sessionId || current.runId !== initial.runId)) invalid();
        return { messages: transcript.messages, session, ...(current ? { run: current } : {}) };
      } catch (error) { throw safeError(error); }
    },
    async sessions() { try { return sessions(await backend.listSessions()); } catch (error) { throw safeError(error); } },
    async info() { try { return info(await backend.info()); } catch (error) { throw safeError(error); } },
    async cancel(runId) { try { id(runId, 'run ID'); await backend.cancel(runId); } catch (error) { throw safeError(error); } },
  };
}
