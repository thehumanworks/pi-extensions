import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { BackgroundAgentRecord, CatalogEntry, RunRecord, ValidationResult } from "../src/index.ts";
import { runBrief, runSummary } from "../src/presentation.ts";
import { CLI, fixture, git, workflow } from "./helpers.ts";

const exists = (path: string) => access(path).then(() => true, () => false);
const step = (run: RunRecord, key: string) => run.steps.find(item => item.key === key);

test("control flow keeps authored order and journals helpers", async () => {
  const f = await fixture({ workflows: { flow: workflow(`{
    name: "flow",
    args: Type.Object({ n: Type.Number() }),
    async run(ctx) {
      ctx.phase("Compute");
      ctx.log("start", { n: ctx.args.n });
      const now = ctx.now(), random = ctx.random();
      const squares = await ctx.parallel([3, 1, 2].map(i => () => ctx.step("sq-" + i, async () => {
        await new Promise(resolve => setTimeout(resolve, i * 15));
        return i * i * ctx.args.n;
      })));
      const piped = await ctx.pipeline([1, 2], x => x + 1, (x, item, index) => x * 10 + item + index);
      const nulls = await ctx.parallel([() => ctx.step("bad", async () => { throw new Error("nope"); }), () => ctx.step("good", async () => 1)]);
      const settled = await ctx.parallel([() => ctx.step("bad2", async () => { throw new Error("nope2"); })], { failure: "allSettled" });
      await ctx.sleep(10);
      return { squares, piped, nulls, settled, stable: now > 0 && random >= 0 && random < 1 };
    },
  }`) } });
  try {
    const run = await f.run("flow", { n: 2 });
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(run.result, {
      squares: [18, 2, 8], piped: [21, 33], nulls: [null, 1], stable: true,
      settled: [{ status: "rejected", reason: { message: "nope2", code: "step_failed" } }],
    });
    // Keys follow structure, not completion order.
    assert.deepEqual(run.steps.filter(item => item.key.startsWith("root/parallel#4/")).map(item => item.key),
      ["root/parallel#4/0/sq-3", "root/parallel#4/1/sq-1", "root/parallel#4/2/sq-2"]);
    assert.deepEqual(run.logs?.map(item => item.message), ["start"]);
    assert.equal(run.phases[0]?.title, "Compute");

    const invalid = await f.request<RunRecord>({ action: "run", requestId: "bad-args", workflow: { name: "flow" }, args: { n: "x" }, cwd: f.project, origin: { kind: "cli" } })
      .then(() => undefined, (error: { code: string; message: string }) => error);
    assert.equal(invalid?.code, "invalid_args");
    assert.match(invalid?.message ?? "", /args\/n: .*\(got "x"\)/);
    const encoded = await f.request<RunRecord>({ action: "run", requestId: "string-args", workflow: { name: "flow" }, args: '{"n":2}', cwd: f.project, origin: { kind: "cli" } })
      .then(() => undefined, (error: { code: string; message: string }) => error);
    assert.equal(encoded?.code, "invalid_args");
    assert.match(encoded?.message ?? "", /JSON-encoded string; pass the object itself/);
  } finally { await f.close(); }
});

test("steps run against the run cwd, retry, and compensate once on revert", async () => {
  const f = await fixture({ workflows: { effects: workflow(`{
    name: "effects",
    async run(ctx) {
      const file = await ctx.step("write", async ({ cwd }) => {
        const marker = join(cwd, "attempts.txt");
        const attempts = Number(await readFile(marker, "utf8").catch(() => "0")) + 1;
        await writeFile(marker, String(attempts));
        if (attempts === 1) throw new Error("transient");
        await writeFile(join(cwd, "out.txt"), "hello");
        return "out.txt";
      }, { retries: 1, compensate: async name => { await rm(join(ctx.cwd, name)); } });
      return file;
    },
  }`, `import { join } from "node:path";\nimport { readFile, rm, writeFile } from "node:fs/promises";`) } });
  try {
    const run = await f.run("effects");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.equal(step(run, "root/write")?.attempts, 2);
    assert.equal(await readFile(join(f.project, "out.txt"), "utf8"), "hello");
    assert.equal(await exists(join(f.home, "out.txt")), false);

    const reverted = await f.request<RunRecord>({ action: "revert", runId: run.id });
    assert.equal(reverted.status, "reverted", JSON.stringify(reverted.error));
    assert.equal(step(reverted, "root/write")?.status, "compensated");
    assert.equal(await exists(join(f.project, "out.txt")), false);
    assert.equal((await f.request<RunRecord>({ action: "revert", runId: run.id })).status, "reverted");
  } finally { await f.close(); }
});

test("retry from a step replays the earlier journal", async () => {
  const f = await fixture({ workflows: { counter: workflow(`{
    name: "counter",
    async run(ctx) {
      const bump = (name: string) => ctx.step(name, async ({ cwd }) => {
        const file = join(cwd, name);
        const value = Number(await readFile(file, "utf8").catch(() => "0")) + 1;
        await writeFile(file, String(value));
        return value;
      });
      return [await bump("a"), await bump("b")];
    },
  }`, `import { join } from "node:path";\nimport { readFile, writeFile } from "node:fs/promises";`) } });
  try {
    const first = await f.run("counter");
    assert.deepEqual(first.result, [1, 1]);
    const queued = await f.request<RunRecord>({ action: "retry", runId: first.id, from: "root/b" });
    assert.equal(queued.attempt, 2);
    const second = await f.wait(first.id, run => run.status === "completed" && run.attempt === 2);
    assert.deepEqual(second.result, [1, 2]);
    const unknown = await f.request({ action: "retry", runId: first.id, from: "root/nope" }).then(() => "", (error: { code: string }) => error.code);
    assert.equal(unknown, "unknown_step");
  } finally { await f.close(); }
});

test("signals are schema-checked and children charge their parent", async () => {
  const f = await fixture({ workflows: {
    gate: workflow(`{
      name: "gate",
      async run(ctx) {
        const approval = await ctx.signal("approve", { schema: Type.Object({ ok: Type.Boolean() }), prompt: "Approve?" });
        return { approval, child: await ctx.workflow("child", { x: 2 }) };
      },
    }`),
    child: workflow(`{
      name: "child",
      args: Type.Object({ x: Type.Number() }),
      async run(ctx) { return { doubled: ctx.args.x * 2, said: await ctx.agent("ECHO hi", { tools: [] }) }; },
    }`),
  } });
  try {
    const runId = await f.launch("gate");
    const waiting = await f.wait(runId, run => run.status === "waiting_signal");
    assert.equal(waiting.waitingFor?.key, "approve");
    assert.equal(waiting.waitingFor?.prompt, "Approve?");
    assert.ok(waiting.waitingFor?.schema, "waitingFor exposes the signal schema");
    const failure = (error: { code: string; message: string }) => `${error.code}: ${error.message}`;
    const invalid = await f.request({ action: "signal", runId, key: "approve", value: { ok: "yes" } }).then(() => "", failure);
    assert.match(invalid, /^invalid_signal: Signal 'approve' expects \{.*\}; got \{"ok":"yes"\}\.\nvalue\/ok: .* \(got "yes"\)/);
    assert.match(await f.request({ action: "signal", runId, key: "approve", value: "{}" }).then(() => "", failure), /not a JSON-encoded string/);
    assert.match(await f.request({ action: "signal", runId, key: "aprove", value: {} }).then(() => "", failure), /^unknown_signal: .*waiting for 'approve'/);
    await f.request({ action: "signal", runId, key: "approve", value: { ok: true } });
    const done = await f.wait(runId);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.deepEqual(done.result, { approval: { ok: true }, child: { doubled: 4, said: "hi" } });
    assert.equal(done.children.length, 1);
    assert.equal(done.usage.agents, 1);
    const roots = await f.request<RunRecord[]>({ action: "list" });
    const all = await f.request<RunRecord[]>({ action: "list", filter: { all: true } });
    assert.deepEqual(roots.map(run => run.id), [runId]);
    assert.equal(all.length, 2);
    const gated = await f.launch("gate");
    await f.wait(gated, run => run.status === "waiting_signal");
    await f.request({ action: "cancel", runId: gated });
    const cancelled = await f.wait(gated);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.waitingFor, undefined, "a terminal run is not waiting for a signal");
  } finally { await f.close(); }
});

test("nondeterministic control flow is rejected by lint and at run time", async () => {
  const f = await fixture({ workflows: { clock: workflow(`{
    name: "clock",
    async run(ctx) {
      const allowed = await ctx.step("inside-step", async () => Date.now());
      return allowed + Date.now();
    },
  }`) } });
  try {
    const validation = await f.request<ValidationResult>({ action: "validate", workflow: { name: "clock" }, cwd: f.project });
    assert.equal(validation.valid, false);
    assert.deepEqual(validation.diagnostics.map(item => [item.code, item.line]), [["nondeterministic_call", 8]]);
    const run = await f.run("clock");
    assert.equal(run.status, "failed");
    assert.equal(run.error?.reason, "nondeterministic_call");
    assert.equal(step(run, "root/inside-step")?.status, "completed");
  } finally { await f.close(); }
});

test("catalog reports a broken file without hiding valid workflows", async () => {
  const f = await fixture({ workflows: {
    good: workflow(`{ name: "good", description: "Works", async run() { return 1; } }`),
    broken: "export default { oops",
    plainargs: workflow(`{ name: "plainargs", args: { topic: "string" }, async run() { return 1; } }`),
    stringargs: workflow(`{ name: "stringargs", args: Type.String(), async run() { return 1; } }`),
  } });
  try {
    const entries = await f.request<CatalogEntry[]>({ action: "catalog", cwd: f.project });
    assert.deepEqual(entries.map(entry => [entry.name, entry.error === undefined]), [["broken", false], ["good", true], ["plainargs", false], ["stringargs", false]]);
    assert.match(entries[0].error!, /Cannot load/);
    assert.match(entries[2].error!, /args must be Type\.Object\(\{\.\.\.\}\) from "typebox"; got \{"topic":"string"\}/);
    assert.match(entries[3].error!, /args must be Type\.Object/);
    assert.equal((await f.run("good")).result, 1);
  } finally { await f.close(); }
});

test("agents return text or validated structured results with one repair turn", async () => {
  const f = await fixture({ workflows: { agents: workflow(`{
    name: "agents",
    async run(ctx) {
      const Result = Type.Object({ value: Type.Number() });
      return ctx.parallel([
        () => ctx.agent("ECHO plain", { tools: [] }),
        () => ctx.agent('SUBMIT {"value":1}', { tools: [], schema: Result }),
        () => ctx.agent('REPAIR {"value":2}', { tools: [], schema: Result }),
        () => ctx.agent("NEVER", { tools: [], schema: Result }),
        () => ctx.agent("ECHO typo", { tool: [] } as never),
      ], { failure: "allSettled" });
    },
  }`) } });
  try {
    const run = await f.run("agents");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    const results = run.result as Array<{ status: string; value?: unknown; reason?: { code?: string } }>;
    assert.deepEqual(results.slice(0, 3).map(item => item.value), ["plain", { value: 1 }, { value: 2 }]);
    assert.equal(results[3].reason?.code, "invalid_structured_output");
    assert.equal(results[4].reason?.code, "unknown_agent_option");
    assert.match((results[4].reason as { message: string }).message, /'tool' \(did you mean 'tools'\?\)/);
    assert.equal(run.usage.agents, 4);
    assert.ok(run.usage.inputTokens > 0);
  } finally { await f.close(); }
});

test("agent retries recover provider failures and budgets stop new agents", async () => {
  const f = await fixture({ workflows: {
    flaky: workflow(`{ name: "flaky", async run(ctx) { return ctx.agent("FAIL_ONCE a", { tools: [], retries: 1 }); } }`),
    capped: workflow(`{
      name: "capped",
      budget: { maxAgents: 1 },
      async run(ctx) { await ctx.agent("ECHO one", { tools: [] }); return ctx.agent("ECHO two", { tools: [] }); },
    }`),
  } });
  try {
    const flaky = await f.run("flaky");
    assert.equal(flaky.status, "completed", JSON.stringify(flaky.error));
    assert.match(String(flaky.result), /^ok: FAIL_ONCE/);
    const capped = await f.run("capped");
    assert.equal(capped.status, "failed");
    assert.equal(capped.error?.reason, "budget_exceeded");
    assert.equal(capped.usage.agents, 1);
  } finally { await f.close(); }
});

test("worktree isolation works under a symlinked home and revert removes it", async () => {
  const f = await fixture({ symlinkHome: true, workflows: { iso: workflow(`{
    name: "iso",
    async run(ctx) { return ctx.agent("BASH pwd && git branch --show-current", { tools: ["bash"], isolation: "worktree", label: "attempt-a" }); },
  }`) } });
  try {
    const run = await f.run("iso");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    const tree = step(run, "root/agent#0")?.worktree;
    assert.ok(tree);
    assert.equal(tree.branch, `orch/${run.id}/attempt-a`);
    assert.equal(tree.path, await realpath(join(f.home, "worktrees", run.id, "attempt-a")));
    assert.match(String(run.result), new RegExp(`orch/${run.id}/attempt-a`));
    assert.match(git(f.project, "worktree", "list"), /attempt-a/);

    // A launch from inside an owned worktree is refused even through the symlinked path.
    const refused = await f.launch("iso", {}, { cwd: join(f.home, "worktrees", run.id, "attempt-a") }).then(() => "", (error: { code: string }) => error.code);
    assert.equal(refused, "not_from_root");

    const reverted = await f.request<RunRecord>({ action: "revert", runId: run.id });
    assert.equal(reverted.status, "reverted", JSON.stringify(reverted.error));
    assert.doesNotMatch(git(f.project, "worktree", "list"), /attempt-a/);
    // Branches remain for review.
    assert.match(git(f.project, "branch", "--list", `orch/${run.id}/*`), /attempt-a/);
  } finally { await f.close(); }
});

test("worker caller markers and inner agent environments prevent nested launches", async () => {
  const f = await fixture({ workflows: {
    nested: workflow(`{
      name: "nested",
      async run(ctx) { return ctx.agent(${JSON.stringify(`BASH printf 'caller=%s step=%s\\n' "$PI_WORKFLOW_RUN_ID" "$PI_WORKFLOW_STEP"; ${process.execPath} ${CLI} run nested --json`)}, { tools: ["bash"] }); },
    }`),
  } });
  try {
    // A direct worker request cannot sidestep the client root check with caller markers.
    await assert.rejects(f.launch("nested", {}, { callerRunId: "parent", callerStep: "root/agent#0" }),
      (error: { code?: string }) => error.code === "not_from_root");
    const run = await f.run("nested");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.match(String(run.result), new RegExp(`caller=${run.id} step=root/agent#0`));
    assert.match(String(run.result), /not_from_root/);
    assert.equal((await f.request<RunRecord[]>({ action: "list", filter: { all: true } })).length, 1);
  } finally { await f.close(); }
});

test("background agents keep context and swarms deduplicate their queue", async () => {
  const f = await fixture({ workflows: { team: workflow(`{
    name: "team",
    defaults: { tools: [] },
    async run(ctx) {
      const notes = await ctx.spawn({ name: "notes", initialPrompt: "ECHO 17" });
      const first = await notes.wait({ timeoutMs: 10_000 });
      await notes.send("RECALL");
      const recalled = await notes.wait({ timeoutMs: 10_000 });
      const status = await notes.status();
      await notes.stop();
      const swarm = await ctx.swarm({ workers: 2, queue: ["a", "b", "a"], worker: { prompt: item => "ECHO " + item } });
      return { first, recalled, status, results: [...swarm.results].sort(), processed: swarm.processed };
    },
  }`) } });
  try {
    const run = await f.run("team");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(run.result, { first: "17", recalled: "17", status: "idle", results: ["a", "b"], processed: 2 });
    const agents = await f.request<BackgroundAgentRecord[]>({ action: "agents", runId: run.id });
    assert.equal(agents.length, 3);
    assert.ok(agents.every(agent => agent.status === "stopped"));
  } finally { await f.close(); }
});

test("status names the model, surfaces failed branches and hides journal bookkeeping", async () => {
  const f = await fixture({ workflows: {
    partial: workflow(`{
      name: "partial",
      async run(ctx) {
        return ctx.parallel([() => ctx.step("bad", async () => { throw new Error("nope"); }), () => ctx.agent("ECHO fine")]);
      },
    }`),
    pinned: workflow(`{ name: "pinned", defaults: { model: "faux/faux-1" }, async run(ctx) { return ctx.agent("ECHO pinned"); } }`),
  } });
  try {
    const run = await f.run("partial", {}, { thinkingLevel: "low" });
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(run.result, [null, "fine"]);
    for (const field of ["requestId", "taskId", "helpers", "positions", "nextSequence", "signals", "limits"]) assert.ok(!(field in run), field);
    for (const item of run.steps) for (const field of ["fingerprint", "sequence", "generation", "taskId"]) assert.ok(!(field in item), `${item.key}.${field}`);
    assert.match(runSummary(run), / · faux\/faux-1:low · .* · 1 failed step$/);
    const brief = runBrief(run);
    const bad = run.steps.find(item => item.status === "failed")!;
    assert.deepEqual(brief.view.failedSteps, [{ key: bad.key, error: "nope" }]);
    assert.deepEqual(brief.view.result, [null, "fine"]);
    assert.ok(!("steps" in brief.view));

    // Definition defaults outrank the launch model for every agent, so the run reports them.
    const pinned = await f.request<{ runId: string; model?: string }>({
      action: "run", requestId: "pinned", workflow: { name: "pinned" }, args: {}, cwd: f.project, model: "faux/other", origin: { kind: "cli" },
    });
    assert.equal(pinned.model, "faux/faux-1");
    const done = await f.wait(pinned.runId);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(done.model, "faux/faux-1");

    // Whichever surface launched it, the run stores its model as "provider/modelId".
    const object = await f.request<{ runId: string; model?: string }>({
      action: "run", requestId: "object", workflow: { name: "partial" }, args: {}, cwd: f.project,
      model: { provider: "faux", modelId: "faux-1" }, origin: { kind: "tool", sessionId: "s" },
    });
    assert.equal(object.model, "faux/faux-1");
    assert.equal((await f.wait(object.runId)).model, "faux/faux-1");
  } finally { await f.close(); }
});
