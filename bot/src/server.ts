import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { BotEvent, BotHandle, BotRunRecord, OpenBotOptions } from "./types.js";

export interface ServeOptions extends OpenBotOptions {
  host?: string;
  port?: number;
  /** Omitted: no caller authentication, on every bind address. */
  authToken?: string;
  /** Injected handles remain caller-owned, including after failed startup. */
  bot?: BotHandle;
  /** Optional runtime factory; unlike `bot`, its returned handle is owned and closed by the server. */
  openBot?: (source: string, options: OpenBotOptions) => Promise<BotHandle>;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxStreamBufferBytes?: number;
  maxStreams?: number;
}
export interface BotServer {
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Validate only explicitly supplied tokens; never derives a token from the bind address. */
export function validateAuthToken(token: unknown): asserts token is string | undefined {
  if (token !== undefined && (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))) {
    throw new Error("authToken must be a non-empty string without line breaks");
  }
}
function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
const terminal = (run: BotRunRecord) => ["completed", "failed", "cancelled"].includes(run.status);
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
/** Content negotiation for POST /v1/runs: NDJSON streams the run; anything else waits for acceptance only. */
function wantsStream(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").split(",").some(type => type.split(";", 1)[0].trim().toLowerCase() === "application/x-ndjson");
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    req.resume();
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit");
  }
  const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    req.resume();
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError); req.off("aborted", onAborted);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new HttpError(400, "BAD_REQUEST", "Request was interrupted"));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup(); req.resume();
        reject(new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit"));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      if (!size) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "INVALID_JSON", "Malformed JSON body")); }
    };
    req.on("data", onData); req.on("end", onEnd); req.on("error", onError); req.on("aborted", onAborted);
  });
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_BODY", "Expected a JSON object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, "INVALID_BODY", `Unknown field: ${unknown[0]}`);
  return body;
}
function stringField(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 100_000 || /\u0000/.test(value)) {
    throw new HttpError(400, "INVALID_BODY", `${key} must be a non-empty string`);
  }
  return value;
}
function pathSegments(target: string): string[] {
  if (!target.startsWith("/")) throw new HttpError(400, "INVALID_PATH", "Invalid request path");
  return target.split("?", 1)[0].slice(1).split("/").map(part => {
    let value: string;
    try { value = decodeURIComponent(part); }
    catch { throw new HttpError(400, "INVALID_PATH", "Invalid path encoding"); }
    if (/[\/\\\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") {
      throw new HttpError(400, "INVALID_PATH", "Invalid path segment");
    }
    return value;
  });
}
function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  // Runtime errors with stable codes can cross this boundary; arbitrary exceptions cannot leak credentials.
  const code = (error as { code?: unknown })?.code;
  if (code === "UNAVAILABLE") return new HttpError(503, code, "Bot is currently unavailable");
  if (code === "NOT_FOUND" || code === "INVALID_INPUT" || code === "CONFLICT") {
    const status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return new HttpError(status, code, error instanceof Error ? error.message : code);
  }
  return new HttpError(500, "INTERNAL_ERROR", "Bot operation failed");
}

/** Serve a single configured bot. Callers cannot override its workspace, source or state paths. */
export async function serve(source: string, options: ServeOptions = {}): Promise<BotServer> {
  validateAuthToken(options.authToken);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  if (typeof host !== "string" || !host.trim()) throw new Error("host must be non-empty");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
  const bodyLimit = positive(options.maxBodyBytes, 64 * 1024, "maxBodyBytes");
  const responseLimit = positive(options.maxResponseBytes, 4 * 1024 * 1024, "maxResponseBytes");
  const streamLimit = positive(options.maxStreamBufferBytes, 1024 * 1024, "maxStreamBufferBytes");
  const maxStreams = positive(options.maxStreams, 64, "maxStreams");
  const tokenHash = options.authToken === undefined ? undefined : digest(`Bearer ${options.authToken}`);
  if (options.bot && options.openBot) throw new Error("Supply bot or openBot, not both");
  const open = options.bot ? undefined : options.openBot ?? (await import("./worker-client.js")).openBotProcess;
  const bot = options.bot ?? await open!(source, {
    cwd: options.cwd, stateDir: options.stateDir, model: options.model, thinking: options.thinking,
    models: options.models, agentDir: options.agentDir, ephemeral: options.ephemeral,
  });
  const shutdown = new AbortController();
  const sockets = new Set<Socket>();
  const streams = new Set<() => Promise<void>>();
  const operations = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > responseLimit) throw new HttpError(502, "RESPONSE_TOO_LARGE", "Bot response exceeds the configured limit");
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(text);
  };
  const fail = (res: ServerResponse, error: unknown) => {
    if (res.headersSent) { res.destroy(); return; }
    const e = asHttpError(error);
    // Errors themselves must remain deliverable even when a very small output limit was configured.
    const text = JSON.stringify({ error: { code: e.code, message: e.message } });
    res.writeHead(e.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(e.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}), ...(e.status === 413 ? { Connection: "close" } : {}) });
    res.end(text);
  };
  /** Bounded NDJSON writer. Lines sent before open() wait in the same bounded queue. */
  const ndjson = (res: ServerResponse, release: () => Promise<void> | void) => {
    if (streams.size >= maxStreams) throw new HttpError(503, "STREAM_LIMIT", "Too many active streams");
    let done = false;
    let cleanupPromise: Promise<void> | undefined;
    let ready = false;
    let queued: string[] = [];
    let queuedBytes = 0;
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      done = true;
      queued = []; queuedBytes = 0;
      streams.delete(cleanup);
      res.off("drain", drain);
      res.off("close", onClose);
      res.off("error", onClose);
      cleanupPromise = Promise.resolve().then(release).then(() => undefined);
      return cleanupPromise;
    };
    const onClose = () => { void cleanup().catch(() => {}); };
    const drain = () => {
      if (done || !ready) return;
      while (queued.length && !res.destroyed) {
        const line = queued.shift()!; queuedBytes -= Buffer.byteLength(line);
        if (!res.write(line)) break;
      }
    };
    const serialize = (event: unknown): string | undefined => {
      let line: string;
      try { line = JSON.stringify(event) + "\n"; } catch { res.destroy(); onClose(); return undefined; }
      if (Buffer.byteLength(line) + queuedBytes + res.writableLength > streamLimit) { res.destroy(); onClose(); return undefined; }
      return line;
    };
    streams.add(cleanup);
    res.on("close", onClose); res.on("error", onClose); res.on("drain", drain);
    return {
      get done() { return done; },
      cleanup,
      send(event: unknown) {
        if (done) return;
        const line = serialize(event); if (line === undefined) return;
        if (!ready || queued.length || res.writableNeedDrain) { queued.push(line); queuedBytes += Buffer.byteLength(line); }
        else res.write(line);
      },
      open(first?: unknown) {
        if (done) return;
        const line = first === undefined ? undefined : serialize(first);
        if (first !== undefined && line === undefined) return;
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.flushHeaders(); ready = true;
        if (line) res.write(line);
        drain();
      },
      /** Flush the bounded queue regardless of backpressure, then finish the response. */
      end() {
        if (done) return;
        for (const line of queued) res.write(line);
        queued = []; queuedBytes = 0;
        res.end(); void cleanup().catch(() => {});
      },
    };
  };
  const stream = async (res: ServerResponse, session: string) => {
    let unsubscribe: (() => Promise<void>) | undefined;
    const out = ndjson(res, () => unsubscribe?.());
    try {
      // watch owns snapshot semantics. Events may arrive before its asynchronous unsubscribe handle.
      unsubscribe = await bot.watch(session, event => out.send(event));
      if (out.done || closing) { await unsubscribe(); await out.cleanup(); return; }
      out.open();
    } catch (error) { await out.cleanup(); throw error; }
  };
  /**
   * One run as NDJSON: run_accepted, then its post-admission events, then run_settled with the terminal record.
   * Snapshots (prior conversation state) are omitted. Disconnecting never cancels the run.
   */
  const runStream = async (res: ServerResponse, message: string, session?: string, requestId?: string) => {
    const stopped = new AbortController();
    const out = ndjson(res, () => stopped.abort());
    let settle!: (record: BotRunRecord) => void;
    const settled = new Promise<BotRunRecord>(resolve => settle = resolve);
    let forwarded = false;
    const listener = (event: BotEvent) => {
      if (event.type === "snapshot" || out.done || forwarded) return;
      out.send(event);
      if (event.type === "run_settled") { forwarded = true; settle(event.data as BotRunRecord); }
    };
    try {
      const accepted = await bot.submit(message, { session, requestId, onEvent: listener });
      if (out.done || closing) { await out.cleanup(); return; }
      out.open({ type: "run_accepted", sessionId: accepted.sessionId, runId: accepted.runId, data: accepted });
      // run_settled is authoritative. Polling only covers handles that never emit it.
      let record = terminal(accepted) ? accepted : undefined;
      while (!record && !stopped.signal.aborted) {
        record = await Promise.race([settled, delay(1_000, stopped.signal).then(() => undefined)]);
        if (record || stopped.signal.aborted) break;
        const current = await bot.getRun(accepted.runId);
        if (terminal(current)) record = await Promise.race([settled, delay(250, stopped.signal).then(() => current)]);
      }
      if (!record || out.done) return;
      if (!forwarded) out.send({ type: "run_settled", sessionId: record.sessionId, runId: record.runId, data: record });
      out.end();
    } catch (error) { await out.cleanup(); throw error; }
  };
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    if (closing) throw new HttpError(503, "CLOSING", "Server is shutting down");
    const parts = pathSegments(req.url ?? "/");
    const method = req.method;
    if (method === "GET" && parts.length === 1 && parts[0] === "health") { json(res, 200, { ok: true }); return; }
    if (tokenHash && !timingSafeEqual(tokenHash, digest(req.headers.authorization ?? ""))) throw new HttpError(401, "UNAUTHORIZED", "A valid bearer token is required");
    const [version, resource, id, action] = parts;
    if (version !== "v1") throw new HttpError(404, "NOT_FOUND", "Unknown endpoint");
    if (method === "GET" && resource === "info" && parts.length === 2) { json(res, 200, await bot.info()); return; }
    if (method === "GET" && resource === "sessions" && parts.length === 2) { json(res, 200, await bot.listSessions()); return; }
    if (method === "GET" && resource === "sessions" && id && action === "stream" && parts.length === 4) { await stream(res, id); return; }
    if (method === "GET" && resource === "runs" && id && parts.length === 3) { json(res, 200, await bot.getRun(id)); return; }
    if (method === "POST" && resource === "runs" && parts.length === 2) {
      const body = object(await readBody(req, bodyLimit), ["message", "session", "requestId"]);
      const message = stringField(body, "message", true)!;
      const session = stringField(body, "session"); const requestId = stringField(body, "requestId");
      if (wantsStream(req)) { await runStream(res, message, session, requestId); return; }
      json(res, 202, await bot.submit(message, { session, requestId })); return;
    }
    if (method === "POST" && resource === "runs" && id && action === "cancel" && parts.length === 4) {
      object(await readBody(req, bodyLimit), []);
      try { await bot.cancel(id); }
      catch (error) {
        if ((error as { code?: unknown })?.code === "UNAVAILABLE") {
          throw new HttpError(503, "UNAVAILABLE", "Cancellation was not durably confirmed; work may be suspended. Inspect the run before retrying.");
        }
        throw error;
      }
      json(res, 200, { ok: true }); return;
    }
    if (method === "POST" && resource === "tools" && id && parts.length === 3) {
      const body = object(await readBody(req, bodyLimit), ["input", "session"]);
      if (!Object.hasOwn(body, "input")) throw new HttpError(400, "INVALID_BODY", "input is required");
      const session = stringField(body, "session");
      json(res, 200, await bot.callTool(id, body.input, { session, signal: shutdown.signal })); return;
    }
    if (method === "POST" && resource === "reload" && parts.length === 2) {
      object(await readBody(req, bodyLimit), []); json(res, 200, await bot.reload()); return;
    }
    req.resume();
    throw new HttpError(404, "NOT_FOUND", "Unknown endpoint");
  };
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const operation = route(req, res).catch(error => { req.resume(); if (!res.destroyed) fail(res, error); });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.maxHeadersCount = 100;
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListen); reject(error); };
      const onListen = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListen); server.listen(port, host);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (!options.bot) await bot.close().catch(() => {});
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP address");
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    close() {
      return closePromise ??= (async () => {
        closing = true;
        shutdown.abort(new Error("Bot server is shutting down"));
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const cleanup = await Promise.allSettled([...streams].map(stop => stop()));
        for (const socket of sockets) socket.destroy();
        // An internally owned runtime must be closed to cancel admitted work before waiting for handlers.
        let runtimeError: unknown;
        if (!options.bot) { try { await bot.close(); } catch (error) { runtimeError = error; } }
        await stopped;
        await Promise.allSettled([...operations]);
        if (runtimeError) throw runtimeError;
        const failed = cleanup.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
    },
  };
}
