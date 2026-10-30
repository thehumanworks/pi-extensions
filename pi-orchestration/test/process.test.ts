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
  // A model the worker can resolve; these workflows never call it.
  await mkdir(join(root, "agent"));
  await writeFile(join(root, "agent", "models.json"), JSON.stringify({ providers: { local: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "m1" }],
  } } }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_WORKFLOW_")));
  const env: NodeJS.ProcessEnv = { ...inherited, PI_WORKFLOW_HOME: join(root, "h"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_WORKFLOW_NODE: process.execPath };
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}, json = true) => new Promise<Result>(resolve => {
    execFile(process.execPath, [CLI, ...args, ...json ? ["--json"] : []], { cwd: project, env: { ...env, ...extra }, timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? typeof error.code === "number" ? error.code : 1 : 0;
      const last = stdout.trim().split("\n").at(-1);
      let json: unknown;
      try { json = last ? JSON.parse(last) : undefined; } catch { json = undefined; }
      resolve({ code, stdout, stderr, json });
    });
  });
  return {
    root, project, cli,
    write: (name: string, source: string) => writeFile(join(project, ".pi", "workflows", `${name}.ts`), source),
    close: async () => { await cli(["worker", "stop"]); await rm(root, { recursive: true, force: true }); },
  };
}

test("the compiled CLI launches root workflows without opt-in, rejects inner launches and preserves exit codes", { timeout: 60_000 }, async () => {
  const s = await sandbox();
  try {
    await s.write("quick", workflow(`{ name: "quick", args: Type.Object({ n: Type.Number() }), async run(ctx) { return ctx.args.n * 2; } }`));
    await s.write("gate", workflow(`{ name: "gate", async run(ctx) { return ctx.signal("go", { schema: Type.Boolean() }); } }`));
    await s.write("clock", workflow(`{ name: "clock", async run() { return Date.now(); } }`));

    const idle = await s.cli(["worker", "status"], {}, false);
    assert.equal(idle.code, 4);
    assert.match(idle.stderr, /^error worker_unavailable: No workflow worker is running .* worker start;/);

    const refused = await s.cli(["run", "quick", "--args", '{"n":1}'],
      { PI_WORKFLOW_RUN_ID: "parent", PI_WORKFLOW_STEP: "root/agent#0" });
    assert.equal(refused.code, 2);
    assert.equal(refused.json.error.code, "not_from_root");
    assert.equal((await s.cli(["run", "quick", "--args", '{"n":"x"}'])).code, 1);
    assert.equal((await s.cli(["nope"])).code, 1);
    assert.equal((await s.cli(["validate", "clock"])).code, 1);

    // Every --json run view is the Pi tool's brief view: runId, the workflow's name and the model as one string.
    const quick = await s.cli(["run", "quick", "--args", '{"n":21}', "--model", "local/m1"]);
    assert.equal(quick.code, 0, quick.stderr);
    assert.equal(quick.stdout.trim().split("\n").length, 1);
    const brief = { runId: quick.json.runId, workflow: "quick", status: "completed", model: "local/m1", summary: quick.json.summary, result: 42 };
    assert.deepEqual(quick.json, brief);
    assert.deepEqual((await s.cli(["status", brief.runId])).json, brief);
    const listed = (await s.cli(["list"])).json;
    assert.deepEqual(listed, [{ runId: brief.runId, workflow: "quick", status: "completed", model: "local/m1", summary: brief.summary }]);
    const full = (await s.cli(["status", brief.runId, "--verbose"])).json as RunRecord;
    assert.equal(full.id, brief.runId);
    assert.equal(full.model, "local/m1");
    assert.equal(full.workflow.name, "quick");
    assert.equal((await s.cli(["result", brief.runId])).json, 42);
    assert.match((await s.cli(["agents"], {}, false)).stdout, /^No background agents\. /);
    assert.match((await s.cli(["worker", "status"], {}, false)).stdout, /^worker pid \d+ · home /);

    const gate = await s.cli(["run", "gate", "--bg", "--model", "local/m1:high"]);
    assert.equal(gate.code, 0);
    const runId = gate.json.runId as string;
    assert.deepEqual(gate.json, { runId, status: "queued", model: "local/m1" });
    const waiting = await s.cli(["poll", runId, "--until", "signal", "--interval", "20ms"]);
    assert.equal(waiting.code, 0);
    assert.equal(waiting.json.runId, runId);
    assert.equal(waiting.json.waitingFor.key, "go");
    assert.ok(!("id" in waiting.json));
    assert.equal((await s.cli(["signal", runId, "go", '"yes"'])).code, 1);
    const accepted = await s.cli(["signal", runId, "go", "true"], {}, false);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, new RegExp(`^Signal "go" accepted\\. poll: .*poll ${runId}\\n$`));
    const done = await s.cli(["poll", runId, "--until", "done", "--interval", "20ms"]);
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
    const launched = await s.cli(["run", "slow", "--bg"]);
    const doomed = await s.cli(["run", "slow", "--bg"]);
    const runId = launched.json.runId as string;
    for (let deadline = Date.now() + 10_000; ;) {
      const status = await s.cli(["status", runId, "--verbose"]);
      if ((status.json as RunRecord).steps.some(step => step.kind === "sleep" && step.status === "running")) break;
      assert.ok(Date.now() < deadline, "the run never reached its sleep");
      await delay(20);
    }
    const worker = await s.cli(["worker", "status"]);
    process.kill(worker.json.pid, "SIGKILL");

    // The next command starts a replacement worker, which replays both runs.
    const cancelled = await s.cli(["cancel", doomed.json.runId], {}, false);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /cancelled/);
    assert.doesNotMatch(cancelled.stdout, /^\{/);
    const unreadable = await s.cli(["result", doomed.json.runId], {}, false);
    assert.equal(unreadable.code, 3, unreadable.stderr);
    assert.match(unreadable.stderr, /run_cancelled/);
    assert.equal((await s.cli(["poll", doomed.json.runId, "--interval", "20ms"])).code, 3);
    const waiting = await s.cli(["poll", runId, "--interval", "50ms"]);
    assert.equal(waiting.json.status, "waiting_signal");
    assert.equal((await s.cli(["signal", runId, "finish", "null"])).code, 0);
    const done = await s.cli(["poll", runId, "--until", "done", "--interval", "50ms"]);
    assert.equal(done.code, 0, done.stderr);
    const run = (await s.cli(["status", runId, "--verbose"])).json as RunRecord;
    const result = run.result as { before: number; after: number };
    assert.equal(result.before, worker.json.pid);
    assert.notEqual(result.after, worker.json.pid);
    assert.ok(run.endedAt! - run.startedAt! >= 1500);
  } finally { await s.close(); }
});
