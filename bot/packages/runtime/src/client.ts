import type {
  BotEvent, BotInfo, BotRunRecord, BotSessionInfo, BotToolResult, ReloadResult, RunOptions,
} from "./types.js";

export class BotClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = "BotClientError";
  }
}
export interface ConnectBotOptions {
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  /** Bounds ordinary HTTP requests, including acceptance; idle watches have no timeout. */
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxEventBytes?: number;
}
export interface WatchOptions {
  signal?: AbortSignal;
  /** Called for unexpected stream failures, not intentional abort/unsubscribe. */
  onError?: (error: Error) => void;
}
const terminal = (run: BotRunRecord) => ["completed", "failed", "cancelled"].includes(run.status);
function abortError(): Error { return new DOMException("The operation was aborted", "AbortError"); }
function segment(value: string): string {
  if (!value || /[\/\\\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") throw new Error("Invalid resource identifier");
  return encodeURIComponent(value);
}
function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}
function runRecord(value: unknown): BotRunRecord {
  const record = value as BotRunRecord;
  if (!record || typeof record !== "object" || typeof record.runId !== "string" || !record.runId
    || typeof record.sessionId !== "string" || !record.sessionId || typeof record.output !== "string"
    || !["queued", "running", "completed", "failed", "cancelled"].includes(record.status)) {
    throw new BotClientError(502, "INVALID_RESPONSE", "Server returned an invalid run record");
  }
  return record;
}
const isNdjson = (response: Response) => !!response.body && !!response.headers.get("content-type")?.toLowerCase().startsWith("application/x-ndjson");
/** Bounded, validated NDJSON events. Cancel the reader to stop a pending read. */
async function* ndjson(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): AsyncGenerator<BotEvent> {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (line: string): BotEvent => {
    if (Buffer.byteLength(line) > limit) throw new BotClientError(502, "EVENT_TOO_LARGE", "Stream event exceeds the configured limit");
    let value: BotEvent;
    try { value = JSON.parse(line) as BotEvent; }
    catch { throw new BotClientError(502, "INVALID_EVENT", "Server returned malformed NDJSON"); }
    if (!value || typeof value !== "object" || typeof value.type !== "string") throw new BotClientError(502, "INVALID_EVENT", "Server returned an invalid event");
    return value;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (line.trim()) yield parse(line);
      }
      if (Buffer.byteLength(pending) > limit) throw new BotClientError(502, "EVENT_TOO_LARGE", "Stream event exceeds the configured limit");
      if (done) { if (pending.trim()) yield parse(pending); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
interface Acceptance { record: BotRunRecord; first?: BotEvent; events?: AsyncGenerator<BotEvent>; close(): void }
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0; let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new BotClientError(502, "RESPONSE_TOO_LARGE", "Server response exceeds the configured limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A remote bot uses the daemon's workspace and Pi credentials, not the client's. */
export class BotClient {
  readonly url: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;
  private readonly lifetime = new AbortController();
  private readonly watchers = new Set<() => Promise<void>>();
  private readonly cancellations = new Set<Promise<void>>();
  private closePromise: Promise<void> | undefined;
  private readonly pollInterval: number;
  private readonly requestTimeout: number;
  private readonly responseLimit: number;
  private readonly eventLimit: number;

  constructor(url: string, options: ConnectBotOptions = {}) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Bot URL must be HTTP(S), without credentials, query or fragment");
    }
    this.url = parsed.href.replace(/\/$/, "");
    if (options.authToken !== undefined && (typeof options.authToken !== "string" || !options.authToken.trim() || /[\r\n]/.test(options.authToken))) {
      throw new Error("authToken must be a non-empty string without line breaks");
    }
    this.headers = options.authToken === undefined ? {} : { Authorization: `Bearer ${options.authToken}` };
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.pollInterval = positive(options.pollIntervalMs, 100, "pollIntervalMs");
    this.requestTimeout = positive(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.responseLimit = positive(options.maxResponseBytes, 4 * 1024 * 1024, "maxResponseBytes");
    this.eventLimit = positive(options.maxEventBytes, 1024 * 1024, "maxEventBytes");
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }
  private async response(path: string, method: string, body?: unknown, signal?: AbortSignal, accept?: string): Promise<Response> {
    const response = await this.fetcher(`${this.url}${path}`, {
      method, headers: { ...this.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(accept ? { Accept: accept } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal(signal), redirect: "error",
    });
    if (!response.ok) {
      let error: { code?: unknown; message?: unknown } | undefined;
      try { error = (JSON.parse(await boundedText(response, this.responseLimit)) as { error?: typeof error }).error; }
      catch (cause) { if (cause instanceof BotClientError) throw cause; }
      throw new BotClientError(response.status, typeof error?.code === "string" ? error.code : "HTTP_ERROR",
        typeof error?.message === "string" ? error.message : `Bot server returned HTTP ${response.status}`);
    }
    return response;
  }
  private async json<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(this.requestTimeout), ...(signal ? [signal] : [])]);
    const response = await this.response(path, method, body, boundedSignal);
    const text = await boundedText(response, this.responseLimit);
    try { return JSON.parse(text) as T; }
    catch { throw new BotClientError(502, "INVALID_RESPONSE", "Server returned malformed JSON"); }
  }
  info(options: { signal?: AbortSignal } = {}): Promise<BotInfo> { return this.json("/v1/info", "GET", undefined, options.signal); }
  async submit(message: string, options: Pick<RunOptions, "session" | "requestId" | "signal"> = {}): Promise<BotRunRecord> {
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    return runRecord(await this.json("/v1/runs", "POST", { message, session: options.session, requestId: options.requestId }, options.signal));
  }
  async getRun(runId: string, options: { signal?: AbortSignal } = {}): Promise<BotRunRecord> {
    return runRecord(await this.json(`/v1/runs/${segment(runId)}`, "GET", undefined, options.signal));
  }
  async cancel(runId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.json(`/v1/runs/${segment(runId)}/cancel`, "POST", {}, options.signal);
  }
  listSessions(options: { signal?: AbortSignal } = {}): Promise<BotSessionInfo[]> { return this.json("/v1/sessions", "GET", undefined, options.signal); }
  callTool(name: string, input: unknown, options: { session?: string; signal?: AbortSignal } = {}): Promise<BotToolResult> {
    return this.json(`/v1/tools/${segment(name)}`, "POST", { input, session: options.session }, options.signal);
  }
  reload(options: { signal?: AbortSignal } = {}): Promise<ReloadResult> { return this.json("/v1/reload", "POST", {}, options.signal); }

  /** Disconnecting this watch never cancels server work. Reconnect to receive another current snapshot. */
  async watch(sessionId: string, listener: (event: BotEvent) => void, options: WatchOptions = {}): Promise<() => Promise<void>> {
    const controller = new AbortController();
    const signal = this.signal(options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal);
    const response = await this.response(`/v1/sessions/${segment(sessionId)}/stream`, "GET", undefined, signal);
    if (!isNdjson(response)) {
      await response.body?.cancel();
      throw new BotClientError(502, "INVALID_RESPONSE", "Expected an NDJSON event stream");
    }
    const reader = response.body!.getReader();
    const events = ndjson(reader, this.eventLimit);
    let task: Promise<void>;
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => stopPromise ??= (async () => {
      controller.abort();
      await reader.cancel().catch(() => {});
      await task;
    })();
    this.watchers.add(stop);
    task = (async () => {
      try {
        for await (const event of events) listener(event);
      } catch (error) {
        if (!signal.aborted) { try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* observer errors do not escape background tasks */ } }
      } finally { this.watchers.delete(stop); }
    })();
    return stop;
  }

  /**
   * Admission for run(). With an observer, ask for the run's NDJSON stream (Accept: application/x-ndjson) and read
   * its run_accepted line. Observed runs require this contract. Acceptance is bounded by
   * requestTimeoutMs and deliberately ignores the caller's signal, so an abort can still learn the ID to cancel.
   */
  private async accept(message: string, options: Pick<RunOptions, "session" | "requestId" | "onEvent">): Promise<Acceptance> {
    if (!options.onEvent) return { record: await this.submit(message, { session: options.session, requestId: options.requestId }), close() {} };
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), this.requestTimeout);
    try {
      const response = await this.response("/v1/runs", "POST", { message, session: options.session, requestId: options.requestId }, controller.signal, "application/x-ndjson");
      if (!isNdjson(response)) {
        await response.body?.cancel();
        throw new BotClientError(502, "INVALID_RESPONSE", "Expected an NDJSON run stream");
      }
      const reader = response.body!.getReader();
      const events = ndjson(reader, this.eventLimit);
      const first = await events.next();
      try {
        if (first.done || first.value.type !== "run_accepted") throw new BotClientError(502, "INVALID_RESPONSE", "Expected a run_accepted event");
        return { record: runRecord(first.value.data), first: first.value, events, close: () => { controller.abort(); void reader.cancel().catch(() => {}); } };
      } catch (error) { await events.return(undefined); throw error; }
    } catch (error) { controller.abort(); throw error; }
    finally { clearTimeout(timer); }
  }
  /** Forward a run stream until run_settled. Undefined means the stream ended early; the run itself continues. */
  private async forward(opened: Acceptance, listener: (event: BotEvent) => void): Promise<BotRunRecord | undefined> {
    const notify = (event: BotEvent) => { try { listener(event); } catch { /* observer failures never fail the run, as with local handles */ } };
    try {
      if (opened.first) notify(opened.first);
      for await (const event of opened.events!) {
        notify(event);
        if (event.type === "run_settled") return runRecord(event.data);
      }
    } catch { /* fall back to polling */ }
    return undefined;
  }

  /**
   * Submit then wait for a terminal record. With onEvent, the run's own event stream is read from the same request
   * with a final status poll if the connection is interrupted. Only an explicit run signal abort cancels
   * the admitted run.
   */
  async run(message: string, options: Pick<RunOptions, "session" | "requestId" | "signal" | "onEvent"> = {}): Promise<BotRunRecord> {
    const signal = this.signal(options.signal);
    signal.throwIfAborted();
    // Keep bounded acceptance IO alive to learn the ID, but reject the caller promptly on abort.
    // If the reply arrives later, cancel that run in the background. A lost acceptance reply is
    // inherently ambiguous; use requestId to retry safely. Closing the client alone never cancels.
    const acceptance = this.accept(message, options);
    let opened: Acceptance | undefined;
    let accepted: BotRunRecord | undefined;
    let cancelPromise: Promise<void> | undefined;
    const onAbort = () => {
      if (cancelPromise) return;
      cancelPromise = acceptance.then(({ record }) => this.cancel(record.runId, { signal: AbortSignal.timeout(5_000) }));
      this.cancellations.add(cancelPromise);
      const cleanup = () => this.cancellations.delete(cancelPromise!);
      void cancelPromise.then(cleanup, cleanup);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) { onAbort(); throw options.signal.reason ?? abortError(); }
      opened = await abortable(acceptance, signal);
      accepted = opened.record;
      signal.throwIfAborted();
      if (opened.events) {
        const settled = await abortable(this.forward(opened, options.onEvent!), signal);
        if (settled) return settled;
      } else if (terminal(accepted)) return accepted;
      while (true) {
        signal.throwIfAborted();
        const current = await this.getRun(accepted.runId, { signal });
        if (terminal(current)) return current;
        await delay(this.pollInterval, signal);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (opened) opened.close(); else void acceptance.then(late => late.close(), () => {});
      // An unobserved acceptance must not delay cancellation of the caller's wait.
      if (accepted) await cancelPromise?.catch(() => {});
    }
  }
  /** Abort IO, not server work. Finish any explicitly requested cancellation first (bounded HTTP waits). */
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      await Promise.allSettled([...this.cancellations]);
      this.lifetime.abort(new Error("Bot client is closed"));
      await Promise.all([...this.watchers].map(stop => stop()));
    })();
  }
}
export function connectBot(url: string, options: ConnectBotOptions = {}): BotClient { return new BotClient(url, options); }
