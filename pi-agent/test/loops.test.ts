import assert from "node:assert/strict";
import test from "node:test";
import { LoopStore, Scheduler, nextTime } from "../src/loops.ts";
import { fixture } from "./helpers.ts";

test("interval and timezone-aware cron validation", () => {
  assert.equal(nextTime({ everyMs: 5000 }, 10), 5010);
  assert.equal(nextTime({ cron: "0 9 * * *", timezone: "UTC" }, Date.parse("2025-01-01T08:00Z")), Date.parse("2025-01-01T09:00Z"));
  assert.equal(nextTime({ cron: "0 9 * * *", timezone: "America/New_York" }, Date.parse("2025-01-01T08:00Z")), Date.parse("2025-01-01T14:00Z"));
  for (const schedule of [{ everyMs: 1 }, { everyMs: NaN }, { cron: "bad" }, { cron: "* * * * *", timezone: "not-a-zone" }]) assert.throws(() => nextTime(schedule, 0));
});

test("persisted claims coalesce missed ticks and never replay uncertain executions", async t => {
  const { root } = await fixture(t);
  const store = new LoopStore(root);
  await store.put("tester", "hourly", "task", { everyMs: 1000 }, 0);
  const claim = await store.claim(9000);
  assert.equal(claim.length, 1);
  assert.equal(claim[0].nextAt, 10000);
  const reopened = new LoopStore(root);
  assert.equal((await reopened.list())[0].last!.status, "started");
  assert.deepEqual(await reopened.claim(9000), []);
  await reopened.finish(claim[0], { sessionFile: "/session" });
  assert.equal((await store.list())[0].last!.status, "completed");
});

test("pause/resume/remove and concurrent scheduler claims are serialized", async t => {
  const { root } = await fixture(t);
  const store = new LoopStore(root);
  await store.put("tester", "work", "task", { everyMs: 1000 }, 0);
  await store.setEnabled("tester", "work", false);
  assert.deepEqual(await store.claim(2000), []);
  await store.setEnabled("tester", "work", true, 2000);
  const claims = await Promise.all([store.claim(3000), new LoopStore(root).claim(3000)]);
  assert.equal(claims.flat().length, 1);
  await store.remove("tester");
  assert.deepEqual(await store.list(), []);
});

test("old completion cannot overwrite a changed schedule", async t => {
  const { root } = await fixture(t);
  const store = new LoopStore(root);
  await store.put("tester", "work", "task", { everyMs: 1000 }, 0);
  const [claim] = await store.claim(1000);
  await store.put("tester", "work", "new task", { everyMs: 2000 }, 1000);
  await store.finish(claim, { error: "old failure" });
  assert.equal((await store.list())[0].last, undefined);
});

test("scheduler cancels on shutdown, reports failures, and is idempotent", async t => {
  const { root } = await fixture(t);
  const store = new LoopStore(root);
  await store.put("tester", "work", "task", { everyMs: 1000 }, 0);
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  let calls = 0;
  const scheduler = new Scheduler(store, async (_loop, signal) => {
    calls++; started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return {};
  });
  const tick = scheduler.tick(1000);
  await ready;
  await scheduler.tick(2000); // A second tick must not overlap the same agent.
  assert.equal(calls, 1);
  await scheduler.stop(); await tick; await scheduler.stop();
  assert.equal(calls, 1);
  assert.equal((await store.list())[0].last!.status, "failed");
  await scheduler.tick(5000);
  assert.equal(calls, 1);
});
