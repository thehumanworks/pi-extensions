import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loopPaths } from "./paths.js";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION } from "./protocol.js";
export function rpc(request, timeout = 30_000) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(loopPaths().socket);
        let response = "";
        const finish = (error, value) => {
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve(value);
        };
        socket.setTimeout(timeout, () => finish(new Error("Loop worker timed out. A submitted operation may still complete; list schedules before retrying.")));
        socket.on("error", reject);
        // Newline frames the request; keep both halves open until the reply arrives.
        // Bun-based Pi executables can close the read side too when socket.end() is used here.
        socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
        socket.on("data", chunk => {
            response += chunk.toString();
            if (Buffer.byteLength(response) > 16 * 1024 * 1024)
                return finish(new Error("Loop worker response is too large."));
            if (!response.includes("\n"))
                return;
            try {
                const result = JSON.parse(response);
                if (result.ok)
                    finish(undefined, result.result);
                else
                    finish(new Error(result.error));
            }
            catch (error) {
                finish(error);
            }
        });
        socket.on("end", () => {
            if (!response.includes("\n"))
                finish(new Error("Loop worker closed without a response."));
        });
    });
}
async function ready() {
    try {
        const result = await rpc({ action: "ping" }, 1000);
        if (result.version !== PROTOCOL_VERSION)
            throw new Error("Loop worker protocol changed. Stop the old worker and restart it.");
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ECONNREFUSED")
            return false;
        throw error;
    }
}
let starting;
export async function ensureWorker() {
    if (process.platform === "win32")
        throw new Error("Loop currently supports macOS and Linux.");
    if (await ready())
        return;
    starting ??= start().finally(() => { starting = undefined; });
    await starting;
}
async function start() {
    const paths = loopPaths();
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await chmod(paths.home, 0o700);
    const log = await open(paths.log, "a", 0o600);
    try {
        const child = spawn(process.env.PI_LOOP_NODE ?? "node", [fileURLToPath(new URL("../dist/worker.js", import.meta.url))], { detached: true, cwd: paths.home, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, PI_LOOP_HOME: paths.home } });
        let launchError;
        child.on("error", error => { launchError = error; });
        child.unref();
        for (let i = 0; i < 150; i++) {
            if (launchError)
                throw launchError;
            if (await ready())
                return;
            await delay(100);
        }
        throw new Error(`Loop worker did not start. Check ${paths.log}. Node >=22.19 must be on PATH (or set PI_LOOP_NODE).`);
    }
    finally {
        await log.close();
    }
}
export async function requestWorker(request) {
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES)
        throw new Error("Loop request is too large.");
    await ensureWorker();
    return rpc(request);
}
