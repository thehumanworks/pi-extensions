import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { format, plan, presetsIn } from "../src/dsl/ast.ts";
import { type Executor, ExpressionFailure, interpret, type StageCall } from "../src/dsl/interpreter.ts";
import { looksLikeExpression, parse } from "../src/dsl/parser.ts";
import { listPresets, loadPreset, parsePreset, presetDirectories } from "../src/presets.ts";
import { forwardedEnv, renderTemplate } from "../src/template.ts";
import { parseVerdict } from "../src/verdict.ts";

const roundtrip = (source: string) => format(parse(source));

test("expressions parse: presets, args, fan-out, branches, loops; errors point at the position", () => {
  assert.deepEqual(parse("yeet"), { type: "preset", name: "yeet", args: {} });
  assert.deepEqual(parse('@review(focus=security, n=2, strict=true, msg="a b")'),
    { type: "preset", name: "review", args: { focus: "security", n: 2, strict: true, msg: "a b" } });
  const src = "repeat ((@code-review * 4) -> @synthesizer -> @coder) until @judge max 3 -> @summariser";
  assert.equal(roundtrip(src), "repeat (@code-review * 4 -> @synthesizer -> @coder) until @judge max 3 -> @summariser");
  assert.deepEqual(presetsIn(parse(src)), ["code-review", "synthesizer", "coder", "judge", "summariser"]);
  assert.deepEqual(parse("@a * [security, perf]"), { type: "fanout", body: { type: "preset", name: "a", args: {} }, count: 2, variants: ["security", "perf"] });
  assert.equal(roundtrip("[@a, @b -> @c] * 2 -> @d"), "[@a, @b -> @c] * 2 -> @d");
  assert.equal(roundtrip("[@a,] -> @b"), "@a -> @b");
  assert.deepEqual(parse("@max"), { type: "preset", name: "max", args: {} });
  assert.throws(() => parse("max"), /keyword/);
  assert.throws(() => parse("@a ->"), /Expected a preset.*position 5/s);
  assert.throws(() => parse("@a * 0"), /at least 1/);
  assert.throws(() => parse("repeat @a until @j"), /Expected "max"/);
  assert.throws(() => parse("@a @b"), /Unexpected "@b"/);
  assert.throws(() => parse("@a -> $b"), /Unexpected character/);
  assert.throws(() => parse(""), /Empty/);
  assert.equal(looksLikeExpression("review"), false);
  assert.equal(looksLikeExpression("@review"), true);
  assert.equal(looksLikeExpression("a -> b"), true);
  assert.equal(looksLikeExpression("repeat @a until @b max 1"), true);
  assert.equal(plan(parse("repeat (@a * 2 -> @b) until @j max 3 -> @s")), [
    "pipeline", "  1.", "     repeat (max 3)", "       pipeline", "         1.", "            fan-out × 2", "              @a",
    "         2.", "            @b", "     until approved by", "       @j", "  2.", "     @s",
  ].join("\n"));
});

function fakeExecutor(behaviour: (call: StageCall) => string | undefined = () => undefined) {
  const calls: StageCall[] = [];
  const logs: string[] = [];
  const executor: Executor = {
    stage: async call => { calls.push(call); return behaviour(call) ?? `${call.preset}(${call.inputs.join("+")})`; },
    parallel: thunks => Promise.all(thunks.map(thunk => thunk())),
    log: message => { logs.push(message); },
  };
  return { calls, logs, executor };
}

test("the interpreter threads outputs, fans out with copy info, loops on verdicts and keys stages structurally", async () => {
  const pipe = fakeExecutor();
  assert.deepEqual(await interpret(parse("@a -> @b -> @c"), pipe.executor), ["c(b(a()))"]);
  assert.deepEqual(pipe.calls.map(c => c.key), ["1", "2", "3"]);

  const fan = fakeExecutor(c => c.copy ? `${c.preset}${c.copy.index}/${c.copy.count}:${c.copy.variant ?? "-"}` : undefined);
  assert.deepEqual(await interpret(parse("@a * [x, y] -> @b"), fan.executor), ["b(a1/2:x+a2/2:y)"]);
  assert.deepEqual(fan.calls.map(c => c.key), ["1.#1", "1.#2", "2"]);
  assert.deepEqual(fan.calls[0].copy, { index: 1, count: 2, variant: "x" });

  const branches = fakeExecutor();
  assert.deepEqual(await interpret(parse("@s -> [@a, @b -> @c] -> @d"), branches.executor), ["d(a(s())+c(b(s())))"]);
  assert.deepEqual(branches.calls.map(c => c.key), ["1", "2.b1", "2.b2.1", "2.b2.2", "3"]);

  const args = fakeExecutor();
  await interpret(parse("@a(n=2) -> @b"), args.executor, { n: 1, p: "x" });
  assert.deepEqual(args.calls.map(c => c.args), [{ n: 2, p: "x" }, { n: 1, p: "x" }]);

  let judgeCalls = 0;
  const loop = fakeExecutor(c => {
    if (c.preset === "judge") return ++judgeCalls < 2 ? '{"approved": false, "feedback": "add tests"}' : 'ok {"approved": true}';
    if (c.preset === "coder") return `coder#${c.iteration}[${c.feedback ?? ""}]`;
    return undefined;
  });
  assert.deepEqual(await interpret(parse("repeat @coder until @judge max 3 -> @done"), loop.executor), ["done(coder#2[add tests])"]);
  assert.deepEqual(loop.calls.map(c => c.key), ["1.i1.body", "1.i1.judge", "1.i2.body", "1.i2.judge", "2"]);
  assert.deepEqual(loop.calls[1].inputs, ["coder#1[]"]);
  assert.equal(loop.calls[2].feedback, "add tests");
  assert.deepEqual(loop.logs, ["iteration 1 rejected", "approved after 2 iterations"]);

  const never = fakeExecutor(c => c.preset === "judge" ? "looks fine to me" : undefined);
  await assert.rejects(interpret(parse("repeat @a until @judge max 2"), never.executor), (error: ExpressionFailure) =>
    error instanceof ExpressionFailure && /did not approve after 2 iterations/.test(error.message) && error.stageKey === "repeat");
  assert.equal(never.calls.length, 4);
  assert.match(never.logs[0], /no verdict found/);
});

test("verdicts: the last approved object wins, only literal true approves, no verdict rejects", () => {
  assert.deepEqual(parseVerdict('Looks good.\n{"approved": true, "feedback": ""}'), { approved: true, feedback: "", parsed: true });
  assert.deepEqual(parseVerdict('first {"approved": true}\n```json\n{"approved": false, "feedback": "fix {x}"}\n```'), { approved: false, feedback: "fix {x}", parsed: true });
  assert.equal(parseVerdict('{"approved": false, "feedback": "no"}\n{"unrelated": 1}').feedback, "no");
  assert.equal(parseVerdict('{"approved": "yes"}').approved, false);
  assert.deepEqual(parseVerdict("  I approve!  "), { approved: false, feedback: "I approve!", parsed: false });
});

test("templates render args, pipeline variables and shell commands in cwd with the given env", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "asx-tpl-")));
  try {
    assert.equal(await renderTemplate("{% if args.prompt %}user: {{ args.prompt }}{% endif %}", { args: { prompt: "hi" } }), "user: hi");
    assert.equal(await renderTemplate("{% if args.prompt %}user: {{ args.prompt }}{% endif %}"), "");
    assert.equal(await renderTemplate("[{% sh pwd %}]", { cwd: dir }), `[${dir}]`);
    assert.equal(await renderTemplate("{% sh printf '%s' \"$ASX_T\" %}", { cwd: dir, env: { ...process.env, ASX_T: "from-env" } }), "from-env");
    assert.equal(await renderTemplate(`{{ "echo " | append: args.n | sh }}`, { cwd: dir, args: { n: 3 } }), "3");
    assert.equal(await renderTemplate("{{ input }}|{{ inputs.size }}|{{ copy.index }}/{{ copy.count }}:{{ copy.variant }}|{{ iteration }}|{{ feedback }}",
      { inputs: ["a", "b"], copy: { index: 2, count: 3, variant: "perf" }, iteration: 4, feedback: "more tests" }),
      "--- input 1 of 2 ---\na\n\n--- input 2 of 2 ---\nb|2|2/3:perf|4|more tests");
    assert.equal(await renderTemplate("[{{ input }}][{{ inputs.size }}]", { inputs: ["only"] }), "[only][1]");
    await assert.rejects(renderTemplate("{% sh echo oops >&2; exit 3 %}", { cwd: dir }), /exit 3[\s\S]*oops/);
    await assert.rejects(renderTemplate("{% sh %}"), /requires a command/);
    await assert.rejects(renderTemplate("{{ 'a' | nope }}"), /nope/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const env = forwardedEnv({ PATH: "/bin", HOME: "/h", GIT_DIR: ".git", OPENAI_API_KEY: "secret", ASX_PRESET_DIR: "/p", ASX_HOME: "/x", LC_ALL: "C" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GIT_DIR: ".git", ASX_PRESET_DIR: "/p", LC_ALL: "C" });
});

test("presets load from project, $ASX_PRESET_DIR and user directories, validate their shape and list in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "asx-presets-"));
  try {
    const project = join(root, "p"), extra = join(root, "x"), agent = join(root, "a");
    const env = { ASX_PRESET_DIR: extra, PI_CODING_AGENT_DIR: agent };
    const dirs = presetDirectories(project, env);
    assert.deepEqual(dirs, [join(project, ".pi", "presets"), extra, join(agent, "presets")]);
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    await writeFile(join(dirs[0], "review.toml"), 'model = "faux/faux-1"\nthinking = "high"\ntask = "project"\nincludeTools = ["read"]\n');
    await writeFile(join(dirs[1], "review.toml"), 'model = "faux/faux-1"\ntask = "shadowed"\n');
    await writeFile(join(dirs[2], "judge.toml"), 'model = "faux/faux-1"\noutput = "verdict"\ntask = "judge {{ input }}"\n');
    await writeFile(join(dirs[2], "broken.toml"), 'model = "nope"\ntask = "x"\nbogus = 1\n');
    const review = await loadPreset("review", dirs);
    assert.equal(review.task, "project");
    assert.deepEqual(review.includeTools, ["read"]);
    assert.equal((await loadPreset("judge", dirs)).output, "verdict");
    await assert.rejects(loadPreset("missing", dirs), /Preset "missing" not found\. Looked for missing\.toml in/);
    await assert.rejects(loadPreset("../etc", dirs), /Invalid preset name/);
    await assert.rejects(loadPreset("broken", dirs), /not a valid preset:[\s\S]*preset\/model[\s\S]*preset\/bogus|preset: /);
    assert.throws(() => parsePreset("t", "/t.toml", "model = \n"), /invalid_preset|\/t\.toml/);
    const listed = await listPresets(dirs);
    assert.deepEqual(listed.map(entry => [entry.name, entry.source === dirs[0] ? "project" : entry.source === dirs[2] ? "user" : "extra", entry.error === undefined]),
      [["review", "project", true], ["broken", "user", false], ["judge", "user", true]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
