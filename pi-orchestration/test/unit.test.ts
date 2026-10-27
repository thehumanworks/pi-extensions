import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { intervalMs, splitCommand } from "../src/cli.ts";
import type { RunRecord } from "../src/index.ts";
import { lintDeterminism, validateWorkflow } from "../src/loader.ts";
import { modelResult, runList } from "../src/presentation.ts";

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
  assert.equal(lintDeterminism("export default {")[0].code, "syntax_error");
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
  assert.match(view.text, /pi-workflow result run-1/);
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
