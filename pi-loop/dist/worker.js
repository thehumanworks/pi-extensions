import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { ModelRuntime } from "pi-loop-runtime";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loopPaths } from "./paths.js";
import { MAX_REQUEST_BYTES, validateRequest } from "./protocol.js";
import { openScheduler } from "./scheduler.js";
const paths = loopPaths();
await mkdir(paths.home, { recursive: true, mode: 0o700 });
await chmod(paths.home, 0o700);
let shuttingDown = false;
// OS-held exclusive SQLite lock, released by the kernel on crash. Unlike a
// heartbeat lock it cannot expire during laptop sleep or a long event-loop pause.
const owner = new DatabaseSync(paths.database + ".owner");
try {
    owner.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
}
catch (error) {
    owner.close();
    if (error.errcode === 5)
        process.exit(0);
    throw error;
}
const release = () => owner.close();
try {
    const models = await ModelRuntime.create();
    const scheduler = await openScheduler(await openNodeSqliteStorage(paths.database), models);
    const server = createServer({ allowHalfOpen: true }, socket => {
        let input = Buffer.alloc(0);
        let handled = false;
        socket.on("error", error => console.error("[loop socket]", error.message));
        socket.setTimeout(30_000, () => socket.destroy());
        socket.on("data", chunk => {
            if (handled)
                return;
            input = Buffer.concat([input, chunk]);
            if (input.length > MAX_REQUEST_BYTES) {
                handled = true;
                socket.end(JSON.stringify({ ok: false, error: "Request too large." }) + "\n");
                return;
            }
            const end = input.indexOf(10);
            if (end < 0)
                return;
            handled = true;
            socket.setTimeout(0);
            void (async () => {
                try {
                    const request = validateRequest(JSON.parse(input.subarray(0, end).toString()));
                    if (shuttingDown)
                        throw new Error("Worker is stopping.");
                    const result = await scheduler.request(request);
                    socket.end(JSON.stringify({ ok: true, result }) + "\n");
                    if (request.action === "stop")
                        socket.once("close", () => { void shutdown(); });
                }
                catch (error) {
                    socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
                }
            })();
        });
    });
    async function shutdown() {
        if (shuttingDown)
            return;
        shuttingDown = true;
        server.close();
        await scheduler.close();
        await rm(paths.socket, { force: true });
        await release();
    }
    await rm(paths.socket, { force: true });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.socket, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(paths.socket, 0o600);
    console.log(`[loop] Worker ${process.pid} ready at ${paths.socket}`);
    for (const signal of ["SIGTERM", "SIGINT"])
        process.on(signal, () => { void shutdown().catch(error => { console.error(error); process.exit(1); }); });
    scheduler.harness.closed.then(end => {
        if (end.reason === "failed") {
            console.error("[loop] Storage failed:", end.error);
            process.exit(1);
        }
    });
}
catch (error) {
    await release();
    throw error;
}
