import assert from "node:assert/strict";
import test from "node:test";
import { BotClient, BotClientError, connectBot } from "../src/client.js";
import { serve } from "../src/server.js";
import type { BotEvent } from "../src/types.js";
import { eventually, fixture, INFO } from "./interface-fixtures.js";

test("client info, acceptance/status/cancel/sessions/tools/reload without any auth", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url, { pollIntervalMs: 5 }); t.after(() => client.close());
  assert.deepEqual(await client.info(), INFO);
  const run = await client.submit("hello"); assert.equal(run.status, "queued");
  assert.equal((await client.getRun(run.runId)).runId, run.runId);
  assert.equal((await client.listSessions())[0].sessionId, run.sessionId);
  const result = await client.callTool("echo", { test: true }, { session: run.sessionId });
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { input: { test: true }, session: run.sessionId });
  assert.equal((await client.reload()).revision, INFO.revision);
  await client.cancel(run.runId); assert.equal((await client.getRun(run.runId)).status, "cancelled");
});

test("optional client token, meaningful remote status/code, invalid config/IDs", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, authToken: "selected" }); t.after(() => server.close());
  for (const authToken of [undefined, "wrong"]) {
    const client = connectBot(server.url, { authToken });
    await assert.rejects(client.info(), error => error instanceof BotClientError && error.status === 401 && error.code === "UNAUTHORIZED");
    await client.close();
  }
  const client = connectBot(server.url, { authToken: "selected" }); t.after(() => client.close());
  assert.deepEqual(await client.info(), INFO);
  await assert.rejects(client.getRun("missing"), error => error instanceof BotClientError && error.status === 404 && error.code === "NOT_FOUND");
  await assert.rejects(client.getRun("a/b"), /identifier/);
  assert.throws(() => connectBot(server.url, { authToken: "" }), /authToken/);
  assert.throws(() => connectBot("file:///tmp/bot"), /HTTP/);
  assert.throws(() => connectBot("http://user:pass@localhost"), /credentials/);
  assert.throws(() => connectBot(server.url, { pollIntervalMs: 0 }), /positive/);
});

test("observed run reads its own NDJSON stream until run_settled, without a session watch", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url, { pollIntervalMs: 5 }); t.after(() => client.close());
  const events: BotEvent[] = [];
  const pending = client.run("work", { requestId: "one", onEvent: event => events.push(event) });
  await eventually(() => events.length > 0); assert.equal(events[0].type, "run_accepted"); assert.equal(events[0].runId, "run-1");
  f.emitRun("run-1", { type: "message_update", sessionId: "session-1", data: { changes: [{ type: "text_delta", delta: "do" }] } });
  await eventually(() => events.length === 2);
  f.complete("run-1");
  const result = await pending; assert.equal(result.status, "completed"); assert.equal(result.output, "done");
  assert.deepEqual(events.map(event => event.type), ["run_accepted", "message_update", "run_settled"]);
  assert.equal(f.listeners.get("session-1")?.size ?? 0, 0); assert.deepEqual(f.cancelled, []);
  const existing = await client.run("work", { requestId: "one" }); assert.equal(existing.runId, "run-1");
});

test("observed run falls back to session watch and polling on a server without run streams", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  // An older server ignores Accept and answers 202 JSON.
  const older: typeof fetch = (input, init) => fetch(input, { ...init, headers: Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([key]) => key !== "Accept")) });
  const client = connectBot(server.url, { pollIntervalMs: 5, fetch: older }); t.after(() => client.close());
  const events: BotEvent[] = [];
  const pending = client.run("work", { onEvent: event => events.push(event) });
  await eventually(() => events.length > 0); assert.equal(events[0].type, "snapshot");
  f.complete("run-1");
  const result = await pending; assert.equal(result.status, "completed"); assert.equal(result.output, "done");
  assert.ok(events.some(event => event.type === "run"));
  await eventually(() => f.unsubscribed === 1); assert.deepEqual(f.cancelled, []);
});

test("explicit run AbortSignal cancels the admitted remote run and closes its event stream", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0, maxStreams: 1 }); t.after(() => server.close());
  const client = connectBot(server.url, { pollIntervalMs: 5 }); t.after(() => client.close());
  const controller = new AbortController(); const events: BotEvent[] = [];
  const pending = client.run("wait", { signal: controller.signal, onEvent: event => events.push(event) });
  await eventually(() => events.length > 0);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(f.cancelled, ["run-1"]);
  // The single stream slot is released, so another observed run can stream.
  const next = client.run("next", { onEvent: () => {} });
  await eventually(() => f.observers.has("run-2")); f.complete("run-2");
  assert.equal((await next).status, "completed");
});

test("aborting during acceptance still cancels the identified owned run", async t => {
  const f = fixture(); const submit = f.bot.submit;
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  f.bot.submit = async (message, options) => { const result = await submit(message, options); await gate; return result; };
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url); t.after(() => client.close());
  const controller = new AbortController(); const pending = client.run("wait", { signal: controller.signal });
  await eventually(() => f.submitted.length > 0); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  let closed = false; const closing = client.close().then(() => closed = true);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, false, "close preserves pending explicit cancellation");
  release(); await closing;
  assert.deepEqual(f.cancelled, ["run-1"]);
});

test("pre-aborted calls are not submitted and ordinary requests respect AbortSignal", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url); t.after(() => client.close());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.run("no", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(client.submit("no", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(client.info({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.submitted.length, 0);
});

test("idle watch unsubscribe/abort/reconnect closes cleanly without cancelling any runs", async t => {
  const f = fixture(); await f.bot.submit("work");
  const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url); t.after(() => client.close());
  const events: BotEvent[] = []; const errors: Error[] = [];
  const stop = await client.watch("session-1", event => events.push(event), { onError: error => errors.push(error) });
  await eventually(() => events.length === 1); await stop(); await stop(); await eventually(() => f.unsubscribed === 1);
  f.complete("run-1");
  const controller = new AbortController();
  const stop2 = await client.watch("session-1", event => events.push(event), { signal: controller.signal });
  await eventually(() => events.length === 2);
  assert.equal((events[1].data as { runs: Array<{ status: string }> }).runs[0].status, "completed");
  controller.abort(); await stop2(); await eventually(() => f.unsubscribed === 2);
  assert.deepEqual(errors, []); assert.deepEqual(f.cancelled, []);
});

test("client.close aborts waiting IO, not server work", async t => {
  const f = fixture(); const server = await serve("ignored", { bot: f.bot, port: 0 }); t.after(() => server.close());
  const client = connectBot(server.url, { pollIntervalMs: 5 });
  const waiting = client.run("wait"); await eventually(() => f.submitted.length === 1);
  const rejected = assert.rejects(waiting, /closed/);
  await client.close(); await rejected;
  assert.deepEqual(f.cancelled, []); assert.equal(f.runs.get("run-1")?.status, "queued");
});

test("malformed and bounded remote responses/events produce useful errors", async () => {
  const from = (response: () => Response, options: { maxResponseBytes?: number; maxEventBytes?: number } = {}) => new BotClient("http://fixture", {
    ...options, fetch: (async () => response()) as typeof fetch,
  });
  const malformed = from(() => new Response("{"));
  await assert.rejects(malformed.info(), error => error instanceof BotClientError && error.code === "INVALID_RESPONSE");
  const huge = from(() => new Response("x".repeat(100)), { maxResponseBytes: 20 });
  await assert.rejects(huge.info(), error => error instanceof BotClientError && error.code === "RESPONSE_TOO_LARGE");
  const invalidRun = from(() => Response.json({ status: "nonsense" }));
  await assert.rejects(invalidRun.submit("work"), error => error instanceof BotClientError && error.code === "INVALID_RESPONSE");
  for (const [body, code, maxEventBytes] of [["{\n", "INVALID_EVENT", 100], ['{"bad":true}\n', "INVALID_EVENT", 100], ["x".repeat(100), "EVENT_TOO_LARGE", 20]] as const) {
    const client = from(() => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }), { maxEventBytes });
    const errors: Error[] = [];
    const stop = await client.watch("s", () => {}, { onError: error => errors.push(error) });
    await eventually(() => errors.length > 0);
    assert.equal((errors[0] as BotClientError).code, code); await stop(); await client.close();
  }
});

test("ordinary requests and unobserved acceptance are bounded by requestTimeoutMs", async () => {
  const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  });
  const client = connectBot("http://fixture", { fetch: fetcher, requestTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client.info(), { name: "TimeoutError" });
    const controller = new AbortController();
    const run = client.run("work", { signal: controller.signal });
    controller.abort(); await assert.rejects(run, { name: "AbortError" });
    await client.close();
  } finally { clearTimeout(keepAlive); }
});

test("NDJSON supports fragmented multi-byte events, multiple lines and clean EOF", async () => {
  const bytes = new TextEncoder().encode('{"type":"snapshot","data":"✓"}\n{"type":"next"}\n');
  const client = connectBot("http://fixture", { fetch: (async () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  }), { headers: { "Content-Type": "application/x-ndjson" } })) as typeof fetch });
  const events: BotEvent[] = []; const errors: Error[] = [];
  const stop = await client.watch("s", event => events.push(event), { onError: error => errors.push(error) });
  await eventually(() => events.length === 2); await stop(); await client.close();
  assert.equal(events[0].data, "✓"); assert.equal(events[1].type, "next"); assert.deepEqual(errors, []);
});
