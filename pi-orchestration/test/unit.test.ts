import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { help, intervalMs, modelOption, runCli, splitCommand, statusText, type WorkflowClient } from "../src/cli.ts";
import { EXAMPLES_DIR, guide, README_PATH, template } from "../src/guide.ts";
import type { RunRecord } from "../src/index.ts";
import { linkCli, shellCommand } from "../src/link.ts";
import { assertSocketPath } from "../src/paths.ts";
import { rpc } from "../src/client.ts";
import { WorkflowError } from "../src/errors.ts";
import { lintDeterminism, validateWorkflow } from "../src/loader.ts";
import { catalogText, modelResult, runBrief, runList, runListView, runSummary, runTree, toolHints, validationText } from "../src/presentation.ts";

test("determinism lint reports real control-flow calls only", () => {
  const diagnostics = lintDeterminism(`
    import { setTimeout as wait } from "node:timers/promises";
    // Date.now() in a comment is fine, as is "Math.random()" in a string.
    export default defineWorkflow({
      name: "x",
      async run(ctx) {
        const fixed = new Date(0);
        await ctx.step("effect", async () => Date.now(), { compensate: async () => { Math.random(); } });
        await wait(10);
        return [fixed, new Date(), Math.random()];
      },
    });
  `);
  assert.deepEqual(diagnostics.map(item => item.line), [9, 10, 10]);
  const clocks = lintDeterminism(`export default { async run(ctx) { return [performance.now(), crypto.randomUUID(), randomUUID(), process.hrtime(), randomBytes(4), crypto.randomInt(9), await ctx.step("id", async () => randomUUID())]; } };`);
  assert.deepEqual(clocks.map(item => item.message.split(" is ")[0]), ["performance.now()", "crypto.randomUUID()/getRandomValues()", "crypto.randomUUID()/getRandomValues()", "process.hrtime()", "crypto.randomBytes()/randomInt()", "crypto.randomBytes()/randomInt()"]);
  assert.equal(lintDeterminism("export default {")[0].code, "syntax_error");
  const members = lintDeterminism(`export default { async run(ctx) { await ctx.runAgent("p"); return ctx.args; } };`);
  assert.deepEqual(members.map(item => item.code), ["unknown_context_member"]);
  assert.match(members[0].message, /ctx\.runAgent does not exist.*agent/);
  const options = lintDeterminism(`export default { async run(ctx) { await ctx.agent("p", { tool: [], label: "x" }); await ctx.spawn({ name: "b", detach: true, modle: "m" }); } };`);
  assert.deepEqual(options.map(item => item.code), ["unknown_agent_option", "unknown_agent_option"]);
  assert.match(options[1].message, /'modle'/);
  assert.match(options[0].message, /'tool' \(did you mean 'tools'\?\)/);
});

test("determinism lint reports I/O in control flow but not inside ctx.step", () => {
  const diagnostics = lintDeterminism(`
    import { readFileSync as read } from "node:fs";
    import * as fsp from "fs/promises";
    import { execFileSync } from "child_process";
    export default {
      async run(ctx) {
        const inside = await ctx.step("read", async () => read("a", "utf8") + await fsp.readFile("b") + await fetch("x"));
        const outside = read("README.md", "utf8");
        await fsp.writeFile("c", outside);
        return [inside, execFileSync("git", ["status"]), await fetch("https://example.com")];
      },
    };
  `);
  assert.deepEqual(diagnostics.map(item => [item.code, item.line]), [["nondeterministic_call", 8], ["nondeterministic_call", 9], ["nondeterministic_call", 10], ["nondeterministic_call", 10]]);
  assert.deepEqual(diagnostics.map(item => item.message.split(" ")[0]), ["read()", "fsp.writeFile()", "execFileSync()", "fetch()"]);
  assert.equal(diagnostics[0].message, "read() is I/O; move it into ctx.step().");
});

test("validate reports a load error and the lint findings in one pass, with locations", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "po-")));
  try {
    await writeFile(join(directory, "nondet.ts"), `export default {\n  name: "Non Det",\n  async run(ctx) { return Date.now(); },\n};\n`);
    const nondet = await validateWorkflow({ path: join(directory, "nondet.ts") }, directory);
    assert.equal(nondet.valid, false);
    assert.equal(nondet.path, join(directory, "nondet.ts"));
    assert.deepEqual(nondet.diagnostics.map(item => [item.code, item.line]), [["invalid_workflow", undefined], ["nondeterministic_call", 3]]);
    assert.match(nondet.diagnostics[0].message, /must export default defineWorkflow/);

    await writeFile(join(directory, "helper.ts"), "export const helper = (x: number) => x + ;\n");
    await writeFile(join(directory, "uses.ts"), `import { helper } from "./helper.ts";\nexport default { name: "uses", async run() { return helper(1); } };\n`);
    const uses = await validateWorkflow({ path: join(directory, "uses.ts") }, directory);
    assert.deepEqual(uses.diagnostics.map(({ code, path, line, column }) => ({ code, path, line, column })),
      [{ code: "invalid_workflow", path: join(directory, "helper.ts"), line: 1, column: 42 }]);
    assert.equal(validationText(uses), `Invalid:\n${join(directory, "helper.ts")}:1:42: Cannot load ${join(directory, "uses.ts")}: ParseError: Unexpected token (invalid_workflow)`);

    // A syntax error reaches the loader and the lint; it is reported once.
    await writeFile(join(directory, "syntax.ts"), "export default {\n  name: 'syntax',\n  async run() { const x = ; },\n};\n");
    const syntax = await validateWorkflow({ path: join(directory, "syntax.ts") }, directory);
    assert.deepEqual(syntax.diagnostics.map(({ code, path, line }) => ({ code, path, line })), [{ code: "invalid_workflow", path: join(directory, "syntax.ts"), line: 3 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("command parsing and intervals", () => {
  assert.deepEqual(splitCommand(`run review --args '{"path":"src dir"}' --model "a/b c" x\\ y`),
    ["run", "review", "--args", '{"path":"src dir"}', "--model", "a/b c", "x y"]);
  assert.throws(() => splitCommand(`run "open`), /Unclosed/);
  assert.equal(intervalMs("5s"), 5000);
  assert.equal(intervalMs("250ms"), 250);
  assert.throws(() => intervalMs("1"), /Invalid interval/);
});

test("run lists nest children under their parents", () => {
  const run = (id: string, createdAt: number, parent?: string): RunRecord => ({
    id, createdAt, status: "completed", workflow: { name: id, path: "", hash: "" }, args: {}, cwd: "/", attempt: 1,
    phases: [], steps: [], usage: { inputTokens: 0, outputTokens: 0, agents: 0 }, children: [], depth: parent ? 1 : 0,
    origin: parent ? { kind: "workflow", parentRunId: parent, stepKey: "k" } : { kind: "cli" },
  });
  // The worker lists newest first, so children precede their parent.
  const lines = runList([run("child-b", 4, "parent"), run("child-a", 3, "parent"), run("parent", 2), run("other", 1)]).split("\n");
  assert.deepEqual(lines.map(line => line.trim().split(" ")[0]), ["parent", "child-a", "child-b", "other"]);
  assert.ok(lines[1].startsWith("  "));
});

test("model results truncate on UTF-8 boundaries and point to the full result", () => {
  const view = modelResult("é".repeat(200), "run-1", 120);
  assert.equal(view.truncated, true);
  assert.ok(Buffer.byteLength(view.text) <= 120);
  assert.doesNotMatch(view.text, /\uFFFD/);
  assert.match(view.text, /workflow result run-1/);
  assert.deepEqual(modelResult({ a: 1 }), { text: '{\n  "a": 1\n}', truncated: false });
});

test("every shipped example loads and passes the determinism lint", async () => {
  const directory = fileURLToPath(new URL("../examples/workflows/", import.meta.url));
  const files = (await readdir(directory)).filter(file => file.endsWith(".ts")).sort();
  assert.equal(files.length, 9);
  const names = new Set<string>();
  for (const file of files) {
    const result = await validateWorkflow({ path: join(directory, file) }, directory);
    assert.equal(result.valid, true, `${file}: ${JSON.stringify(result.diagnostics)}`);
    names.add(result.name!);
  }
  assert.equal(names.size, files.length);
});

test("summaries name the model and catalogs read as text", () => {
  const run = {
    id: "r", createdAt: 0, startedAt: 0, endedAt: 2000, status: "completed", workflow: { name: "w", path: "", hash: "" }, args: {}, cwd: "/",
    attempt: 1, phases: [], usage: { inputTokens: 1, outputTokens: 2, costUsd: 0, agents: 1 }, children: [], depth: 0, origin: { kind: "cli" },
    model: "openai/gpt", thinkingLevel: "high",
    steps: [{ key: "a", kind: "agent", status: "failed", attempts: 1, error: { message: "x" } }, { key: "p", kind: "parallel", status: "failed", attempts: 1 }],
  } as RunRecord;
  assert.equal(runSummary(run), "r w completed 2s · openai/gpt:high · 1 agent · 3 tokens · $0.0000 · 1 failed step");
  assert.match(runSummary({ ...run, model: undefined, steps: [] }), / · no model · /);
  // Brief and list views lead with the same fields on every surface.
  const head = { runId: "r", workflow: "w", status: "completed", model: "openai/gpt", summary: runSummary(run) };
  assert.deepEqual(Object.entries(runBrief(run).view).slice(0, 5), Object.entries(head));
  assert.deepEqual(runListView([run, { ...run, id: "c", model: undefined, origin: { kind: "workflow", parentRunId: "r", stepKey: "k" } }]),
    [head, { runId: "c", workflow: "w", status: "completed", summary: runSummary({ ...run, id: "c", model: undefined }), parentRunId: "r" }]);
  assert.match(statusText(run, "workflow --home /h"), /\nresult: workflow --home \/h result r$/);
  const waiting = statusText({ ...run, status: "waiting_signal", waitingFor: { key: "ok", prompt: "Approve?" } });
  assert.match(waiting, /\nWaiting for signal "ok": Approve\?\nDeliver with: workflow signal r "ok" '<json>'$/);
  const gate = { ...run, status: "waiting_signal", waitingFor: { key: "ok", schema: { type: "boolean" } }, parked: true } as RunRecord;
  assert.match(runTree(gate, 0, toolHints), /Deliver with: \{"action":"signal","runId":"r","key":"ok","value":<JSON value, not a string>\}/);
  assert.match(runTree(gate, 0, toolHints), /Resume with: \{"action":"retry","runId":"r"\}/);
  assert.match(runTree(gate, 0, "workflow --home /h"), /Deliver with: workflow --home \/h signal r "ok" '<json>'/);
  assert.match(runTree(gate, 0, toolHints), /Expects: \{"type":"boolean"\}/);
  assert.match(statusText({ ...run, status: "failed", error: { reason: "budget", message: "over" } } as RunRecord), /\nbudget: over$/);
  assert.equal(catalogText([
    { name: "ok", description: "Does it.", path: "/a", args: { type: "object" } as never, source: "project" },
    { name: "broken", path: "/b", args: {} as never, source: "user", error: "SyntaxError" },
  ]), 'ok (project): Does it.\n  args: {"type":"object"}\nbroken (user) cannot load: SyntaxError');
});

test("the starter template is a valid workflow and the guide points at shipped files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "po-"));
  try {
    await writeFile(join(directory, "starter.ts"), template("starter"));
    const result = await validateWorkflow({ path: join(directory, "starter.ts") }, directory);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.equal(result.name, "starter");
  } finally { await rm(directory, { recursive: true, force: true }); }
  const text = guide({ shell: "node /x/workflow.mjs" });
  assert.ok(text.includes(template().trimEnd()));
  assert.ok(text.includes("Shell: `workflow` is not on PATH here, so use the full command: node /x/workflow.mjs run review-file"));
  assert.ok(guide().includes("Shell: workflow run review-file"));
  assert.ok(guide().includes("Add --bg to get a runId at once, then workflow poll <runId>"));
  assert.ok(text.includes("node /x/workflow.mjs result <runId>"));
  assert.equal(validationText({ valid: true, name: "a", path: "/a.ts", diagnostics: [] }), "Valid: a (/a.ts).");
  assert.equal(validationText({ valid: false, diagnostics: [{ line: 3, message: "Use ctx.now()", code: "nondeterministic_call" }] }),
    "Invalid:\nline 3: Use ctx.now() (nondeterministic_call)");
  assert.ok(text.includes(README_PATH) && text.includes(EXAMPLES_DIR));
  await access(README_PATH);
  await access(EXAMPLES_DIR);
  assert.ok(help("/workflow").split("\n").filter(line => /^\S/.test(line) && !/^(Every|run|Exit)/.test(line)).every(line => line.startsWith("/workflow ")));
});

test("the CLI writes a starter workflow and explains an empty catalog", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "po-"));
  const out: string[] = [], err: string[] = [];
  const client: WorkflowClient = { request: async request => { assert.equal(request.action, "catalog"); return []; }, rpc: async () => ({}), ensure: async () => ({}) };
  const cli = (...argv: string[]) => runCli(argv, { cwd, client, env: { PI_CODING_AGENT_DIR: join(cwd, "agent") }, stdout: text => { out.push(text); }, stderr: text => { err.push(text); } });
  try {
    assert.equal(await cli("catalog"), 0);
    assert.match(out.pop()!, /^No workflows in .*\nStart one with: workflow init <name>/);
    assert.equal(await cli("init", "demo"), 0);
    assert.match(out.pop()!, /Next: workflow validate demo\n.*--model provider\/model/);
    assert.equal(await readFile(join(cwd, ".pi", "workflows", "demo.ts"), "utf8"), template("demo"));
    assert.equal(await cli("init", "demo"), 1);
    assert.match(err.pop()!, /already exists/);
    assert.equal(await cli("init", "Not_Kebab"), 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("--model takes a thinking suffix as pi --model does", async () => {
  assert.deepEqual(modelOption("openai/gpt:high"), { model: "openai/gpt", thinkingLevel: "high" });
  assert.deepEqual(modelOption("ollama/llama3:8b"), { model: "ollama/llama3:8b" });
  const launches: unknown[] = [];
  const client: WorkflowClient = {
    request: async request => { launches.push(request); return { runId: "r", status: "queued", model: "openai/gpt" }; },
    rpc: async () => ({}), ensure: async () => ({}),
  };
  const options = { client, env: {}, stdout: () => {}, stderr: () => {} };
  assert.equal(await runCli(["run", "demo", "--model", "openai/gpt:high", "--bg"], options), 0);
  assert.equal(await runCli(["run", "demo", "--model", "openai/gpt:high", "--thinking", "low", "--bg"], options), 0);
  assert.deepEqual(launches.map(item => [(item as { model: string }).model, (item as { thinkingLevel?: string }).thinkingLevel]),
    [["openai/gpt", "high"], ["openai/gpt", "low"]]);
  assert.equal(await runCli(["run", "demo", "--thinking", "huge", "--bg"], options), 1);
});

test("next-step hints keep --home so copied commands reach the same worker", async () => {
  const out: string[] = [];
  const client: WorkflowClient = {
    request: async () => ({ runId: "r", status: "queued", model: "openai/gpt" }),
    rpc: async () => ({}), ensure: async () => ({}),
  };
  const options = { client, env: {}, stdout: (text: string) => { out.push(text); }, stderr: () => {} };
  assert.equal(await runCli(["run", "demo", "--bg", "--home", "/tmp/w h"], options), 0);
  assert.equal(await runCli(["run", "demo", "--bg", "--home", "/tmp/wh"], options), 0);
  assert.equal(await runCli(["run", "demo", "--bg"], options), 0);
  assert.match(out[0], /poll: workflow --home '\/tmp\/w h' poll r\ncancel: workflow --home '\/tmp\/w h' cancel r/);
  assert.match(out[1], /poll: workflow --home \/tmp\/wh poll r/);
  assert.match(out[2], /poll: workflow poll r/);
});

test("the CLI is linked onto PATH once, never over another command", async () => {
  const home = await mkdtemp(join(tmpdir(), "po-"));
  const local = join(home, ".local", "bin"), other = join(home, "other"), state = join(home, "state");
  const bin = join(home, "workflow.mjs");
  await mkdir(local, { recursive: true });
  await mkdir(other);
  await writeFile(bin, "#!/usr/bin/env node\n");
  await chmod(bin, 0o755);
  const env = { HOME: home, PATH: [other, local].join(":") };
  const options = { env, stateDir: state, bin, home, platform: "darwin" as const };
  try {
    assert.equal(await shellCommand(env, bin), `node ${bin}`);
    assert.equal(await linkCli(options), join(local, "workflow"));
    assert.equal(await readlink(join(local, "workflow")), bin);
    assert.equal(await shellCommand(env, bin), "workflow");
    assert.equal(await linkCli(options), undefined);

    // Deleting the link opts out for good.
    await rm(join(local, "workflow"));
    assert.equal(await linkCli(options), undefined);
    await assert.rejects(lstat(join(local, "workflow")));

    // Another `workflow` on PATH, or any file in the way, is left alone.
    await rm(state, { recursive: true });
    await writeFile(join(other, "workflow"), "#!/bin/sh\n");
    await chmod(join(other, "workflow"), 0o755);
    assert.equal(await linkCli(options), undefined);
    assert.equal(await shellCommand(env, bin), `node ${bin}`);
    await rm(join(other, "workflow"));
    await writeFile(join(local, "workflow"), "not executable");
    assert.equal(await linkCli(options), undefined);
    assert.equal(await readFile(join(local, "workflow"), "utf8"), "not executable");

    assert.equal(await linkCli({ ...options, env: { HOME: home, PATH: other } }), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an over-long workflow home fails with an actionable error before connecting", async () => {
  assert.doesNotThrow(() => assertSocketPath("/" + "a".repeat(106)));
  assert.throws(() => assertSocketPath("/" + "a".repeat(107)), (error: WorkflowError) => error.code === "home_too_long" && /shorter --home/.test(error.message));
  assert.throws(() => assertSocketPath("/" + "a".repeat(103), "darwin"), { name: "WorkflowError" });
  await assert.rejects(rpc({ action: "ping" }, { home: join(tmpdir(), "h".repeat(120)) }), (error: WorkflowError) => error.code === "home_too_long");
});
