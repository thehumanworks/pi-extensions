import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Board } from "../src/board.ts";
import { Scheduler } from "../src/scheduler.ts";

function temp(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "subagents-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
test("one owner; recover safe work but require reconciliation for an interrupted mutation", (t) => {
  const dir = temp(t);
  let b = new Board(dir);
  assert.throws(() => new Board(dir), /locked|busy/i);
  const a = b.add("A", "p", "m"),
    c = b.add("C", "p", "m");
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
  const b = new Board(temp(t));
  b.configure({ depth: 2, concurrency: 1 });
  const j = b.add("top", "p", "m");
  b.claim();
  b.finish(j.id, { kind: "delegate", text: "sub", history: [] });
  const child = b.claim()!;
  assert.equal(child.depth, 2);
  assert.equal(b.get(j.id).state, "waiting");
  assert.throws(() => b.add("too deep", "p", "m", child));
  b.finish(child.id, { kind: "done", text: "answer", history: [] });
  assert.match(b.claim()!.prompt, /answer/);
  b.close();
});
test("global concurrency cap, nonblocking submission, bounded retries, and shutdown abort", async (t) => {
  const dir = temp(t),
    b = new Board(dir);
  b.configure({ concurrency: 2, depth: 1 });
  const ids = ["fail", "hang", "hang"].map((s) => b.add(s, "p", "m").id);
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
      const b=new Board(process.argv[1]); const j=b.add("write report","p","m");
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
