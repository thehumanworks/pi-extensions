import { fork } from "node:child_process";
import type { Writable } from "node:stream";
import { BotError } from "./errors.js";
import { WorkerProcessTree } from "./worker-tree.js";
import { DEFAULT_MESSAGE_LIMIT, ERROR_CODES, messageBytes, validId, type WorkerInput, type WorkerMethod, type WorkerMethods, type WorkerOutput } from "./worker-protocol.js";
import type { BotEvent, BotHandle, BotInfo, BotRunRecord, OpenBotOptions, RunOptions } from "./types.js";

export interface WorkerOptions {
  initTimeoutMs?: number;
  closeTimeoutMs?: number;
  killTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPendingRequests?: number;
  maxDiagnosticsBytes?: number;
  diagnostics?: Pick<Writable, "write">;
  /** @internal Trusted compiled worker override, for deterministic transport tests only. */
  workerUrl?: URL;
}
const unavailable = (message: string) => new BotError("UNAVAILABLE", message);
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) throw new Error(`${name} must be a positive integer <= 2147483647`);
  return result;
}
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function terminal(run: BotRunRecord): boolean { return ["completed", "failed", "cancelled"].includes(run.status); }
function validRun(value: unknown): value is BotRunRecord {
  const run = value as BotRunRecord | null;
  return !!run && typeof run.runId === "string" && typeof run.sessionId === "string" && ["queued", "running", "completed", "failed", "cancelled"].includes(run.status);
}
function validInfo(value: unknown): value is BotInfo {
  const info = value as BotInfo | null;
  return !!info && info.format === 2 && typeof info.sourceDir === "string" && typeof info.stateDir === "string";
}
interface Pending { method: WorkerMethod; resolve(value: unknown): void; reject(error: unknown): void }
interface Channel { listener?: (event: BotEvent) => void; removeAbort?: () => void; timer?: NodeJS.Timeout }

/**
 * Open the same Pi-backed runtime in an SDK-owned Node process (not the pi executable).
 * Custom Models are executable objects and cannot cross IPC: options.models explicitly uses
 * the embedded runtime instead, without process-tree isolation or worker lifecycle timeouts.
 */
export async function openBotProcess(source: string, options: OpenBotOptions = {}, workerOptions: WorkerOptions = {}): Promise<BotHandle> {
  if (options.models !== undefined) return (await import("./runtime.js")).openBot(source, options);
  const initTimeout = limit(workerOptions.initTimeoutMs, 30_000, "initTimeoutMs");
  const closeTimeout = limit(workerOptions.closeTimeoutMs, 3_000, "closeTimeoutMs");
  const killTimeout = limit(workerOptions.killTimeoutMs, 250, "killTimeoutMs");
  const cancelTimeout = limit(workerOptions.cancellationTimeoutMs, 5_000, "cancellationTimeoutMs");
  const messageLimit = limit(workerOptions.maxMessageBytes, DEFAULT_MESSAGE_LIMIT, "maxMessageBytes");
  const pendingLimit = limit(workerOptions.maxPendingRequests, 256, "maxPendingRequests");
  const diagnosticLimit = limit(workerOptions.maxDiagnosticsBytes, 64 * 1024, "maxDiagnosticsBytes");
  const diagnostics = workerOptions.diagnostics ?? process.stderr;
  const env = { ...process.env };
  // Do not accidentally inherit inspectors, TS loaders or node:test process flags. Preserve Pi auth env.
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const child = fork(workerOptions.workerUrl ?? new URL("../dist/worker.js", import.meta.url), [], {
    execArgv: [], env, detached: process.platform !== "win32", serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pending = new Map<number, Pending>();
  const channels = new Map<number, Channel>();
  let nextId = 0; let queuedBytes = 0; let diagnosticBytes = 0;
  let closing = false; let exited = false; let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanupTree: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>(resolve => resolveExit = resolve);
  const tree = child.pid && child.pid !== process.pid ? new WorkerProcessTree(child.pid) : undefined;
  const signalTree = (signal: NodeJS.Signals): boolean => tree?.signal(signal) ?? false;
  const reapTree = (): Promise<void> => cleanupTree ??= (async () => {
    if (signalTree("SIGTERM")) { await sleep(killTimeout); signalTree("SIGKILL"); }
  })();
  const removeChannel = (id: number) => {
    const channel = channels.get(id);
    channel?.removeAbort?.(); if (channel?.timer) clearTimeout(channel.timer);
    channels.delete(id);
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const value of pending.values()) value.reject(failure);
    pending.clear();
    for (const [id, channel] of channels) {
      try { channel.listener?.({ type: "error", data: { code: "UNAVAILABLE", message: failure.message } }); } catch { /* observers cannot stop cleanup */ }
      removeChannel(id);
    }
  };
  const send = (message: WorkerInput) => {
    if (!child.connected || exited) throw failure ?? unavailable("Bot worker is disconnected");
    let bytes: number;
    try { bytes = messageBytes(message); } catch { throw new BotError("INVALID_INPUT", "Worker requests must be JSON serializable"); }
    if (bytes > messageLimit) throw new BotError("INVALID_INPUT", "Worker request exceeds the IPC message limit");
    if (queuedBytes + bytes > messageLimit * 2) throw unavailable("Bot worker IPC is backpressured");
    queuedBytes += bytes;
    try {
      child.send(message, error => {
        queuedBytes -= bytes;
        if (error && !closing) { fail(unavailable("Cannot communicate with bot worker")); void close().catch(() => {}); }
      });
    } catch (error) { queuedBytes -= bytes; throw error; }
  };
  function request<M extends WorkerMethod>(method: M, params: WorkerMethods[M]["input"], control: { signal?: AbortSignal; onEvent?: (event: BotEvent) => void } = {}): { id: number; result: Promise<WorkerMethods[M]["output"]> } {
    const id = ++nextId;
    const result = new Promise<WorkerMethods[M]["output"]>((resolve, reject) => {
      if ((closing && method !== "close") || failure || exited) { reject(failure ?? unavailable("Bot worker is closed")); return; }
      const controlCall = method === "close" || method === "unwatch" || method === "cancel";
      const capacity = pendingLimit + (controlCall ? 8 : 0);
      if (pending.size >= capacity || channels.size >= capacity) { reject(unavailable("Too many pending worker operations")); return; }
      if (control.signal?.aborted) { reject(control.signal.reason); return; }
      const channel: Channel = { listener: control.onEvent };
      channels.set(id, channel);
      pending.set(id, { method, resolve: value => resolve(value as WorkerMethods[M]["output"]), reject });
      if (method === "cancel") {
        channel.timer = setTimeout(() => {
          fail(unavailable("Cancellation was not durably confirmed; stopping the worker to suspend work. Reopen and inspect the run before retrying."));
          void close().catch(() => {});
        }, cancelTimeout);
      }
      if (control.signal) {
        const abort = () => {
          try { send({ type: "abort", id }); } catch { /* exit/failure rejects the request */ }
          channel.timer ??= setTimeout(() => {
            fail(unavailable("Bot worker did not settle explicit cancellation"));
            void close().catch(() => {});
          }, cancelTimeout);
        };
        control.signal.addEventListener("abort", abort, { once: true });
        channel.removeAbort = () => control.signal!.removeEventListener("abort", abort);
      }
      try { send({ type: "request", id, method, params } as WorkerInput); }
      catch (error) { pending.delete(id); removeChannel(id); reject(error); }
    });
    return { id, result };
  }
  async function waitForExit(ms: number): Promise<void> {
    if (exited) return;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  function close(): Promise<void> {
    return closePromise ??= (async () => {
      closing = true;
      if (!exited && child.connected && !failure) void request("close", undefined).result.catch(() => {});
      if (!exited) await waitForExit(closeTimeout);
      if (!exited) {
        signalTree("SIGTERM");
        await waitForExit(killTimeout);
        if (!exited) signalTree("SIGKILL");
      }
      await waitForExit(killTimeout);
      await reapTree();
      fail(unavailable("Bot worker is closed"));
      child.stdout?.destroy(); child.stderr?.destroy();
      if (child.connected) child.disconnect();
      if (!exited) { child.unref(); throw unavailable("Bot worker did not exit after SIGKILL"); }
    })();
  }
  child.on("message", (raw: unknown) => {
    const message = raw as WorkerOutput;
    if (!message || !validId(message.id) || messageBytes(message) > messageLimit) {
      fail(unavailable("Invalid bot worker protocol message")); void close().catch(() => {}); return;
    }
    if (message.type === "event") {
      if (!message.event || typeof message.event.type !== "string") { fail(unavailable("Invalid bot worker event")); void close().catch(() => {}); return; }
      try { channels.get(message.id)?.listener?.(message.event); } catch { /* observer callbacks do not break IPC */ }
    } else if (message.type === "settled") removeChannel(message.id);
    else if (message.type === "reply") {
      const waiter = pending.get(message.id); if (!waiter) return;
      if (typeof message.ok !== "boolean"
        || (message.ok && ["init", "info"].includes(waiter.method) && !validInfo(message.value))
        || (message.ok && ["submit", "run", "getRun"].includes(waiter.method) && !validRun(message.value))
        || (!message.ok && (!message.error || typeof message.error.message !== "string"))) {
        fail(unavailable("Invalid bot worker reply")); void close().catch(() => {}); return;
      }
      pending.delete(message.id);
      const keep = message.ok && (waiter.method === "watch" || (waiter.method === "submit" && !terminal(message.value as BotRunRecord)));
      if (!keep) removeChannel(message.id);
      if (message.ok) waiter.resolve(message.value);
      else {
        const wire = message.error;
        const error = wire?.code && ERROR_CODES.has(wire.code) ? new BotError(wire.code, wire.message) : new Error(wire?.message ?? "Bot worker operation failed");
        error.name = wire?.name ?? error.name; waiter.reject(error);
      }
    } else { fail(unavailable("Unknown bot worker protocol message")); void close().catch(() => {}); }
  });
  const onExit = () => {
    if (exited) return;
    exited = true; resolveExit();
    fail(unavailable(closing ? "Bot worker is closed" : "Bot worker exited unexpectedly"));
    void reapTree().catch(() => {});
  };
  child.on("exit", onExit);
  child.on("error", () => { fail(unavailable("Cannot start bot worker")); onExit(); });
  child.on("disconnect", () => {
    if (!closing && !exited) { fail(unavailable("Bot worker disconnected unexpectedly")); void close().catch(() => {}); }
  });
  const diagnostic = (chunk: Buffer) => {
    if (diagnosticBytes >= diagnosticLimit) return;
    const available = diagnosticLimit - diagnosticBytes;
    const part = chunk.subarray(0, available); diagnosticBytes += part.byteLength;
    try { diagnostics.write(part); if (chunk.byteLength > available) diagnostics.write("\n[bot worker diagnostics truncated]\n"); } catch { /* diagnostics cannot break worker lifecycle */ }
  };
  child.stdout?.on("data", diagnostic); child.stderr?.on("data", diagnostic);
  let initTimer: NodeJS.Timeout | undefined;
  let info: BotInfo;
  try {
    const { models: _models, ...serializable } = options;
    info = await Promise.race([
      request("init", { source, options: serializable, closeTimeoutMs: closeTimeout, maxMessageBytes: messageLimit }).result,
      new Promise<never>((_resolve, reject) => { initTimer = setTimeout(() => reject(unavailable("Bot worker initialization timed out")), initTimeout); }),
    ]);
  } catch (error) { await close().catch(() => {}); throw error; }
  finally { if (initTimer) clearTimeout(initTimer); }
  const run = (method: "run" | "submit", message: string, opts: RunOptions = {}) => request(method, {
    message, options: { session: opts.session, cwd: opts.cwd, requestId: opts.requestId }, events: opts.onEvent !== undefined,
  }, { signal: opts.signal, onEvent: opts.onEvent }).result;
  return {
    sourceDir: info.sourceDir, stateDir: info.stateDir,
    info: () => request("info", undefined).result,
    submit: (message, opts) => run("submit", message, opts),
    run: (message, opts) => run("run", message, opts),
    getRun: runId => request("getRun", { runId }).result,
    listSessions: () => request("listSessions", undefined).result,
    async watch(sessionId, listener) {
      const subscription = request("watch", { sessionId }, { onEvent: listener });
      await subscription.result;
      let stopped: Promise<void> | undefined;
      return () => stopped ??= (async () => {
        try { if (!closing && !failure && !exited) await request("unwatch", { subscription: subscription.id }).result; }
        finally { removeChannel(subscription.id); }
      })();
    },
    async cancel(runId) { await request("cancel", { runId }).result; },
    callTool: (name, input, opts = {}) => request("callTool", { name, input, session: opts.session }, { signal: opts.signal }).result,
    reload: () => request("reload", undefined).result,
    close,
  };
}
