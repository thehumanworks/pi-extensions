import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PiSessionRequest, PiSessionRunner } from "../src/engine/pi-session.ts";
import { WorkflowError } from "../src/errors.ts";
import { EXPRESSION_WORKFLOW } from "../src/guide.ts";
import type { RunRecord } from "../src/index.ts";
import { fixture, workflow } from "./helpers.ts";

/** Stands in for createAgentSession: records requests, fails once on FAIL_ONCE <id>, echoes the prompt's first line. */
function fakePiSessions() {
  const requests: PiSessionRequest[] = [];
  const failed = new Set<string>();
  const piSession: PiSessionRunner = async request => {
    requests.push(request);
    const once = /FAIL_ONCE (\S+)/.exec(request.prompt);
    if (once && !failed.has(once[1])) { failed.add(once[1]); throw new WorkflowError("agent_failed", "scripted pi failure", request.key); }
    request.log("fake pi session");
    return {
      output: `PI:${request.prompt.trim().split("\n")[0]}`,
      sessionFile: `/sessions/${request.key.replaceAll("/", "_")}.jsonl`,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    };
  };
  return { requests, piSession };
}

const step = (run: RunRecord, key: string) => run.steps.find(item => item.key === key);

test("runtime pi agents and presets run as pi sessions: journaled render, pi tool options, usage, session files", async () => {
  const fake = fakePiSessions();
  const f = await fixture({ worker: { piSession: fake.piSession }, workflows: { mixed: workflow(`{
    name: "mixed",
    async run(ctx) {
      ctx.phase("Work");
      const plain = await ctx.agent("hello pi", { runtime: "pi", tools: ["read", "grep"], excludeTools: ["bash"], label: "plain", instructions: "be brief" });
      const preset = await ctx.preset("review", { args: { focus: "perf" }, inputs: ["upstream text"], copy: { index: 2, count: 3, variant: "perf" } });
      const durable = await ctx.agent("ECHO durable");
      return { plain, preset, durable };
    },
  }`) } });
  try {
    await f.write(".pi/presets/review.toml", [
      'model = "faux/faux-1"', 'thinking = "low"', 'instructions = "Review carefully."', 'includeTools = ["read"]', 'excludeTools = ["write"]',
      'retries = 1', 'outputFilePath = "out/review.md"',
      "task = '''", "focus {{ args.focus }} copy {{ copy.index }}/{{ copy.count }}:{{ copy.variant }} dir {% sh basename \"$PWD\" %}", "{{ input }}", "'''",
    ].join("\n"));
    const run = await f.run("mixed");
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.deepEqual(run.result, { plain: "PI:hello pi", preset: "PI:focus perf copy 2/3:perf dir p", durable: "durable" });

    const [plain, preset] = fake.requests;
    assert.deepEqual([plain.tools, plain.excludeTools, plain.instructions, plain.label], [["read", "grep"], ["bash"], "be brief", "plain"]);
    assert.deepEqual([preset.tools, preset.excludeTools, preset.thinkingLevel, preset.instructions, preset.label], [["read"], ["write"], "low", "Review carefully.", "review:perf"]);
    assert.deepEqual(preset.model, { provider: "faux", modelId: "faux-1" });
    assert.equal(preset.cwd, f.project);
    assert.equal(preset.prompt, "focus perf copy 2/3:perf dir p\nupstream text\n");
    assert.equal(await (await import("node:fs/promises")).readFile(join(f.project, "out", "review.md"), "utf8"), "PI:focus perf copy 2/3:perf dir p");

    const render = step(run, "root/review/render")!;
    assert.equal(render.kind, "step");
    assert.equal(render.status, "completed");
    const agent = step(run, "root/review")!;
    assert.equal(agent.kind, "agent");
    assert.equal(agent.sessionFile, "/sessions/root_review.jsonl");
    assert.deepEqual(agent.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    assert.equal(agent.label, "review:perf");
    assert.ok(!("conversationId" in agent));
    assert.equal(step(run, "root/agent#1")!.sessionFile, "/sessions/root_agent#1.jsonl");
    assert.equal(step(run, "root/agent#1")!.label, "plain");
    assert.equal(run.usage.agents, 3);
    assert.equal(run.usage.inputTokens, 20 + (step(run, "root/agent#3")!.usage?.inputTokens ?? 0));
    assert.equal(run.phases[0]!.done, 3);
    assert.deepEqual(run.logs?.map(item => item.message), ["fake pi session", "fake pi session"]);
  } finally { await f.close(); }
});

test("expressions run as one durable workflow: a failed stage fails the run, retry replays finished stages and re-runs the rest", async () => {
  const fake = fakePiSessions();
  const f = await fixture({ worker: { piSession: fake.piSession } });
  try {
    const presetDirs = [join(f.project, ".pi", "presets")];
    await f.write(".pi/presets/ping.toml", 'model = "faux/faux-1"\ntask = "PONG{% if copy %}-{{ copy.variant }}{% endif %}{% if inputs.size > 0 %} after [{{ inputs | join: \', \' }}]{% endif %}"\n');
    await f.write(".pi/presets/flaky.toml", "model = \"faux/faux-1\"\ntask = '''\n{% sh test ! -e FAIL || { echo simulated >&2; exit 1; } %}FLAKY after [{{ inputs | join: \", \" }}]\n'''\n");
    await f.write(".pi/presets/shaky.toml", 'model = "faux/faux-1"\nretries = 1\ntask = "FAIL_ONCE shaky {{ input }}"\n');
    await f.write(".pi/presets/judge.toml", 'model = "faux/faux-1"\noutput = "verdict"\ntask = "judge: {{ input }}"\n');
    await f.write("FAIL", "");

    const failing = await f.run(EXPRESSION_WORKFLOW, { expression: "@ping * [a, b] -> @flaky -> @shaky", presetDirs });
    assert.equal(failing.status, "failed");
    assert.match(failing.error?.message ?? "", /command failed \(exit 1\)[\s\S]*simulated/);
    assert.equal(failing.error?.stepKey, "root/2/render");
    assert.equal(fake.requests.length, 2, "both fan-out copies ran, nothing after the failed render");
    assert.deepEqual(fake.requests.map(request => request.prompt).sort(), ["PONG-a", "PONG-b"]);
    assert.deepEqual(fake.requests.map(request => request.label).sort(), ["ping:a", "ping:b"]);

    await rm(join(f.project, "FAIL"));
    const retried = await f.request<RunRecord>({ action: "retry", runId: failing.id });
    const done = await f.wait(retried.id);
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(done.result, "PI:FAIL_ONCE shaky PI:FLAKY after [PI:PONG-a, PI:PONG-b]");
    assert.equal(fake.requests.length, 5, "retry re-ran the flaky stage once and the shaky stage twice; the copies replayed");
    assert.equal(step(done, "root/3")!.attempts, 2);
    assert.equal(step(done, "root/3")!.status, "completed");
    assert.ok(done.steps.some(item => item.key === "root/parallel#0/0/1.#1" && item.kind === "agent" && item.status === "completed"));
    assert.equal(done.usage.agents, 4);

    // The verdict instruction is appended for judge presets and a rejection carries feedback into the next iteration.
    const judged = await f.run(EXPRESSION_WORKFLOW, { expression: "repeat @ping until @judge max 1", presetDirs });
    assert.equal(judged.status, "failed");
    assert.match(judged.error?.message ?? "", /did not approve after 1 iteration/);
    const judge = fake.requests.at(-1)!;
    assert.match(judge.prompt, /^judge: PI:PONG\n\nEnd your reply with one JSON object/);
    assert.equal(judged.logs?.at(-1)?.message, "iteration 1 rejected (no verdict found in the judge's output)");

    const typo = await f.request<RunRecord>({ action: "run", requestId: "typo", workflow: { path: EXPRESSION_WORKFLOW }, args: { expression: "@nope", presetDirs }, cwd: f.project, origin: { kind: "cli" } });
    const missing = await f.wait((typo as unknown as { runId: string }).runId);
    assert.equal(missing.status, "failed");
    assert.match(missing.error?.message ?? "", /Preset "nope" not found/);
  } finally { await f.close(); }
});

test("a schema on a pi-runtime agent and a worker without pi sessions fail clearly", async () => {
  const f = await fixture({ workflows: {
    schema: workflow(`{ name: "schema", async run(ctx) { return ctx.agent("x", { runtime: "pi", schema: Type.Object({ a: Type.String() }) }); } }`),
    nopi: workflow(`{ name: "nopi", async run(ctx) { return ctx.agent("x", { runtime: "pi" }); } }`),
  } });
  try {
    const schema = await f.run("schema");
    assert.equal(schema.error?.reason, "unsupported_option");
    const nopi = await f.run("nopi");
    assert.equal(nopi.error?.reason, "pi_runtime_unavailable");
    await writeFile(join(f.project, "unused"), "");
  } finally { await f.close(); }
});
