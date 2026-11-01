# asx

Run pi agents from the shell or from Pi: one preset, a one-line expression that composes presets, or a TypeScript workflow. Every run is durable on a detached worker, so it survives the Pi session that started it, and every agent is a real **pi coding-agent session**: pi's tools, your extensions, MCP servers, skills and context files, with a transcript you can open in pi.

```sh
asx git-commit                                             # one preset
asx git-commit --args '{"prompt": "mention the migration"}'
asx '@code-review * [correctness, security, maintainability] -> @synthesizer'
asx 'repeat (@coder) until @judge max 3'
asx plan 'repeat (@a * 2 -> @b) until @judge max 3'        # how it runs; nothing starts
asx status <runId> --verbose                                # every stage, its cost and its pi session file
asx retry <runId>                                          # finished stages replay; unfinished ones run again
asx run review.ts --args '{"path": "src"}'                 # a TypeScript workflow
```

`asx` is the Pi extension (`asx` tool, `/asx` command) and the shell command. It is `@nothumanwork/asx` on npm, formerly `pi-orchestration`.

## Install

Requires Node 22.19 or newer, Git for worktree isolation, Linux or macOS, and a model configured for pi (`pi --model` works, so do asx presets).

```sh
pi install npm:@nothumanwork/asx
```

Pi installs packages without linking their binaries. When a Pi session starts and nothing named `asx` is on your PATH, the extension links the command into `~/.local/bin`, `~/bin` or `~/.pi/agent/bin` (the first that exists and is on PATH) and tells you where. Deleting the link opts out for good. Otherwise `/asx guide` prints the `node …/bin/asx.mjs` command to use. `npm install -g @nothumanwork/asx` also installs `asx`. For Nix, see [nix/README.md](nix/README.md).

From this repository:

```sh
npm ci --ignore-scripts
npm run build --workspace @nothumanwork/asx
pi install ./asx
node asx/bin/asx.mjs --help
```

## Presets

A preset is a TOML file: `<project>/.pi/presets/<name>.toml`, then `$ASX_PRESET_DIR`, then `~/.pi/agent/presets/<name>.toml`. `asx presets` lists them; `examples/presets/` has ready-made ones.

```toml
model = "openai/gpt-6.1-sol"            # provider/model, as pi --model
thinking = "medium"                      # off | minimal | low | medium | high | xhigh | max
instructions = "…"                       # appended to pi's system prompt
includeTools = ["read", "grep", "bash"]  # optional allowlist with pi --tools semantics (patterns, +name/-name)
excludeTools = ["write"]                 # optional denylist
outputFilePath = ".git/ASX_COMMIT_MSG"   # optional: the reply is also written here
output = "text"                          # or "verdict" for judges
retries = 1                              # optional; also timeoutMs, cwd, isolation = "worktree"

task = '''
Staged changes:
{% sh git diff --staged %}
{% if args.prompt %}Also: {{ args.prompt }}{% endif %}
'''
```

`task` is a [LiquidJS](https://liquidjs.com) template. `{% sh <command> %}` runs the command in the preset's directory and inserts its stdout; `{{ "cmd" | sh }}` is the filter form. A failing command fails the stage, so a broken command never reaches the model. Variables:

| Variable | Meaning |
|---|---|
| `args` | `--args` JSON merged under the stage's own `@preset(k=v)` args |
| `cwd`, `env` | working directory and environment |
| `input`, `inputs` | upstream stage outputs: joined with separators, and one per upstream agent |
| `copy.index`, `copy.count`, `copy.variant` | position inside a `* N` or `* [a, b]` fan-out |
| `iteration`, `feedback` | loop counter and the judge's feedback inside `repeat … until` |

The agent is a full pi session created the way `pi` creates its own, in the directory asx was run from: pi's built-in tools, your extensions, MCP servers, skills and context files; pi's system prompt with the preset's `instructions` appended; the model and thinking level from the preset. The transcript is a normal pi session file under `~/.pi/agent/sessions`, shown by `asx status <runId> --verbose` and opened with `pi --session <file>`.

## Expressions

```text
@a -> @b                 pipeline: b receives a's output as {{ input }}
@a * 3                   three copies in parallel, each with {{ copy.index }}; outputs fan in as {{ inputs }}
@a * [security, perf]    copies with {{ copy.variant }}
[@a, @b -> @c]           parallel branches on the same input
(@a -> @b) * 2           grouping
repeat (@a -> @b) until @judge max 3
@a(focus=security, n=2)  stage args, merged over --args
```

Quote expressions in the shell. A bare name is a preset when such a preset exists (`asx git-commit`); `@name` always is. `repeat … until … max N` runs the body, then the judge with the body's output as `input`, until the judge approves; `max` is required. A judge preset has `output = "verdict"`, which appends an instruction to end the reply with `{"approved": true|false, "feedback": "…"}`. A missing verdict counts as a rejection, and the feedback reaches the next iteration as `{{ feedback }}`. A loop that never gets approval fails the run.

`asx plan '<expr>'` prints the tree. `asx run '<expr>' --render` prints every preset's rendered prompt without starting anything. `asx run '<expr>' --bg` returns a run id at once.

An expression runs as one durable workflow (`asx-expression`). Each stage is two journaled steps: the render of its template, then one pi session. Stage keys follow structure: `root/2` is the second pipeline stage, `root/parallel#0/1/1.#2` the second copy of a fan-out in the first stage, `root/1.i2.judge` the judge of the second loop iteration. Templates render where the stage runs, in the submitter's working directory with an allowlisted environment (`PATH`, `HOME`, `GIT_*`, locale), so `{% sh git diff --staged %}` in a git hook sees that repository.

### Example: a three-angle code review

With `code-review.toml` and `synthesizer.toml` from `examples/presets/` in `~/.pi/agent/presets/`:

```sh
asx '@code-review * [correctness, security, maintainability] -> @synthesizer'
```

Three reviewers read the staged diff in parallel, each with its own focus; the synthesizer gets their three reports as `inputs` and writes `code-review.md`. `asx status <runId> --verbose` shows the four stages, their tokens, cost and session files.

## From Pi

Ask the agent, or use the command:

```text
/asx git-commit
/asx '@code-review * 3 -> @synthesizer' --bg
/asx status <runId> --verbose
```

The tool's launch request for an expression is `{"action":"run","expression":"@code-review * 3 -> @synthesizer","args":{…}}`; for a workflow, `{"action":"run","workflow":{"name":"review"},"args":{…}}`. It returns `{runId, status, model}` at once, the originating session gets a message when the run ends, and TUI mode shows a progress widget. `wait: true` returns the outcome instead. `catalog` lists workflows and presets; `guide` teaches both forms.

## Workflows

For control flow that depends on results, human signals, worktrees, compensation or swarms, write a TypeScript workflow in `.pi/workflows/<name>.ts` (`asx init <name>` writes a starter; `asx guide` explains the API). Workflow files are project source: commit them, never add them to `.gitignore`.

```ts
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/asx";

export default defineWorkflow({
  name: "review",
  description: "Review a directory from two perspectives, then judge; agents are full pi sessions.",
  args: Type.Object({ path: Type.String() }),
  budget: { maxAgents: 3, maxCostUsd: 1, maxDurationMs: 120_000 },
  async run(ctx) {
    ctx.phase("Review");
    const notes = await ctx.parallel(
      ["correctness", "maintainability"].map(lens => () =>
        ctx.agent(`Review ${ctx.args.path} for ${lens}. Report concrete evidence.`, { runtime: "pi", tools: ["read", "grep"], label: lens })),
      { failure: "failFast" },
    );
    ctx.phase("Judge");
    return ctx.preset("judge", { inputs: notes.map(String) }); // the judge preset from examples/presets
  },
});
```

Two kinds of agent are available from a workflow:

| | `runtime: "pi"` and `ctx.preset()` | `ctx.agent()` default (`runtime: "durable"`) |
|---|---|---|
| Tools | pi's full toolset, your extensions, MCP servers, skills, context files | `read`, `write`, `edit`, `bash` and the workflow's own durable tools |
| Durability | one journaled step per agent: a completed agent replays, an interrupted one is re-run by `retry` | per tool call: a crash mid-turn resumes at the last committed call |
| Structured output | parse the text (or use a verdict preset) | `schema` with `submit_result` |
| Transcript | pi session file | pi-durable conversation in the worker's store |

`ctx.preset(name, { args, inputs, copy, iteration, feedback, env, presetDirs, label, phase, key })` renders the preset's task (journaled) and runs it as a pi session; it returns the agent's text.

### Every context operation

| Operation | Example | Behavior |
|---|---|---|
| `args` | `ctx.args.path` | Typed launch arguments. |
| `runId`, `cwd`, `depth` | `ctx.log(ctx.runId)` | Run identity, working directory and composition depth. |
| `budget` | `ctx.budget.agents` | Journaled remaining agent and dollar allowance, or `null` when uncapped. |
| `agent` | `await ctx.agent("Inspect src", { tools: ["read"] })` | A fresh agent; text, or schema-validated data (durable runtime). |
| `preset` | `await ctx.preset("review", { inputs })` | A preset's templated task as a pi session; text. |
| `parallel` | `await ctx.parallel([() => ctx.agent("A"), () => ctx.agent("B")])` | Barrier; output positions match input positions. Default failures become `null`. |
| `pipeline` | `await ctx.pipeline(files, inspect, verify)` | Each item advances independently through stages. |
| `step` | `await ctx.step("save", async ({ signal, cwd }) => save(cwd, signal))` | Journaled task for application effects, with optional retries and compensation. |
| `workflow` | `await ctx.workflow("review", { path: "src" })` | Owned child run whose usage counts against ancestor budgets. |
| `signal` | `await ctx.signal("approve", { schema: Type.Boolean() })` | Durable external input; status becomes `waiting_signal`. |
| `sleep` | `await ctx.sleep(5_000)` | Durable deadline that survives process restart. |
| `spawn` | `const watcher = await ctx.spawn({ name: "watcher", initialPrompt: "Inspect tests" })` | Persistent background conversation with send, wait, status and stop. |
| `swarm` | `await ctx.swarm({ workers: 4, queue: files, worker: { prompt: file => "Review " + file } })` | Durable queue processed by reusable worker conversations. |
| `phase`, `log`, `now`, `random` | `ctx.phase("Verify")` | Progress group, journaled message, journaled time and random value. |

Agent options: `model`, `thinkingLevel`, `runtime`, `instructions`, `tools`, `excludeTools`, `cwd`, `isolation`, `budget`, `timeoutMs`, `retries`, `label`, `phase`, `agentType` (a key in the definition's `agents` map), `key`, `schema`. Options merge in this order: worker defaults, definition `defaults`, `agents[agentType]`, call options. An agent without a model uses the run's model: the definition's `defaults.model`, else the launch model (Pi launches use the session's model; shell launches of workflows need `--model`, or `provider/model:high` to set the thinking level too). Presets carry their own model.

Durable agents must finish structured work with a valid `submit_result` call; prose triggers one repair turn. Recipes `dag`, `bestOf` and `untilDry` are exported from `@nothumanwork/asx/recipes`. Effects go in `ctx.step` with a stable key and, when undoable, a `compensate` callback; `revert <runId>` compensates completed steps in reverse. `isolation: "worktree"` gives an agent its own Git worktree and branch `asx/<runId>/<label>`. Signals are delivered with `asx signal <runId> <key> '<json>'`. Workflows can declare extra durable tools with `defineTool` from `@earendil-works/pi-durable`. The nine files in `examples/workflows/` show each pattern; the tests load every one.

## Determinism and durability

`run` is replayed from the beginning after a worker restart. Operations reconstruct against a journal whose keys follow authored structure, never completion order. Within control flow use `ctx.now()`, `ctx.random()` and `ctx.sleep()` rather than `Date.now()`, `Math.random()` or timers, and put I/O inside `ctx.step`; `asx validate` reports violations with line numbers and a launch refuses a workflow with findings. Expressions are deterministic by construction: all I/O happens in render steps and pi sessions.

What the journal guarantees, and what it does not:

- A completed step, agent or stage replays without running again. `retry <runId>` resumes failed work; `--from <stepKey>` invalidates that step and everything after it.
- A step interrupted after it started is not silently re-run by the resumed worker; it fails with `interrupted_step`, and `retry` runs it again. For a pi-session stage that means a fresh session; whatever the interrupted agent already changed on disk is still there.
- Durable-runtime agents resume mid-turn at the last committed tool call. pi-session agents do not: the unit of durability is the stage.
- SQLite commits survive process crashes (WAL, `synchronous=NORMAL`); a power failure may lose the newest ones. Bash subprocesses may outlive a killed worker. Revert is best-effort compensation and cannot undo arbitrary edits.
- A changed workflow file makes a run `outdated`; a changed preset makes the next replay of its stage fail with `journal_mismatch` instead of silently diverging. Budgets stop admission; an in-flight request can overshoot a cost cap.

## Control surface

The shell command and `/asx` share one interface:

```text
asx <preset> [--args JSON]  ·  asx '<expression>' [--args JSON] [--bg] [--render]
asx plan '<expression>'  ·  asx presets [--cwd DIR]  ·  asx guide
asx init <name> [--cwd DIR]  ·  asx catalog [--cwd DIR]  ·  asx validate <name-or-path>
asx run <preset|'<expression>'|path.ts|name> [--args JSON|--args-file FILE] [--cwd DIR]
  [--model PROVIDER/MODEL[:THINKING]] [--thinking LEVEL] [--bg] [--request-id ID]
  [--max-agents N] [--max-cost-usd N] [--max-tokens N] [--max-duration-ms N]
asx status <runId> [--verbose]  ·  asx poll <runId> [--interval 1s] [--until signal|done] [--once]  ·  asx watch <runId>
asx list [--status running,failed] [--all]  ·  asx result|cancel <runId>  ·  asx revert <runId> [--keep-worktrees]
asx retry <runId> [--from KEY] [--allow-changed]  ·  asx signal <runId> <key> '<json>'
asx agents [--run ID]  ·  asx steer <runId> <agent> "message"  ·  asx worker start|stop|status
```

Every command accepts `--home DIR` and `--json`. `run` attaches by default and prints the step tree, then the result; Ctrl-C detaches without cancelling. Run views have the same JSON shape in the CLI and in the tool's `details`: `{runId, workflow, status, model?, summary, error?, failedSteps?, waitingFor?, result?}`, and `status --verbose` returns the full record with every step, its usage and, for pi-session stages, `sessionFile`. Exit codes: 0 success, 1 usage or validation error, 2 failed run, 3 cancelled, 4 worker unavailable. Run statuses: `queued`, `running`, `waiting_signal`, `completed`, `failed`, `cancelled`, `reverted`, `outdated`.

The tool's actions are `catalog`, `guide`, `validate`, `run` (with `expression` or `workflow`), `status`, `result`, `list`, `cancel`, `retry`, `revert`, `signal`, `steer` and `agents`.

## Worker, data and configuration

Default home `~/.pi/agent/asx` (respecting `PI_CODING_AGENT_DIR`), override with `ASX_HOME` or `--home`. It holds `runs.sqlite`, the owner lock, `worker.sock`, `worker.log` and `worktrees/`; mode 0700. The worker starts lazily on the first command that needs it, runs `dist/worker.js` with plain Node and inherits the starting process's environment; stop and restart it after changing provider configuration. After an upgrade, the next command replaces an idle worker; a busy one keeps serving and commands warn until it is stopped.

Models and credentials come from pi's own configuration (`~/.pi/agent/auth.json`, `models.json`, the pi.dev catalog), through pi's `ModelRuntime`: whatever works with `pi --model` works in a preset. Session-only providers are not inherited.

| Environment variable | Default / purpose |
|---|---|
| `ASX_HOME` | Home described above. |
| `ASX_PRESET_DIR` | An extra preset directory, searched after the project's `.pi/presets`. |
| `ASX_NODE` | `node`; absolute Node executable for detached startup when needed. |
| `ASX_MAX_CONCURRENT_AGENTS` | `min(availableParallelism(), 8)` across the whole worker, pi sessions included. |
| `ASX_MAX_DEPTH` | `1`: root → child workflow. |
| `ASX_RETRY_BACKOFF_MS` | `1000`. |
| `ASX_STRUCTURED_RETRIES` | `1` repair turn for durable agents. |
| `ASX_AGENT_RETRIES` | `0` automatic additional agent attempts. |
| `ASX_AGENT_TIMEOUT_MS` | `600000`. |

Only a person or the root Pi session may launch runs. Inner agents carry `ASX_RUN_ID` and `ASX_STEP` in their environment, and the worker sets them for the pi sessions it hosts; the CLI, the tool and the command refuse such launches with `not_from_root`. Compose with `ctx.workflow()` or `ctx.preset()` instead.

### Troubleshooting

| Symptom | Check |
|---|---|
| `asx: command not found` | Start a Pi session with the package installed so it links the command, or use the `node …/bin/asx.mjs` command from `/asx guide`. |
| `preset_not_found` | `asx presets` shows what is visible from this directory and where it looked. |
| `invalid_preset` | The message names the field; `asx guide` shows a complete preset. |
| A stage failed in its `render` step | A `{% sh %}` command exited non-zero; the message carries its stderr. Append `\|\| true` where failure is expected. |
| `journal_mismatch` on retry | The preset or workflow changed under a run. Restore it, or `retry --allow-changed` for a clean attempt. |
| Worker will not start / exit 4 | Read `<home>/worker.log`; verify Node ≥ 22.19 and a short, writable home path. |
| Unknown model | Use the exact `provider/model` pi accepts; check `pi --model`. |
| `not_from_root` | An agent tried to launch a run. Compose with `ctx.workflow()` or `ctx.preset()`. |

## Development

```sh
npm run check --workspace @nothumanwork/asx
npm test --workspace @nothumanwork/asx      # builds, then runs test/*.test.ts with a scripted model; no credentials needed
```

| File | Covers |
|---|---|
| `test/dsl.test.ts` | Expression parser, interpreter, verdicts, templates and preset loading. |
| `test/pi.test.ts` | pi-runtime agents and presets through the engine with a fake session runner: journaled renders, options, usage, session files, expression runs, stage failure and retry. |
| `test/engine.test.ts` | Control flow, steps, retries, compensation, signals, child runs, budgets, structured output, worktrees, background agents, swarms. |
| `test/process.test.ts` | The compiled CLI and detached worker: exit codes, signals, cancel and SIGKILL recovery. |
| `test/extension.test.ts` | The Pi tool and `/asx` against a fake host. |
| `test/unit.test.ts`, `test/package.test.ts`, `test/nix-lock.test.ts` | Lint, presentation, the guide, PATH linking, examples, packaging and the Nix lock. |

The default pi-session runner (`src/engine/pi-session.ts`) is exercised by live runs, not by the test suite, since it needs a model. `AGENTS.md` records lessons from building this package.
