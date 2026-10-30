import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Models } from "@earendil-works/pi-ai";
import { ModelRuntime } from "pi-workflow-runtime";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { errorDetails } from "./errors.ts";
import { assertSocketPath, workflowPaths } from "./paths.ts";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, validateRequest, workerBuild, type ControlResponse } from "./protocol.ts";
import { catalog, validateWorkflow } from "./loader.ts";
import { openEngine, type EngineOptions } from "./engine/index.ts";
import { workerSettings } from "./settings.ts";

export interface WorkerOptions extends Omit<EngineOptions, "home"> { home?: string; models?: Models }
/** Returns undefined when another live worker owns this data directory. */
export async function startWorker(options: WorkerOptions = {}) {
  // The code this process loaded; a later build changes the file but not what runs here.
  const build = await workerBuild();
  const paths = workflowPaths(options.home);
  assertSocketPath(paths.socket);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  const owner = new DatabaseSync(paths.database + ".owner");
  try { owner.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)"); }
  catch (error) {
    owner.close();
    if ((error as { errcode?: number }).errcode === 5) return undefined;
    throw error;
  }
  let released = false;
  const release = () => { if (!released) { released = true; owner.close(); } };
  try {
    const models = options.models ?? await ModelRuntime.create();
    const engine = await openEngine(await openNodeSqliteStorage(paths.database), models, { ...workerSettings(), ...options, home: paths.home });
    const started = Date.now();
    let stopping: Promise<void> | undefined;
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(30_000, () => socket.destroy());
      let input = Buffer.alloc(0);
      let handled = false;
      const reply = (result: ControlResponse) => socket.end(JSON.stringify(result) + "\n");
      socket.on("data", chunk => {
        if (handled) return;
        input = Buffer.concat([input, chunk]);
        if (input.length > MAX_REQUEST_BYTES) { handled = true; reply({ ok: false, error: { code: "invalid_request", message: "Request exceeds 1 MiB." } }); return; }
        const end = input.indexOf(10);
        if (end < 0) return;
        handled = true;
        void (async () => {
          try {
            const request = validateRequest(JSON.parse(input.subarray(0, end).toString("utf8")));
            if (stopping) throw new Error("Worker is stopping. Retry after it exits.");
            let data: unknown;
            switch (request.action) {
              case "ping": data = { version: PROTOCOL_VERSION, build, pid: process.pid, home: paths.home, uptimeMs: Date.now() - started }; break;
              case "stop": data = { stopped: true }; break;
              case "catalog": data = await catalog(request.cwd); break;
              case "validate": data = await validateWorkflow(request.workflow, request.cwd); break;
              default: data = await engine.request(request);
            }
            reply({ ok: true, data });
            if (request.action === "stop") socket.once("close", () => { void close(); });
          } catch (error) { reply({ ok: false, error: errorDetails(error) }); }
        })();
      });
    });
    const close = (): Promise<void> => stopping ??= (async () => {
      server.close();
      for (const socket of sockets) socket.destroy();
      await engine.close();
      await rm(paths.socket, { force: true });
      release();
    })();
    await rm(paths.socket, { force: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.socket, () => { server.removeListener("error", reject); resolve(); });
      });
      await chmod(paths.socket, 0o600);
    } catch (error) { await close(); throw error; }
    return { engine, server, close, paths };
  } catch (error) { release(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const worker = await startWorker();
    if (worker) {
      console.error(`[workflow] Worker ${process.pid} ready at ${worker.paths.socket}`);
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
        void worker.close().catch(error => { console.error(error); process.exitCode = 1; });
      });
      void worker.engine.harness.closed.then(end => {
        if (end.reason === "failed") { console.error("[workflow] Storage failed:", end.error); process.exit(1); }
      });
    }
  } catch (error) { console.error(`[workflow] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
