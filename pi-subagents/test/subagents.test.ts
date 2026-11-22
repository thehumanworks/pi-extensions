import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Board } from "../src/board.ts";
import { Scheduler } from "../src/scheduler.ts";

const worker = { provider: "p", model: "m" };

function temp(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "subagents-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
test("one owner; recover safe work but require reconciliation for an interrupted mutation", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  assert.throws(() => new Board(dir), /locked|busy/i);
  const a = b.add("A", worker),
    c = b.add("C", worker);
  b.claim();
  b.claim();
  b.markMutation(a.id, "edit");
  b.close();
  b = new Board(dir);
  assert.equal(b.get(a.id).state, "blocked");
  assert.equal(b.get(c.id).state, "queued");
  assert.throws(() => b.resume(c.id, "no"));
  b.resume(a.id, "Checked: change is already present.");
  assert.match(b.get(a.id).prompt, /already present/);
  b.close();
});
test("a waiting parent releases its slot; child result and parent continuation commit together", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  b.configure({ depth: 2, concurrency: 1 });
  const config = { ...worker, reasoningEffort: "low" as const, systemPrompt: "Review only." };
  const j = b.add("top", config);
  b.claim();
  b.finish(j.id, { kind: "delegate", text: "sub", history: [] });
  b.close();
  b = new Board(dir);
  const child = b.claim()!;
  assert.equal(child.depth, 2);
  assert.equal(b.get(j.id).state, "waiting");
  assert.equal(child.provider, config.provider);
  assert.equal(child.model, config.model);
  assert.equal(child.reasoningEffort, config.reasoningEffort);
  assert.equal(child.systemPrompt, config.systemPrompt);
  b.finish(child.id, { kind: "delegate", text: "too deep", history: [] });
  assert.match(b.get(child.id).note, /Depth limit reached/);
  b.resume(child.id, "Answer directly.");
  const resumed = b.claim()!;
  assert.equal(resumed.id, child.id);
  assert.equal(resumed.systemPrompt, config.systemPrompt);
  assert.equal(resumed.reasoningEffort, config.reasoningEffort);
  b.finish(child.id, { kind: "done", text: "answer", history: [] });
  assert.match(b.claim()!.prompt, /answer/);
  b.close();
});
test("a failed child releases its parent once; a retried child reports to the lead during a newer wait", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  t.after(() => b.close());
  b.configure({ concurrency: 1, depth: 2 });
  const { id: parent } = b.add("parent", worker);
  assert.equal(b.claim()?.id, parent);
  b.finish(parent, { kind: "delegate", text: "first child", history: [] });
  const waiting = b.get(parent);
  const child = waiting.waitingFor!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(b.claim()?.id, child);
    b.fail(child, "service unavailable", 0);
    if (attempt < 3) {
      assert.equal(b.get(child).state, "queued");
      assert.deepEqual(b.get(parent), waiting);
    }
  }
  assert.equal(b.get(child).state, "failed");
  const released = b.get(parent);
  assert.equal(released.state, "queued");
  assert.equal(released.waitingFor, undefined);
  assert.match(released.prompt, new RegExp(child + " failed:\\nservice unavailable"));
  b.close();

  b = new Board(dir);
  assert.deepEqual(b.get(parent), released);
  b.resume(child, "Try again after the service is restored.");
  assert.equal(b.claim()?.id, parent);
  b.finish(parent, { kind: "delegate", text: "second child", history: [] });
  const nextWait = b.get(parent);
  assert.notEqual(nextWait.waitingFor, child);
  assert.equal(b.claim()?.id, child);
  b.finish(child, { kind: "done", text: "Recovered first result", history: [] });
  assert.deepEqual(b.get(parent), nextWait);
  assert.equal(b.summaries().find((j) => j.id === child)?.notifyLead, true);

  const nextChild = b.claim()!;
  assert.equal(nextChild.id, nextWait.waitingFor);
  b.finish(nextChild.id, { kind: "done", text: "Second result", history: [] });
  assert.equal(b.summaries().find((j) => j.id === nextChild.id)?.notifyLead, false);
  const resumed = b.claim()!;
  assert.equal(resumed.id, parent);
  assert.match(resumed.prompt, /Second result/);
  assert.doesNotMatch(resumed.prompt, /Recovered first result/);
  b.finish(nextChild.id, { kind: "done", text: "Duplicate", history: [] });
  assert.deepEqual(b.get(parent), resumed);
});

test("a retried child's result for the lead survives reopening after the parent finished", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  t.after(() => b.close());
  b.configure({ concurrency: 1, depth: 2 });
  const { id: parent } = b.add("parent", worker);
  assert.equal(b.claim()?.id, parent);
  b.finish(parent, { kind: "delegate", text: "child", history: [] });
  const child = b.get(parent).waitingFor!;
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(b.claim()?.id, child);
    b.fail(child, "offline", 0);
  }
  assert.equal(b.summaries().find((j) => j.id === child)?.notifyLead, false);
  assert.equal(b.claim()?.id, parent);
  b.finish(parent, { kind: "done", text: "Finished without child", history: [] });
  const finishedParent = b.get(parent);

  b.resume(child, "Retry now.");
  assert.equal(b.claim()?.id, child);
  b.finish(child, { kind: "done", text: "Recovered result", history: [] });
  const finishedChild = b.get(child);
  b.close();

  b = new Board(dir);
  assert.deepEqual(b.get(parent), finishedParent);
  const summary = b.summaries().find((j) => j.id === child);
  assert.equal(summary?.state, "done");
  assert.equal(summary?.parent, parent);
  assert.equal(summary?.note, "Recovered result");
  assert.equal(summary?.notifyLead, true);
  b.finish(child, { kind: "done", text: "Duplicate", history: [] });
  assert.deepEqual(b.get(child), finishedChild);
});

test("recovery releases a parent if interruption exhausts its child's retry budget", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  t.after(() => b.close());
  b.configure({ concurrency: 1, depth: 2 });
  const { id: parent } = b.add("parent", worker);
  b.claim();
  b.finish(parent, { kind: "delegate", text: "child", history: [] });
  const { id: child } = b.claim()!;
  b.fail(child, "offline", 0);
  b.claim();
  b.fail(child, "offline", 0);
  assert.equal(b.claim()?.attempts, 3);
  b.close();

  b = new Board(dir);
  assert.equal(b.get(child).state, "failed");
  assert.equal(b.get(parent).state, "queued");
  assert.match(b.get(parent).prompt, /failed:\nLead session interrupted/);
});

test("an older board recovers a waiting parent whose child already failed", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  t.after(() => b.close());
  b.configure({ concurrency: 1, depth: 2 });
  const { id: parent } = b.add("parent", worker);
  b.claim();
  b.finish(parent, { kind: "delegate", text: "child", history: [] });
  const child = b.get(parent).waitingFor!;
  b.close();

  const db = new DatabaseSync(join(dir, "board.sqlite"));
  try {
    db.prepare("UPDATE jobs SET data=json_remove(data,'$.waitingFor') WHERE id=?").run(parent);
    db.prepare(
      "UPDATE jobs SET state='failed', data=json_set(data,'$.state','failed','$.note','offline') WHERE id=?",
    ).run(child);
  } finally {
    db.close();
  }

  b = new Board(dir);
  assert.equal(b.get(parent).state, "queued");
  assert.match(b.get(parent).prompt, /failed:\noffline/);
});

test("global concurrency cap, nonblocking submission, bounded retries, and shutdown abort", async (t) => {
  const dir = temp(t),
    b = new Board(dir);
  b.configure({ concurrency: 2, depth: 1 });
  const ids = ["fail", "hang", "hang"].map((s) => b.add(s, worker).id);
  let running = 0,
    peak = 0,
    attempts = 0;
  const s = new Scheduler(
    b,
    async (j, signal) => {
      peak = Math.max(peak, ++running);
      try {
        if (j.task === "fail") {
          attempts++;
          throw new Error("offline");
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("interrupted");
      } finally {
        running--;
      }
    },
    () => {},
    (e) => assert.fail(String(e)),
    0,
  );
  s.wake();
  assert.equal(running, 0);
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(attempts, 3);
  assert.equal(peak, 2);
  assert.equal(b.get(ids[0]).state, "failed");
  await s.close();
  assert.equal(running, 0);
  const restored = new Board(dir);
  assert.equal(restored.list("queued").length, 2);
  restored.close();
});
test(
  "a killed owner leaves durable work, not a stale lock or a replayed write",
  { timeout: 10000 },
  async (t) => {
    const dir = temp(t);
    const moduleUrl = new URL("../src/board.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {Board} from ${JSON.stringify(moduleUrl)};
      const b=new Board(process.argv[1]); const j=b.add("write report",{provider:"p",model:"m"});
      b.claim(); b.markMutation(j.id,"write on report"); console.log(j.id); setInterval(()=>{},1000);`,
        dir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      child.kill("SIGKILL");
    });
    const [chunk] = await once(child.stdout, "data");
    const id = String(chunk).trim();
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const b = new Board(dir);
    assert.equal(b.get(id).state, "blocked");
    assert.match(b.get(id).note, /write on report/);
    assert.equal(b.claim(), undefined);
    b.close();
  },
);
