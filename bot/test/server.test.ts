import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { serve } from "../src/server.js";
import { eventually, fixture, INFO } from "./interface-fixtures.js";

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function rawGet(url: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end();
  });
}
async function stream(url: string) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /ndjson/);
  const reader = response.body!.getReader();
  let pending = "";
  return {
    async next(): Promise<Record<string, unknown>> {
      while (!pending.includes("\n")) {
        const { done, value } = await reader.read();
        assert.equal(done, false); pending += new TextDecoder().decode(value);
      }
      const index = pending.indexOf("\n"); const line = pending.slice(0, index); pending = pending.slice(index + 1);
      return JSON.parse(line);
    },
    async close() { await reader.cancel(); reader.releaseLock(); },
  };
}

test("unauthenticated HTTP works on loopback AND 0.0.0.0, with acceptance, status and fixed workspace", async t => {
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    await t.test(host, async t => {
      const f = fixture(); const server = await serve("ignored", { bot: f.bot, host, port: 0 });
      t.after(() => server.close());
      const url = server.url.replace("0.0.0.0", "127.0.0.1");
      assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
      assert.deepEqual(await (await fetch(`${url}/v1/info`)).json(), INFO);
      const response = await post(`${url}/v1/runs`, { message: "hello", requestId: "retry-me" });
      assert.equal(response.status, 202);
      const accepted = await response.json();
      assert.equal(accepted.status, "queued"); assert.ok(accepted.runId); assert.ok(accepted.sessionId);
      assert.equal(accepted.cwd, "/configured-workspace");
      assert.equal((await (await post(`${url}/v1/runs`, { message: "hello", requestId: "retry-me" })).json()).runId, accepted.runId);
      f.complete(accepted.runId);
      assert.equal((await (await fetch(`${url}/v1/runs/${accepted.runId}`)).json()).status, "completed");
      assert.equal((await (await fetch(`${url}/v1/sessions`)).json())[0].sessionId, accepted.sessionId);
      const second = await (await post(`${url}/v1/runs`, { message: "again", session: accepted.sessionId })).json();
      assert.equal((await post(`${url}/v1/runs/${second.runId}/cancel`, {})).status, 200);
      assert.deepEqual(f.cancelled, [second.runId]);
      assert.equal((await fetch(`${url}/v1/runs/unknown`)).status, 404);
      await server.close(); await server.close(); assert.equal(f.closed, 0, "injected bot remains caller-owned");
    });
  }
});

test("optional bearer token protects every service/data route, not health, and never leaks token", async t => {
  const f = fixture(); const token = "explicit-secret";
  const server = await serve("ignored", { bot: f.bot, host: "0.0.0.0", port: 0, authToken: token });
  t.after(() => server.close());
  const url = server.url.replace("0.0.0.0", "127.0.0.1");
  assert.equal((await fetch(`${url}/health`)).status, 200);
  for (const path of ["/v1/info", "/v1/sessions", "/v1/runs/run-1", "/v1/sessions/session-1/stream"]) {
    for (const authorization of [undefined, "Bearer incorrect"]) {
      const response = await fetch(`${url}${path}`, { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "UNAUTHORIZED");
    }
  }
  for (const path of ["/v1/runs", "/v1/runs/run-1/cancel", "/v1/tools/echo", "/v1/reload"]) {
    assert.equal((await post(`${url}${path}`, {})).status, 401);
  }
  const info = await fetch(`${url}/v1/info`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(info.status, 200); assert.ok(!(await info.text()).includes(token));
  assert.equal((await post(`${url}/v1/runs`, { message: "authenticated" }, { Authorization: `Bearer ${token}` })).status, 202);
  for (const authToken of ["", "  ", "bad\nheader"]) await assert.rejects(serve("ignored", { bot: f.bot, authToken }), /authToken/);
});

test("strict JSON validation, size/media limits, no caller path overrides and safe path decoding", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, maxBodyBytes: 128 });
  t.after(() => server.close());
  for (const body of [null, [], { message: "" }, { message: 123 }, { message: "x", session: 2 }, { message: "x", requestId: false },
    ...["cwd", "source", "stateDir", "agentDir", "model"].map(key => ({ message: "x", [key]: "/arbitrary" }))]) {
    assert.equal((await post(`${server.url}/v1/runs`, body)).status, 400);
  }
  const malformed = await fetch(`${server.url}/v1/runs`, { method: "POST", body: "{", headers: { "Content-Type": "application/json" } });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, "INVALID_JSON");
  const large = await post(`${server.url}/v1/runs`, { message: "x".repeat(200) });
  assert.equal(large.status, 413); assert.equal((await large.json()).error.code, "BODY_TOO_LARGE");
  const media = await fetch(`${server.url}/v1/runs`, { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } });
  assert.equal(media.status, 415);
  for (const path of ["/v1/runs/%ZZ", "/v1/runs/a%2fb", "/v1/runs/%00", "/v1/runs/%2e%2e", "/v1/runs/a%5cb"]) {
    assert.equal(await rawGet(server.url, path), 400, path);
  }
  assert.equal((await fetch(`${server.url}/not-real`)).status, 404);
  assert.equal(f.submitted.length, 0);
});

test("chunked request limits and output limits have stable JSON errors", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, maxBodyBytes: 20, maxResponseBytes: 50 });
  t.after(() => server.close());
  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(`${server.url}/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject); req.write('{"message":"'); req.write("x".repeat(40)); req.end('"}');
  });
  assert.equal(result.status, 413); assert.equal(JSON.parse(result.text).error.code, "BODY_TOO_LARGE");
  const info = await fetch(`${server.url}/v1/info`);
  assert.equal(info.status, 502); assert.equal((await info.json()).error.code, "RESPONSE_TOO_LARGE");
});

test("typed tool calls and reload use the same injected handle", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 });
  t.after(() => server.close());
  const tool = await post(`${server.url}/v1/tools/echo`, { input: { a: 1 }, session: "s" });
  assert.equal(tool.status, 200);
  assert.deepEqual(JSON.parse((await tool.json()).content[0].text), { input: { a: 1 }, session: "s" });
  assert.equal((await post(`${server.url}/v1/tools/echo`, {})).status, 400);
  assert.equal((await post(`${server.url}/v1/tools/missing`, { input: null })).status, 404);
  assert.deepEqual(await (await post(`${server.url}/v1/reload`, {})).json(), { changed: false, revision: INFO.revision, diagnostics: [] });
});

test("watch streams snapshot then updates, reconnects current state, and disconnect does not cancel", async t => {
  const f = fixture(); const accepted = await f.bot.submit("work");
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const first = await stream(`${server.url}/v1/sessions/${accepted.sessionId}/stream`);
  assert.equal((await first.next()).type, "snapshot");
  f.complete(accepted.runId);
  assert.equal((await first.next()).type, "run");
  await first.close(); await eventually(() => f.unsubscribed === 1);
  const second = await stream(`${server.url}/v1/sessions/${accepted.sessionId}/stream`);
  const snapshot = await second.next();
  assert.equal((snapshot.data as { runs: Array<{ status: string }> }).runs[0].status, "completed");
  await second.close(); await eventually(() => f.unsubscribed === 2);
  assert.deepEqual(f.cancelled, []);
  const third = await stream(`${server.url}/v1/sessions/${accepted.sessionId}/stream`);
  await third.next(); await server.close(); await eventually(() => f.unsubscribed === 3);
  await third.close().catch(() => {});
});

const NDJSON = { Accept: "application/x-ndjson" };
const parseLines = (text: string) => text.trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);

test("POST /v1/runs negotiates a run stream: accepted, post-admission events, settled, then EOF", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const response = await post(`${server.url}/v1/runs`, { message: "hello" }, NDJSON);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const body = response.text();
  await eventually(() => f.observers.has("run-1"));
  f.emitRun("run-1", { type: "message_update", sessionId: "session-1", data: { changes: [] } });
  f.complete("run-1");
  const events = parseLines(await body);
  assert.deepEqual(events.map(event => event.type), ["run_accepted", "message_update", "run_settled"], "snapshots are not part of a run stream");
  assert.equal(events[0].runId, "run-1"); assert.equal(events[0].data.status, "queued");
  assert.equal(events[2].data.status, "completed"); assert.equal(events[2].data.output, "done");
  // Clients that do not ask for NDJSON keep the acceptance-only contract.
  for (const accept of [undefined, "application/json"]) {
    assert.equal((await post(`${server.url}/v1/runs`, { message: "plain" }, accept ? { Accept: accept } : {})).status, 202);
  }
  const invalid = await post(`${server.url}/v1/runs`, { message: "" }, NDJSON);
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "INVALID_BODY");
});

test("run stream disconnect never cancels; handles without run_settled settle by polling", async t => {
  const f = fixture(); const submit = f.bot.submit;
  f.bot.submit = (message, options) => submit(message, { ...options, onEvent: undefined });
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const settled = post(`${server.url}/v1/runs`, { message: "quiet handle" }, NDJSON).then(response => response.text());
  await eventually(() => f.runs.has("run-1")); f.complete("run-1");
  assert.deepEqual(parseLines(await settled).map(event => event.type), ["run_accepted", "run_settled"]);
  const controller = new AbortController();
  const response = await fetch(`${server.url}/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json", ...NDJSON }, body: JSON.stringify({ message: "keep running" }), signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read(); controller.abort();
  await reader.cancel().catch(() => {});
  f.complete("run-2");
  assert.equal((await (await fetch(`${server.url}/v1/runs/run-2`)).json()).status, "completed");
  assert.deepEqual(f.cancelled, []);
});

test("run streams share stream limits and buffer bounds, and end on shutdown", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, maxStreams: 1, maxStreamBufferBytes: 512 });
  t.after(() => server.close());
  const watching = await stream(`${server.url}/v1/sessions/s/stream`); await watching.next();
  const limited = await post(`${server.url}/v1/runs`, { message: "no slot" }, NDJSON);
  assert.equal(limited.status, 503); assert.equal((await limited.json()).error.code, "STREAM_LIMIT");
  await watching.close(); await eventually(() => f.unsubscribed === 1);
  const overflow = await post(`${server.url}/v1/runs`, { message: "huge" }, NDJSON);
  const overflowBody = overflow.text().catch(() => "");
  await eventually(() => f.observers.has("run-1"));
  f.emitRun("run-1", { type: "huge", data: "x".repeat(1024) });
  assert.ok(!(await overflowBody).includes("run_settled"), "an overflowing observer is disconnected");
  assert.deepEqual(f.cancelled, []);
  const open = await post(`${server.url}/v1/runs`, { message: "open at shutdown" }, NDJSON);
  const openBody = open.text().catch(() => "");
  await eventually(() => f.observers.has("run-2"));
  await server.close(); await openBody;
  assert.deepEqual(f.cancelled, []);
});

test("stream count and buffer bounds clean up watchers", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, maxStreams: 1, maxStreamBufferBytes: 512 });
  t.after(() => server.close());
  const first = await stream(`${server.url}/v1/sessions/s/stream`); await first.next();
  assert.equal((await fetch(`${server.url}/v1/sessions/other/stream`)).status, 503);
  f.emit("s", { type: "huge", data: "x".repeat(1024) });
  await eventually(() => f.unsubscribed === 1);
  await first.close().catch(() => {});
});

test("watch resolution racing disconnect unsubscribes exactly once", async t => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  const watch = f.bot.watch;
  f.bot.watch = async (session, listener) => { const stop = await watch(session, listener); await gate; return stop; };
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const controller = new AbortController();
  const pending = fetch(`${server.url}/v1/sessions/s/stream`, { signal: controller.signal });
  await eventually(() => (f.listeners.get("s")?.size ?? 0) === 1);
  controller.abort(); await assert.rejects(pending); release();
  await eventually(() => f.unsubscribed === 1);
});

test("shutdown aborts direct tool IO without closing a caller-owned runtime", async t => {
  const f = fixture(); let started = false; let aborted = false;
  f.bot.callTool = async (_name, _input, options) => {
    started = true;
    return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => {
      aborted = true; reject(options!.signal!.reason);
    }, { once: true }));
  };
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const waiting = post(`${server.url}/v1/tools/echo`, { input: {} }).catch(() => undefined);
  await eventually(() => started); await server.close(); await waiting;
  assert.equal(aborted, true); assert.equal(f.closed, 0); assert.deepEqual(f.cancelled, []);
});

test("disconnect during admission does not cancel server work, and unexpected errors do not leak secrets", async t => {
  const f = fixture(); const submit = f.bot.submit;
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  f.bot.submit = async (message, options) => { const record = await submit(message, options); await gate; return record; };
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const controller = new AbortController();
  const request = fetch(`${server.url}/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "keep running" }), signal: controller.signal });
  await eventually(() => f.submitted.length === 1); controller.abort(); await assert.rejects(request);
  release(); f.complete("run-1");
  assert.equal((await (await fetch(`${server.url}/v1/runs/run-1`)).json()).status, "completed");
  assert.deepEqual(f.cancelled, []);
  f.bot.info = async () => { throw new Error("a sensitive credential must not cross HTTP"); };
  const response = await fetch(`${server.url}/v1/info`); assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Bot operation failed" } });
  f.bot.info = async () => { throw Object.assign(new Error("another sensitive credential"), { code: "UNAVAILABLE" }); };
  const unavailable = await fetch(`${server.url}/v1/info`); assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: { code: "UNAVAILABLE", message: "Bot is currently unavailable" } });
});

test("owned runtime closes on normal shutdown and failed startup; injected handles never close", async t => {
  const f = fixture();
  const first = await serve("source", { openBot: async () => f.bot, port: 0 });
  const port = Number(new URL(first.url).port);
  const owned = fixture();
  await assert.rejects(serve("source", { openBot: async () => owned.bot, port }), /EADDRINUSE/);
  assert.equal(owned.closed, 1);
  const injected = fixture();
  await assert.rejects(serve("source", { bot: injected.bot, port }), /EADDRINUSE/);
  assert.equal(injected.closed, 0);
  t.after(() => first.close());
  await first.close(); assert.equal(f.closed, 1);
});
