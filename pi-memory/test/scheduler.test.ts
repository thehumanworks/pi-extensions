import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IdleScheduler } from "../src/scheduler.ts";

test("background model work waits for idle and cancels without a call when input arrives", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const scheduler = new IdleScheduler({ statePath: join(root, "state.json"), idleDelayMs: 20, backoffMs: 1000, canRun: () => true, run: async () => { calls++; }, onError: error => { throw error; } });
  await scheduler.schedule({}); await scheduler.cancel(); await delay(30);
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(root, "state.json")), { code: "ENOENT" });
});

test("aborted inference leaves durable backoff across a new scheduler", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, clock = 1000;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const options = { statePath: join(root, "state.json"), idleDelayMs: 1, backoffMs: 1000, canRun: () => true, now: () => clock, onError: (error: unknown) => { throw error; }, run: async (_context: {}, signal: AbortSignal) => { calls++; started(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } };
  const scheduler = new IdleScheduler(options);
  await scheduler.schedule({}); await Promise.race([ready, delay(1000).then(() => { throw new Error("Scheduler never ran"); })]); await scheduler.cancel();
  assert.equal(calls, 1);
  const restarted = new IdleScheduler({ ...options, run: async () => { calls++; } });
  assert.equal(await restarted.schedule({}), true);
  await delay(10); await restarted.cancel(); assert.equal(calls, 1);
  clock = 2001;
  assert.equal(await restarted.schedule({}), true);
  await delay(20); await restarted.cancel(); assert.equal(calls, 2);
});

test("pending work resumes after backoff without another user turn", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const scheduler = new IdleScheduler({ statePath: join(root, "state.json"), idleDelayMs: 1, backoffMs: 50, canRun: () => true, run: async () => { calls++; }, onError: error => { throw error; } });
  await scheduler.schedule({}); await delay(20); assert.equal(calls, 1);
  await scheduler.schedule({}); await delay(10); assert.equal(calls, 1);
  await delay(60); await scheduler.cancel(); assert.equal(calls, 2);
});

test("a session that becomes busy before the delay never starts background inference", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let idle = true, calls = 0;
  const scheduler = new IdleScheduler({ statePath: join(root, "state.json"), idleDelayMs: 10, backoffMs: 1000, canRun: () => idle, run: async () => { calls++; }, onError: error => { throw error; } });
  await scheduler.schedule({}); idle = false; await delay(20); await scheduler.cancel(); assert.equal(calls, 0);
});

test("disposed sessions cannot schedule from a late capture continuation", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const scheduler = new IdleScheduler({ statePath: join(root, "state.json"), idleDelayMs: 1, backoffMs: 1000, canRun: () => true, run: async () => { calls++; }, onError: error => { throw error; } });
  await scheduler.dispose(); assert.equal(await scheduler.schedule({}), false); await delay(10); assert.equal(calls, 0);
});

test("overlapping schedule calls start one cancellable task", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-schedule-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, aborted = false, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new IdleScheduler({ statePath: join(root, "state.json"), idleDelayMs: 1, backoffMs: 1000, canRun: () => true,
    run: async (_context, signal) => { calls++; started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); },
    onError: error => { throw error; } });
  assert.deepEqual(await Promise.all([scheduler.schedule({}), scheduler.schedule({})]), [true, false]);
  await Promise.race([ready, delay(1000).then(() => { throw new Error("Scheduler never ran"); })]);
  assert.equal(await scheduler.schedule({}), false);
  await scheduler.cancel();
  assert.equal(calls, 1); assert.equal(aborted, true);
});
