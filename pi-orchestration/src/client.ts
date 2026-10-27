import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowError } from "./errors.ts";
import { workflowPaths } from "./paths.ts";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION, validateRequest, type ControlRequest, type ControlResponse, type WorkerStatus } from "./protocol.ts";

export interface ClientOptions { home?: string; signal?: AbortSignal; timeoutMs?: number }
export function assertRootLaunch(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PI_WORKFLOW_RUN_ID) throw new WorkflowError("not_from_root", `Workflows are launched by the user or the root Pi session, not from inside an agent (run ${env.PI_WORKFLOW_RUN_ID}, step ${env.PI_WORKFLOW_STEP ?? "unknown"}). Compose with ctx.workflow() in the workflow file instead.`);
}
export function assertUnattended(env: NodeJS.ProcessEnv = process.env): void {
  assertRootLaunch(env);
  if (env.PI_WORKFLOW_ALLOW_UNATTENDED !== "1") throw new WorkflowError("unattended_forbidden", "Headless workflow launches require PI_WORKFLOW_ALLOW_UNATTENDED=1. Workflow files are trusted code with your filesystem and shell permissions.");
}
export async function rpc<R = unknown>(input: ControlRequest, options: ClientOptions = {}): Promise<R> {
  options.signal?.throwIfAborted();
  if (input.action === "run") assertRootLaunch();
  const request = validateRequest(input);
  const serialized = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new WorkflowError("invalid_request", "Workflow request exceeds 1 MiB. Put large inputs in files and pass paths as arguments.");
  return new Promise<R>((resolve, reject) => {
    const socket = createConnection(workflowPaths(options.home).socket);
    let response = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error, value?: R) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(value as R);
    };
    const abort = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Workflow client detached."));
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(options.timeoutMs ?? 30_000, () => finish(new WorkflowError("worker_timeout", "Workflow worker timed out. An admitted operation may still finish. Use status or list before retrying; reuse the same requestId for launches.")));
    socket.on("error", error => finish(error));
    socket.on("connect", () => socket.write(serialized));
    socket.on("data", chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) return finish(new WorkflowError("response_too_large", "Worker response exceeds 64 MiB. Have the workflow return artifact paths instead of large file contents."));
      const end = response.indexOf(10);
      if (end < 0) return;
      try {
        const reply = JSON.parse(response.subarray(0, end).toString("utf8")) as ControlResponse<R>;
        if (reply.ok) finish(undefined, reply.data);
        else finish(new WorkflowError(reply.error.code, reply.error.message, reply.error.stepKey));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("end", () => { if (!finished) finish(new WorkflowError("worker_disconnected", "Worker disconnected without a complete reply. Check worker.log and retry with the same requestId.")); });
  });
}

async function ready(options: ClientOptions): Promise<WorkerStatus | undefined> {
  try {
    const status = await rpc<WorkerStatus>({ action: "ping" }, { ...options, timeoutMs: 1000 });
    if (status.version !== PROTOCOL_VERSION) throw new WorkflowError("protocol_mismatch", "Workflow worker uses a different protocol. Run workflow worker stop, then worker start.");
    return status;
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}
const starting = new Map<string, Promise<WorkerStatus>>();
export async function ensureWorker(options: ClientOptions = {}): Promise<WorkerStatus> {
  if (process.platform === "win32") throw new WorkflowError("unsupported_platform", "pi-orchestration supports Linux and macOS. On Windows, run it inside WSL.");
  const status = await ready(options);
  if (status) return status;
  const home = workflowPaths(options.home).home;
  let pending = starting.get(home);
  if (!pending) {
    // A client detaching must not abort the shared startup for other clients.
    pending = start({ home }).finally(() => starting.delete(home));
    starting.set(home, pending);
  }
  if (!options.signal) return pending;
  const signal = options.signal;
  signal.throwIfAborted();
  return new Promise<WorkerStatus>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Workflow client detached."));
    signal.addEventListener("abort", abort, { once: true });
    pending!.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function start(options: ClientOptions): Promise<WorkerStatus> {
  const paths = workflowPaths(options.home);
  try {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await chmod(paths.home, 0o700);
    const log = await open(paths.log, "a", 0o600);
    try {
      const child = spawn(process.env.PI_WORKFLOW_NODE ?? "node", [fileURLToPath(new URL("../dist/worker.js", import.meta.url))], {
        detached: true, cwd: paths.home, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, PI_WORKFLOW_HOME: paths.home },
      });
      let launchError: Error | undefined;
      child.on("error", error => { launchError = error; });
      child.unref();
      for (let i = 0; i < 150; i++) {
        options.signal?.throwIfAborted();
        if (launchError) throw launchError;
        const status = await ready(options);
        if (status) return status;
        await delay(100, undefined, { signal: options.signal });
      }
      throw new Error(`Worker did not become ready. Check ${paths.log}; Node >=22.19 must be on PATH, or set PI_WORKFLOW_NODE.`);
    } finally { await log.close(); }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof WorkflowError && error.code === "protocol_mismatch") throw error;
    throw new WorkflowError("worker_unavailable", `Cannot start workflow worker in ${paths.home}: ${error instanceof Error ? error.message : String(error)} Use --home with a writable, short directory path.`);
  }
}
export async function requestWorker<R = unknown>(request: ControlRequest, options: ClientOptions = {}): Promise<R> {
  if (request.action === "run") assertRootLaunch();
  validateRequest(request);
  await ensureWorker(options);
  return rpc<R>(request, options);
}
