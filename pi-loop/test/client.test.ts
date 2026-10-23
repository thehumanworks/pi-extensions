import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorker, rpc } from "../src/client.ts";
import { PROTOCOL_VERSION, type Request } from "../src/protocol.ts";

async function fakeWorker(t: TestContext, handle: (socket: Socket, request: Request) => void) {
  const home = await mkdtemp(join(tmpdir(), "pl-"));
  const oldHome = process.env.PI_LOOP_HOME;
  process.env.PI_LOOP_HOME = home;
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.includes("\n")) handle(socket, JSON.parse(input));
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    });
    if (oldHome === undefined) delete process.env.PI_LOOP_HOME; else process.env.PI_LOOP_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(home, "worker.sock"), resolve);
  });
}

test("recovery ping and RPC keep the socket open until the asynchronous reply", async t => {
  const requests: string[] = [];
  const endedBeforeReply: boolean[] = [];
  await fakeWorker(t, (socket, request) => {
    requests.push(request.action);
    // The server must not need half-close support to return a delayed response.
    setTimeout(() => {
      endedBeforeReply.push(socket.readableEnded);
      const result = request.action === "ping" ? { version: PROTOCOL_VERSION } : [];
      socket.end(JSON.stringify({ ok: true, result }) + "\n");
    }, 25);
  });
  await ensureWorker();
  assert.deepEqual(await rpc({ action: "list" }), []);
  assert.deepEqual(requests, ["ping", "list"]);
  assert.deepEqual(endedBeforeReply, [false, false]);
});

test("RPC still reports a worker that closes without replying", async t => {
  await fakeWorker(t, socket => { socket.end(); });
  await assert.rejects(rpc({ action: "ping" }), /Loop worker closed without a response/);
});

test("RPC times out when the worker never replies", async t => {
  await fakeWorker(t, () => {});
  await assert.rejects(rpc({ action: "ping" }, 25), /Loop worker timed out/);
});
