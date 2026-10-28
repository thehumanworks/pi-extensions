import { Worker } from "node:worker_threads";
import { BotError } from "./errors.js";
import { WorkerProcessTree } from "./worker-tree.js";
import { DEFAULT_MESSAGE_LIMIT, ERROR_CODES, WORKER_METHODS, messageBytes, validId, type WorkerError, type WorkerInput, type WorkerOutput, type WorkerRequest } from "./worker-protocol.js";
import type { BotHandle, BotRunRecord } from "./types.js";

// A separate isolate can still observe parent death / a close deadline while a trusted tool
// blocks this process's main event loop. No model, source, options or credentials enter it.
const watchdog = new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.treeUrl).then(({WorkerProcessTree}) => {
    const tree = new WorkerProcessTree(process.pid);
    function kill() { try { tree.signal('SIGKILL'); } finally { process.kill(process.pid, 'SIGKILL'); } }
    setInterval(() => { if (process.ppid !== workerData.parentPid) kill(); }, 100);
    parentPort.on('message', timeout => setTimeout(kill, timeout));
  });
`, { eval: true, execArgv: [], workerData: { parentPid: process.ppid, treeUrl: new URL('./worker-tree.js', import.meta.url).href } });
watchdog.unref();

// This executable owns one runtime. stdout/stderr are diagnostics only; protocol uses Node IPC.
let bot: BotHandle | undefined;
let opening: Promise<BotHandle> | undefined;
let closing = false;
let shutdownPromise: Promise<void> | undefined;
let closeTimeout = 3_000;
let messageLimit = DEFAULT_MESSAGE_LIMIT;
let queuedBytes = 0;
const controllers = new Map<number, AbortController>();
const subscriptions = new Map<number, Promise<() => Promise<void>>>();
// Observed submissions: resolved once run_settled has been forwarded, so the channel outlives it.
const reported = new Map<number, Promise<void>>();
const active = new Set<number>();
const terminal = (run: BotRunRecord) => ["completed", "failed", "cancelled"].includes(run.status);
function wireError(error: unknown): WorkerError {
  const value = error as { code?: string; name?: string; message?: string } | undefined;
  if (value?.code && ERROR_CODES.has(value.code)) return { name: "BotError", code: value.code as WorkerError["code"], message: value.message ?? value.code };
  if (value?.name === "AbortError") return { name: "AbortError", message: "The operation was aborted" };
  return { name: "BotError", code: "UNAVAILABLE", message: "Bot worker operation failed" };
}
async function send(message: WorkerOutput): Promise<void> {
  if (!process.connected || !process.send) return Promise.reject(new Error("Parent disconnected"));
  const bytes = messageBytes(message);
  if (bytes > messageLimit || queuedBytes + bytes > messageLimit * 2) return Promise.reject(new BotError("UNAVAILABLE", "Bot worker IPC limit exceeded"));
  queuedBytes += bytes;
  return new Promise((resolve, reject) => process.send!(message, error => {
    queuedBytes -= bytes;
    if (error) reject(error); else resolve();
  }));
}
function event(id: number, value: Parameters<Parameters<BotHandle["watch"]>[1]>[0]) {
  if (closing) return;
  void send({ type: "event", id, event: value }).catch(() => { void shutdown(); });
}
function forceExit(): never {
  // Only our own PID's group is targeted. A direct (non-group-leader) invocation cannot hit its parent group.
  try { new WorkerProcessTree(process.pid).signal("SIGKILL"); } catch { /* own process is always the final fallback */ }
  process.exit(1);
}
function shutdown(replyId?: number): Promise<void> {
  return shutdownPromise ??= (async () => {
    closing = true;
    watchdog.postMessage(closeTimeout);
    const deadline = setTimeout(forceExit, closeTimeout);
    try {
      // Do not abort run controllers: runtime.close suspends durable accepted work at its checkpoint.
      // If initialization finishes after disconnect, close that late handle rather than orphaning it.
      await opening?.catch(() => {});
      await Promise.allSettled([...subscriptions.values()].map(async subscription => (await subscription)()));
      subscriptions.clear();
      await bot?.close();
      if (replyId !== undefined && process.connected) await send({ type: "reply", id: replyId, ok: true, value: null });
    } catch { /* parent enforces its own deadline too; never print source/options/auth */ }
    finally {
      clearTimeout(deadline);
      if (process.connected) process.disconnect();
      process.exit(0);
    }
  })();
}
async function settled(id: number, initial: BotRunRecord) {
  try {
    let current = initial;
    while (!closing && !terminal(current)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!closing) current = await bot!.getRun(initial.runId);
    }
    const forwarded = reported.get(id);
    if (forwarded && !closing) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([forwarded, new Promise(resolve => { timer = setTimeout(resolve, 1_000); })]);
      clearTimeout(timer);
    }
  } catch { /* runtime closure/exit is reported by transport lifecycle */ }
  finally {
    controllers.delete(id); reported.delete(id);
    if (!closing) await send({ type: "settled", id }).catch(() => { void shutdown(); });
  }
}
async function dispatch(request: WorkerRequest): Promise<unknown> {
  if (request.method === "close") { await shutdown(request.id); return null; }
  if (closing) throw new BotError("UNAVAILABLE", "Bot worker is closing");
  if (request.method === "init") {
    if (opening) throw new BotError("CONFLICT", "Bot worker is already initialized");
    const params = request.params;
    if (!params || typeof params.source !== "string" || !params.source || !params.options || typeof params.options !== "object"
      || !Number.isSafeInteger(params.closeTimeoutMs) || params.closeTimeoutMs < 1
      || !Number.isSafeInteger(params.maxMessageBytes) || params.maxMessageBytes < 1) throw new BotError("INVALID_INPUT", "Invalid worker initialization");
    closeTimeout = params.closeTimeoutMs; messageLimit = params.maxMessageBytes;
    opening = (async () => {
      const { openBot } = await import("./runtime.js");
      bot = await openBot(params.source, params.options);
      return bot;
    })();
    await opening;
    if (closing) throw new BotError("UNAVAILABLE", "Bot worker closed during initialization");
    return bot!.info();
  }
  if (!bot) throw new BotError("UNAVAILABLE", "Bot worker is not initialized");
  switch (request.method) {
    case "info": return bot.info();
    case "getRun": return bot.getRun(request.params.runId);
    case "listSessions": return bot.listSessions();
    case "reload": return bot.reload();
    case "cancel": await bot.cancel(request.params.runId); return null;
    case "watch": {
      const subscription = bot.watch(request.params.sessionId, value => event(request.id, value));
      subscriptions.set(request.id, subscription);
      try { await subscription; } catch (error) { subscriptions.delete(request.id); throw error; }
      return null;
    }
    case "unwatch": {
      const subscription = subscriptions.get(request.params.subscription);
      subscriptions.delete(request.params.subscription);
      if (subscription) await (await subscription)();
      return null;
    }
    case "callTool": {
      const controller = new AbortController(); controllers.set(request.id, controller);
      try { return await bot.callTool(request.params.name, request.params.input, { session: request.params.session, signal: controller.signal }); }
      finally { controllers.delete(request.id); }
    }
    case "run": case "submit": {
      const controller = new AbortController(); controllers.set(request.id, controller);
      let forwarded = () => {};
      if (request.method === "submit" && request.params.events) reported.set(request.id, new Promise<void>(resolve => forwarded = resolve));
      const options = { ...request.params.options, signal: controller.signal,
        ...(request.params.events ? { onEvent: (value: Parameters<typeof event>[1]) => { event(request.id, value); if (value.type === "run_settled") forwarded(); } } : {}) };
      try {
        const record = await bot[request.method](request.params.message, options);
        return record;
      } finally { if (request.method === "run") controllers.delete(request.id); }
    }
  }
}
process.on("message", (raw: unknown) => {
  const request = raw as WorkerInput;
  if (!request || !validId(request.id) || messageBytes(request) > messageLimit) { void shutdown(); return; }
  if (request.type === "abort") { controllers.get(request.id)?.abort(new DOMException("The operation was aborted", "AbortError")); return; }
  if (request.type !== "request" || !WORKER_METHODS.has(request.method) || active.has(request.id)) { void shutdown(); return; }
  if (active.size >= 256 && request.method !== "close") {
    void send({ type: "reply", id: request.id, ok: false, error: { name: "BotError", code: "UNAVAILABLE", message: "Too many worker operations" } }).catch(() => { void shutdown(); }); return;
  }
  active.add(request.id);
  void (async () => {
    try {
      const value = await dispatch(request);
      if (request.method !== "close") await send({ type: "reply", id: request.id, ok: true, value: value ?? null });
      if (request.method === "submit") void settled(request.id, value as BotRunRecord);
    } catch (error) {
      controllers.delete(request.id); reported.delete(request.id);
      await send({ type: "reply", id: request.id, ok: false, error: wireError(error) }).catch(() => { void shutdown(); });
    } finally { active.delete(request.id); }
  })();
});
process.once("disconnect", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
if (!process.send) process.exitCode = 1;
