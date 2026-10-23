import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openScheduler, Schedules, type Schedule, type Scheduler } from "../src/scheduler.ts";
import type { CreateRequest } from "../src/protocol.ts";

function fixture() {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const request: CreateRequest = { action: "create", requestId: "request-one", frequency: "1s",
    prompt: "Check exactly this.", cwd: process.cwd(),
    model: { provider: faux.models[0].provider, modelId: faux.models[0].id }, thinkingLevel: "off" };
  return { faux, models, request };
}
async function until(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for scheduler");
    await delay(20);
  }
}
async function show(scheduler: Scheduler, id: string) {
  return await scheduler.request({ action: "show", id }) as Schedule & { taskState: { status: string } };
}

test("create is idempotent, pause/resume/delete are durable management operations", async () => {
  const { models, request } = fixture();
  const scheduler = await openScheduler(new MemoryStorage(), models);
  try {
    const first = await scheduler.request({ ...request, frequency: "1d" }) as Schedule;
    const duplicate = await scheduler.request({ ...request, frequency: "2d" }) as Schedule;
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.frequency, "1d");
    assert.equal((await scheduler.request({ action: "list" }) as unknown[]).length, 1);
    await scheduler.request({ action: "pause", id: first.id });
    assert.equal((await show(scheduler, first.id)).status, "paused");
    const resumed = await scheduler.request({ action: "resume", id: first.id }) as Schedule;
    assert.equal(resumed.status, "active");
    assert.notEqual(resumed.taskId, first.taskId);
    await scheduler.request({ action: "delete", id: first.id });
    assert.deepEqual(await scheduler.request({ action: "list" }), []);
    await assert.rejects(scheduler.request({ action: "show", id: first.id }), /Unknown schedule/);
    const retryAfterDelete = await scheduler.request(request) as Schedule;
    assert.equal(retryAfterDelete.status, "deleted", "late transport retries never resurrect a deleted job");
  } finally { await scheduler.close(); }
});

test("scheduled runs execute core tools on the host and keep separate transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-tools-"));
  const { faux, models, request } = fixture();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "result.txt", content: "one" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("First result"),
    fauxAssistantMessage("Second result"),
  ]);
  const scheduler = await openScheduler(new MemoryStorage(), models);
  try {
    const created = await scheduler.request({ ...request, cwd: dir }) as Schedule;
    await until(async () => (await show(scheduler, created.id)).runs.length >= 2);
    await scheduler.request({ action: "pause", id: created.id });
    assert.equal(await readFile(join(dir, "result.txt"), "utf8"), "one");
    const results = (await show(scheduler, created.id)).runs;
    assert.equal(results[0].output, "First result");
    assert.equal(results[1].output, "Second result");
    assert.notEqual(results[0].conversationId, results[1].conversationId);
    for (const run of results.slice(0, 2)) {
      const conversation = await scheduler.harness.conversation(run.conversationId, BACKGROUND_CONTEXT);
      const view = await conversation!.context(BACKGROUND_CONTEXT);
      const users = view.messages.filter(m => m.role === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].content, request.prompt);
    }
  } finally { await scheduler.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite reopen resumes an overdue schedule once, without a backlog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-reopen-"));
  const { faux, models, request } = fixture();
  faux.setResponses([fauxAssistantMessage("Recovered")]);
  const file = join(dir, "state.sqlite");
  let scheduler = await openScheduler(await openNodeSqliteStorage(file), models);
  try {
    const created = await scheduler.request(request) as Schedule;
    await scheduler.close();
    await delay(2100);
    scheduler = await openScheduler(await openNodeSqliteStorage(file), models);
    await until(async () => (await show(scheduler, created.id)).runs.length === 1);
    await scheduler.request({ action: "pause", id: created.id });
    assert.equal((await show(scheduler, created.id)).runs[0].output, "Recovered");
    assert.equal(faux.state.callCount, 1);
  } finally { await scheduler.close(); await rm(dir, { recursive: true, force: true }); }
});

test("pausing an in-flight run aborts it and prevents future ticks", async () => {
  const { faux, models, request } = fixture();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
  ]);
  const scheduler = await openScheduler(new MemoryStorage(), models);
  try {
    const created = await scheduler.request(request) as Schedule;
    await until(async () => faux.state.callCount >= 1);
    await delay(100);
    await scheduler.request({ action: "pause", id: created.id });
    await delay(1100);
    assert.equal(faux.state.callCount, 1);
    assert.equal((await show(scheduler, created.id)).taskState.status, "terminal");
  } finally { await scheduler.close(); }
});

test("resume repairs a terminal task even if its metadata still says active", async () => {
  const { models, request } = fixture();
  const scheduler = await openScheduler(new MemoryStorage(), models);
  try {
    const created = await scheduler.request({ ...request, frequency: "1d" }) as Schedule;
    await scheduler.harness.abortTask(created.taskId!, BACKGROUND_CONTEXT);
    await scheduler.harness.waitForTask(created.taskId!, BACKGROUND_CONTEXT);
    assert.equal((await scheduler.harness.snapshot(Schedules, BACKGROUND_CONTEXT))!.schedules[created.id].status, "active");
    const resumed = await scheduler.request({ action: "resume", id: created.id }) as Schedule;
    assert.notEqual(resumed.taskId, created.taskId);
  } finally { await scheduler.close(); }
});
