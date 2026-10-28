import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RunRecord } from "../src/index.ts";
import { CLI, workflow } from "./helpers.ts";

interface Result { code: number; stdout: string; stderr: string; json: any }

/** The compiled CLI and its detached worker, isolated from the user's Pi configuration. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "po-"));
  const project = join(root, "p");
  await mkdir(join(project, ".pi", "workflows"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PI_WORKFLOW_HOME: join(root, "h"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WORKFLOW_NODE: process.execPath };
  for (const key of ["PI_WORKFLOW_ALLOW_UNATTENDED", "PI_WORKFLOW_RUN_ID", "PI_WORKFLOW_STEP"]) delete env[key];
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<Result>(resolve => {
    execFile(process.execPath, [CLI, ...args, "--json"], { cwd: project, env: { ...env, ...extra }, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? typeof error.code === "number" ? error.code : 1 : 0;
      const last = stdout.trim().split("\n").at(-1);
      let json: unknown;
      try { json = last ? JSON.parse(last) : undefined; } catch { json = undefined; }
      resolve({ code, stdout, stderr, json });
    });
  });
  const unattended = { PI_WORKFLOW_ALLOW_UNATTENDED: "1" };
  return {
    root, project, cli, unattended,
    write: (name: string, source: string) => writeFile(join(project, ".pi", "workflows", `${name}.ts`), source),
    close: async () => { await cli(["worker", "stop"]); await rm(root, { recursive: true, force: true }); },
  };
}

test("the compiled CLI enforces headless opt-in and documented exit codes", { timeout: 60_000 }, async () => {
  const s = await sandbox();
  try {
    await s.write("quick", workflow(`{ name: "quick", args: Type.Object({ n: Type.Number() }), async run(ctx) { return ctx.args.n * 2; } }`));
    await s.write("gate", workflow(`{ name: "gate", async run(ctx) { return ctx.signal("go", { schema: Type.Boolean() }); } }`));
    await s.write("clock", workflow(`{ name: "clock", async run() { return Date.now(); } }`));

    const refused = await s.cli(["run", "quick", "--args", '{"n":1}']);
    assert.equal(refused.code, 2);
    assert.equal(refused.json.error.code, "unattended_forbidden");
    assert.equal((await s.cli(["run", "quick", "--args", '{"n":"x"}'], s.unattended)).code, 1);
    assert.equal((await s.cli(["nope"])).code, 1);
    assert.equal((await s.cli(["validate", "clock"])).code, 1);

    const quick = await s.cli(["run", "quick", "--args", '{"n":21}'], s.unattended);
    assert.equal(quick.code, 0, quick.stderr);
    assert.equal(quick.json.status, "completed");
    assert.equal((await s.cli(["result", quick.json.id])).json, 42);

    const gate = await s.cli(["run", "gate", "--bg"], s.unattended);
    assert.equal(gate.code, 0);
    const runId = gate.json.runId as string;
    assert.equal((await s.cli(["poll", runId, "--until", "signal", "--interval", "20ms"])).code, 0);
    assert.equal((await s.cli(["signal", runId, "go", '"yes"'])).code, 1);
    assert.equal((await s.cli(["signal", runId, "go", "true"])).code, 0);
    const done = await s.cli(["poll", runId, "--interval", "20ms"]);
    assert.equal(done.code, 0);
    assert.equal(done.json.result, true);
  } finally { await s.close(); }
});

test("a SIGKILLed worker resumes runs without repeating committed steps", { timeout: 60_000 }, async () => {
  const s = await sandbox();
  try {
    await s.write("slow", workflow(`{
      name: "slow",
      async run(ctx) {
        const before = await ctx.step("before", async () => process.pid);
        await ctx.sleep(1500);
        // Keep both runs pending even if worker restart outlasts the sleep.
        await ctx.signal("finish");
        return { before, after: await ctx.step("after", async () => process.pid) };
      },
    }`));
    const launched = await s.cli(["run", "slow", "--bg"], s.unattended);
    const doomed = await s.cli(["run", "slow", "--bg"], s.unattended);
    const runId = launched.json.runId as string;
    for (let deadline = Date.now() + 10_000; ;) {
      const status = await s.cli(["status", runId]);
      if ((status.json as RunRecord).steps.some(step => step.kind === "sleep" && step.status === "running")) break;
      assert.ok(Date.now() < deadline, "the run never reached its sleep");
      await delay(20);
    }
    const worker = await s.cli(["worker", "status"]);
    process.kill(worker.json.pid, "SIGKILL");

    // The next command starts a replacement worker, which replays both runs.
    const cancelled = await s.cli(["cancel", doomed.json.runId]);
    assert.equal(cancelled.json.status, "cancelled");
    assert.equal((await s.cli(["poll", doomed.json.runId, "--interval", "20ms"])).code, 3);
    const waiting = await s.cli(["poll", runId, "--until", "signal", "--interval", "50ms"]);
    assert.equal(waiting.json.status, "waiting_signal");
    assert.equal((await s.cli(["signal", runId, "finish", "null"])).code, 0);
    const done = await s.cli(["poll", runId, "--interval", "50ms"]);
    assert.equal(done.code, 0, done.stderr);
    const run = done.json as RunRecord;
    const result = run.result as { before: number; after: number };
    assert.equal(result.before, worker.json.pid);
    assert.notEqual(result.after, worker.json.pid);
    assert.ok(run.endedAt! - run.startedAt! >= 1500);
  } finally { await s.close(); }
});
