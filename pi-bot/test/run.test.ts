import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDepth, EventParser, failed, runArgs, runBot } from "../src/run.ts";
import { invocations, useFakePi } from "./helpers.ts";

test("child arguments store the session in the bot home and load this extension", () => {
  const base = { bot: "a", task: "--looks like a flag", sessionsDir: "/bots/a/sessions", extension: "/ext/index.ts" };
  assert.deepEqual(runArgs(base), ["--mode", "json", "-p", "--session-dir", "/bots/a/sessions", "--bot", "a", "-e", "/ext/index.ts", "--", "--looks like a flag"]);
  assert.deepEqual(runArgs({ ...base, session: { path: "/s.jsonl", fork: false } }).slice(9, 11), ["--session", "/s.jsonl"]);
  assert.deepEqual(runArgs({ ...base, session: { path: "/s.jsonl", fork: true } }).slice(9, 11), ["--fork", "/s.jsonl"]);
});

test("depth comes from PI_BOT_DEPTH", () => {
  assert.equal(currentDepth({}), 0);
  assert.equal(currentDepth({ PI_BOT_DEPTH: "2" }), 2);
  assert.equal(currentDepth({ PI_BOT_DEPTH: "junk" }), 0);
});

test("the event parser splits only on LF and survives chunk boundaries", () => {
  const parser = new EventParser("a", "/cwd");
  const records = [
    { type: "session", id: "abc", cwd: "/elsewhere" },
    { type: "message_end", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "line\u2028sep é" }, { type: "toolCall" }], usage: { input: 3, output: 4, cost: { total: 0.5 } }, stopReason: "toolUse" } },
    { type: "message_end", message: { role: "user", content: "ignored" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" } },
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\r\n") + "\n");
  // Feed one byte at a time to split multi-byte characters across chunks.
  for (let i = 0; i < bytes.length; i++) parser.feed(bytes.subarray(i, i + 1));
  parser.end();
  const { result } = parser;
  assert.equal(result.sessionId, "abc");
  assert.equal(result.cwd, "/elsewhere");
  assert.equal(result.output, "final");
  assert.equal(result.model, "p/m");
  assert.deepEqual([result.usage.turns, result.usage.input, result.usage.output, result.usage.cost, result.toolCalls], [2, 3, 4, 0.5, 1]);
  assert.equal(result.stopReason, "stop");
});

test("runBot starts Pi in the target directory with an incremented depth", async t => {
  const log = await useFakePi(t);
  const cwd = await mkdtemp(join(tmpdir(), "pi-bot-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const updates: number[] = [];
  const result = await runBot({ bot: "a", task: "check it", cwd, sessionsDir: "/bots/a/sessions", extension: "/ext/index.ts", depth: 1, onProgress: r => updates.push(r.usage.turns) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "Done: check it");
  assert.equal(result.sessionId, "s-1");
  assert.equal(result.toolCalls, 1);
  assert.ok(!failed(result));
  assert.ok(updates.includes(2));
  const [call] = invocations(log);
  assert.equal(call!.depth, "2");
  assert.equal(call!.args.at(-1), "check it");
  assert.match(readFileSync(log, "utf8"), new RegExp(cwd.split("/").at(-1)!));
});

test("runBot reports model errors and aborts", async t => {
  await useFakePi(t, "error");
  const failure = await runBot({ bot: "a", task: "x", cwd: process.cwd(), sessionsDir: "/s", extension: "/e", depth: 0 });
  assert.ok(failed(failure));
  assert.equal(failure.errorMessage, "Rate limited");
  assert.match(failure.stderr, /provider exploded/);

  process.env.FAKE_PI_MODE = "sleep";
  const controller = new AbortController();
  const pending = runBot({ bot: "a", task: "x", cwd: process.cwd(), sessionsDir: "/s", extension: "/e", depth: 0, signal: controller.signal, onProgress: () => controller.abort() });
  const aborted = await pending;
  assert.ok(aborted.aborted);
  assert.ok(failed(aborted));
});
