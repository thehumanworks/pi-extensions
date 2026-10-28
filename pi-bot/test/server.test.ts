import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { botPaths, createBot } from "../src/bots.ts";
import { ConversationHub } from "../src/server/conversations.ts";
import { createApp } from "../src/server/http.ts";
import { EXTENSION_PATH, formatUrl, parseOptions } from "../src/server/main.ts";
import { persona, tempRoot } from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/pi-bot-server.mjs", import.meta.url));
const OPENAPI = JSON.parse(await readFile(new URL("../openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };

const models = [{ provider: "fake", id: "m1", name: "Fake One", reasoning: false, contextWindow: 1000 }, { provider: "fake", id: "m2", name: "Fake Two", reasoning: true, contextWindow: 2000 }] as unknown as Model<never>[];
const registry = async () => ({ getAll: () => models, getAvailable: () => models, find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) });

/** An in-process server on the IPv6 loopback, backed by the fake Pi. */
async function startServer(t: TestContext, mode = "ok") {
  chmodSync(FAKE_PI, 0o755);
  const work = await mkdtemp(join(tmpdir(), "pi-bot-server-"));
  const log = join(work, "log.jsonl");
  const hub = new ConversationHub({ command: FAKE_PI, extension: EXTENSION_PATH, defaultCwd: work, idleMs: 60_000, env: { ...process.env, FAKE_PI_LOG: log, FAKE_PI_MODE: mode } });
  const app = createApp({ hub, registry, version: "test" });
  const server = createServer(app);
  await new Promise<void>(done => server.listen(0, "::1", done));
  const port = (server.address() as { port: number }).port;
  const base = formatUrl("::1", port);
  t.after(async () => { await hub.closeAll(); server.close(); await rm(work, { recursive: true, force: true }); });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  };
  return { base, api, app, work, log, hub };
}

/** Collect server-sent events until `until` matches one or the stream ends. */
async function readEvents(url: string, until: (event: { type: string; data: any; id: number }) => boolean, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events: Array<{ type: string; data: any; id: number }> = [];
  let buffer = "";
  try {
    for await (const chunk of response.body!) {
      buffer += Buffer.from(chunk).toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(block.split("\n").filter(line => !line.startsWith(":")).map(line => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
        if (!fields.event) continue;
        const event = { type: fields.event, data: JSON.parse(fields.data), id: Number(fields.id) };
        events.push(event);
        if (until(event)) { controller.abort(); return events; }
      }
    }
  } catch (error) { if ((error as Error).name !== "AbortError") throw error; }
  finally { clearTimeout(timer); }
  return events;
}

test("every route is documented in openapi.json and vice versa", async t => {
  const { app } = await startServer(t);
  const documented = new Set(Object.entries(OPENAPI.paths).flatMap(([path, item]) => Object.keys(item).filter(key => key !== "parameters").map(method => `${method.toUpperCase()} ${path}`)));
  const served = new Set(app.routes.map(route => `${route.method} ${route.path}`));
  assert.deepEqual([...served].sort(), [...documented].sort());
});

test("the served document is the committed one and is OpenAPI 3.1.0", async t => {
  const { api } = await startServer(t);
  const { status, body } = await api("GET", "/openapi.json");
  assert.equal(status, 200);
  assert.equal(body.openapi, "3.1.0");
  assert.deepEqual(body.paths, OPENAPI.paths);
  assert.deepEqual((await api("GET", "/")).body, { name: "pi-bot", version: "test", openapi: "/openapi.json" });
});

test("bots are created, read, changed and archived over HTTP", async t => {
  const root = await tempRoot(t);
  const { api } = await startServer(t);
  assert.deepEqual((await api("GET", "/bots")).body, { bots: [], errors: [] });
  assert.equal((await api("GET", "/models")).body.models[1].id, "fake/m2");

  const created = await api("POST", "/bots", { name: "reviewer", description: "Reviews diffs", prompt: persona, model: "m2", thinking: "high", tools: ["read"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.model, "fake/m2");
  assert.deepEqual(created.body.tools, ["read"]);
  assert.equal(created.body.home, join(root, "reviewer"));
  assert.equal((await api("POST", "/bots", { name: "reviewer", description: "x", prompt: "y" })).status, 409);
  assert.equal((await api("POST", "/bots", { name: "Bad Name", description: "x", prompt: "y" })).status, 400);
  assert.match((await api("POST", "/bots", { name: "other", description: "x", prompt: "y", model: "nope" })).body.error.message, /Unknown or ambiguous model/);

  const shown = await api("GET", "/bots/reviewer");
  assert.match(shown.body.definition, /^---\nname: reviewer\n/);
  assert.equal((await api("GET", "/bots/missing")).status, 404);

  const patched = await api("PATCH", "/bots/reviewer", { model: null, edits: [{ oldText: "Be direct.", newText: "Be kind." }], skills: ["docs"] });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.model, null);
  assert.equal(patched.body.thinking, "high");
  assert.match(patched.body.prompt, /Be kind\./);
  assert.deepEqual(patched.body.skills, ["docs"]);
  assert.equal((await api("PATCH", "/bots/reviewer", {})).status, 400);
  assert.equal((await api("PATCH", "/bots/reviewer", { prompt: "a", edits: [{ oldText: "a", newText: "b" }] })).status, 400);
  const replaced = await api("PATCH", "/bots/reviewer", { definition: "---\ndescription: Rewritten\n---\n\nNew persona.\n" });
  assert.equal(replaced.body.description, "Rewritten");

  const archived = await api("DELETE", "/bots/reviewer");
  assert.equal(archived.status, 200);
  assert.match(archived.body.archived, /\.archive\/reviewer-/);
  assert.equal((await api("GET", "/bots/reviewer")).status, 404);
});

test("a message creates the conversation, streams the reply and lands in the bot's home", async t => {
  const root = await tempRoot(t);
  const { api, base, work, log } = await startServer(t);
  const bot = await createBot({ name: "helper", description: "Helps", prompt: persona });
  assert.deepEqual((await api("GET", "/bots/helper/conversations")).body, { conversations: [] });
  assert.equal((await api("GET", "/bots/helper/conversations/nope")).status, 404);
  assert.equal((await api("POST", "/bots/helper/conversations/bad%20id", { message: "x" })).status, 400);
  assert.equal((await api("POST", "/bots/helper/conversations/c1", { message: "x", cwd: join(work, "missing") })).status, 400);

  const sent = await api("POST", "/bots/helper/conversations/c1", { message: "hello there", cwd: work });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.disposition, "started");
  assert.equal(sent.body.streamUrl, `/bots/helper/conversations/c1?view=updates&offset=${sent.body.offset}`);

  const events = await readEvents(`${base}${sent.body.streamUrl}`, event => event.type === "settled");
  const types = events.map(event => event.type);
  assert.deepEqual(types.slice(0, 2), ["status", "status"]); // starting, idle (with the model)
  assert.ok(types.includes("delta") && types.includes("tool") && types.includes("message"));
  assert.equal(events.find(e => e.type === "status" && e.data.model)?.data.model, "fake/m1");
  assert.equal(events.filter(e => e.type === "delta").map(e => e.data.text).join(""), "Hello from fake pi.");
  assert.deepEqual(events.filter(e => e.type === "tool").map(e => e.data.phase), ["start", "end"]);
  assert.equal(events.find(e => e.type === "tool" && e.data.phase === "end")?.data.summary, work);
  const reply = events.filter(e => e.type === "message").map(e => e.data.message);
  assert.deepEqual(reply.map(m => m.role), ["user", "assistant", "toolResult"]);
  assert.equal(reply[1].text, "Hello from fake pi. You said: hello there");
  assert.equal(reply[1].model, "fake/m1");
  assert.deepEqual(events.at(-1)!.data, { aborted: false });
  assert.equal(events.at(-1)!.id, events.length - 1 + sent.body.offset);

  const snapshot = await api("GET", "/bots/helper/conversations/c1");
  assert.equal(snapshot.body.state, "idle");
  assert.equal(snapshot.body.cwd, work);
  assert.deepEqual(snapshot.body.messages.map((m: any) => m.role), ["user", "assistant", "toolResult"]);
  assert.equal(snapshot.body.offset, events.length + sent.body.offset);
  assert.deepEqual(snapshot.body.pendingRequests, []);

  const listed = (await api("GET", "/bots/helper/conversations")).body.conversations;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "c1");
  assert.equal(listed[0].firstMessage, "hello there");
  assert.equal(listed[0].state, "idle");
  const files = await readdir(botPaths(bot.home).sessions);
  assert.deepEqual(files.map(f => f.endsWith("_c1.jsonl")), [true]);
  assert.equal(bot.home, join(root, "helper"));

  const [started] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string });
  assert.equal(started!.cwd, work);
  assert.deepEqual(started!.args.slice(0, 5), ["--mode", "rpc", "--bot", "helper", "-e"]);
  assert.equal(started!.args[5], EXTENSION_PATH);
  assert.deepEqual(started!.args.slice(6, 8), ["--session-dir", botPaths(bot.home).sessions]);
  assert.ok(started!.args[9]!.endsWith("_c1.jsonl"));

  // A later subscriber replays from any retained offset; the second message reuses the process.
  const again = await api("POST", "/bots/helper/conversations/c1", { message: "again" });
  const replay = await readEvents(`${base}/bots/helper/conversations/c1?view=updates&offset=0`, event => event.id >= again.body.offset && event.type === "settled");
  assert.equal(replay[0]!.id, 0);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);

  assert.equal((await api("DELETE", "/bots/helper/conversations/c1")).status, 200);
  assert.deepEqual(await readdir(botPaths(bot.home).sessions), []);
  assert.equal((await api("GET", "/bots/helper/conversations/c1")).status, 404);
});

test("PUT creates an empty conversation and is idempotent", async t => {
  await tempRoot(t);
  const { api, work } = await startServer(t);
  await createBot({ name: "helper", description: "Helps", prompt: persona });
  const created = await api("PUT", "/bots/helper/conversations/draft-1", { cwd: work });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.messages, []);
  assert.equal(created.body.cwd, work);
  assert.equal((await api("PUT", "/bots/helper/conversations/draft-1", {})).status, 200);
  assert.equal((await api("GET", "/bots/helper/conversations")).body.conversations[0].id, "draft-1");
});

test("requests from the bot wait for an answer, and work can be aborted", async t => {
  await tempRoot(t);
  const { api, base } = await startServer(t);
  await createBot({ name: "helper", description: "Helps", prompt: persona });

  const sent = await api("POST", "/bots/helper/conversations/c2", { message: "please approve this" });
  const untilRequest = await readEvents(`${base}${sent.body.streamUrl}`, event => event.type === "request");
  const request = untilRequest.at(-1)!.data;
  assert.equal(request.method, "confirm");
  assert.equal(request.title, "Send the email?");
  assert.deepEqual((await api("GET", "/bots/helper/conversations/c2")).body.pendingRequests, [request]);
  assert.equal((await api("POST", "/bots/helper/conversations/c2/responses", { requestId: request.id })).status, 400);
  assert.equal((await api("POST", "/bots/helper/conversations/c2/responses", { requestId: "other", confirmed: true })).status, 404);
  assert.equal((await api("POST", "/bots/helper/conversations/c2/responses", { requestId: request.id, confirmed: true })).status, 200);
  const rest = await readEvents(`${base}/bots/helper/conversations/c2?view=updates&offset=${untilRequest.at(-1)!.id + 1}`, event => event.type === "settled");
  assert.deepEqual(rest.map(e => e.type).slice(0, 2), ["request_closed", "notice"]);
  assert.equal(rest[1]!.data.message, "Sent.");

  const slow = await api("POST", "/bots/helper/conversations/c2", { message: "slow one" });
  assert.equal((await api("GET", "/bots/helper/conversations/c2")).body.state, "running");
  const queued = await api("POST", "/bots/helper/conversations/c2", { message: "and another" });
  assert.equal(queued.body.disposition, "queued");
  const aborting = await api("POST", "/bots/helper/conversations/c2/abort");
  assert.equal(aborting.status, 202);
  const settled = await readEvents(`${base}${slow.body.streamUrl}`, event => event.type === "settled");
  assert.deepEqual(settled.at(-1)!.data, { aborted: true });
});

test("a Pi that cannot start is reported as a bad gateway, and a crash while working is an error event", async t => {
  await tempRoot(t);
  const { api } = await startServer(t, "crash");
  await createBot({ name: "helper", description: "Helps", prompt: persona });
  const sent = await api("POST", "/bots/helper/conversations/c3", { message: "hi" });
  assert.equal(sent.status, 502);
  assert.match(sent.body.error.message, /Cannot start helper: pi exited with code 3: fake pi refused to start/);
  assert.equal((await api("GET", "/bots/helper/conversations/c3")).body.state, "idle");
});

test("the server binary serves the API on the IPv6 loopback", async t => {
  await tempRoot(t);
  const child = spawn(process.execPath, [BIN, "--port", "0"], { env: { ...process.env, PI_BOT_PI_COMMAND: FAKE_PI }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGTERM"); });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.split("\n")[0]!); });
    child.stderr.on("data", chunk => reject(new Error(String(chunk))));
    child.on("exit", code => reject(new Error(`exited ${code}: ${out}`)));
  });
  const url = /listening on (http:\/\/\[::1\]:\d+)/.exec(line)?.[1];
  assert.ok(url, line);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { status: "ok" });
  assert.equal((await (await fetch(`${url}/bots`)).json() as any).bots.length, 0);
});

test("options come from flags, then the environment, then defaults", () => {
  assert.deepEqual(parseOptions([], { PI_BOT_SERVER_PORT: "8080", PI_BOT_PI_COMMAND: "/opt/pi" }), { host: "::1", port: 8080, pi: "/opt/pi", cwd: parseOptions([], {}) !== "help" ? (parseOptions([], {}) as any).cwd : "", idleMs: 600_000 });
  const flags = parseOptions(["--host", "127.0.0.1", "--port", "1", "--pi", "x", "--cwd", "/tmp", "--idle", "0"], {});
  assert.deepEqual(flags, { host: "127.0.0.1", port: 1, pi: "x", cwd: "/tmp", idleMs: 0 });
  assert.equal(parseOptions(["-h"]), "help");
  assert.throws(() => parseOptions(["--port", "x"], {}), /Invalid port/);
  assert.equal(formatUrl("::1", 5), "http://[::1]:5");
  assert.equal(formatUrl("localhost", 5), "http://localhost:5");
});
