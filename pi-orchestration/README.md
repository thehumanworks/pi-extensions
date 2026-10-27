# pi-orchestration

Durable TypeScript workflows for Pi. A workflow controls branching, loops and dependencies in code and delegates model work to fresh agents. One detached worker runs the same workflows for Pi's `workflow` tool, the `/workflow` command and the `pi-workflow` CLI.

The package implements parallel work, pipelines, child workflows, structured results, durable signals and sleep, persistent background agents, shared-queue swarms, worktree isolation, retries and compensating steps. It uses `@earendil-works/pi-durable@1.4.0` for tasks, ownership, conversations and persistence.

**Implementation status:** deterministic engine, process, integration and example tests are included. The requested real-model evaluation has not run because this implementation environment has no configured provider credentials. No model-quality score or tuned-default claim is implied. See [Evaluation](#evaluation) for the remaining acceptance work and reproduction commands. This package has not been published as part of this work.

## Install and first run

Requires Node **22.19 or newer**, Git for worktree isolation, and Linux or macOS. Use WSL on Windows. Configure a model through Pi's normal credentials and `models.json`; the worker uses Pi's `ModelRuntime`. A session-only provider is not available to it.

From this repository:

```sh
npm ci --ignore-scripts
npm run build --workspace @nothumanwork/pi-orchestration
pi -e ./pi-orchestration/index.ts
node pi-orchestration/bin/pi-workflow.mjs --help
```

After publication, the standard Pi installation command will be:

```sh
pi install npm:@nothumanwork/pi-orchestration
```

Pi package installation does not put package binaries on your shell's PATH. Use the checked-in binary above, an alias to its absolute path, or `npm install -g @nothumanwork/pi-orchestration` after publication. `npm pack --workspace @nothumanwork/pi-orchestration` also produces an installable local tarball.

Create `.pi/workflows/review.ts` in the project you want agents to inspect:

```ts
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "review",
  description: "Review a directory from correctness and maintainability perspectives.",
  args: Type.Object({ path: Type.String() }),
  budget: { maxAgents: 3, maxCostUsd: 1, maxDurationMs: 120_000 },
  async run(ctx) {
    ctx.phase("Review");
    const notes = await ctx.parallel(
      ["correctness", "maintainability"].map(lens => () =>
        ctx.agent(`Review ${ctx.args.path} for ${lens}. Report concrete evidence.`, {
          label: lens,
          tools: ["read"],
        }),
      ),
    );
    ctx.phase("Synthesize");
    return ctx.agent(`Summarize these reviews, preserving uncertainty:\n${JSON.stringify(notes)}`, {
      tools: [],
    });
  },
});
```

Inside Pi, ask the agent to inspect the workflow catalog and launch `review` with `{"path":"src"}`, or run:

```text
/workflow catalog
/workflow run review --args '{"path":"src"}' --bg
/workflow status <runId> --verbose
```

The tool's launch request is:

```json
{"action":"run","workflow":{"name":"review"},"args":{"path":"src"}}
```

It returns `{"runId":"…","status":"queued"}` immediately. The originating Pi session receives a completion message; the extension reattaches after a session restart. TUI mode also displays a one-line progress widget. The worker continues when Pi closes.

From a shell, explicitly enable unattended execution and select an available model:

```sh
export PI_WORKFLOW_ALLOW_UNATTENDED=1
node pi-orchestration/bin/pi-workflow.mjs run ./.pi/workflows/review.ts \
  --cwd ./project --args '{"path":"src"}' --model openai/gpt-6.1-sol --json
```

CLI `run` waits by default. Add `--bg` for an immediate launch reply. Ctrl-C detaches the client and leaves the run active; use `cancel` to stop it. The same commands work through `pi -p "/workflow …"` with the extension loaded and the unattended flag set.

## Authoring workflows

A workflow is a trusted TypeScript module with a default `defineWorkflow({...})` export. Its name must be kebab-case. `args` is a TypeBox schema, checked before a run is admitted; omitting it means an empty argument object. `run(ctx)` returns a JSON-serializable result.

Files are resolved by explicit path, then project `.pi/workflows/`, then user `~/.pi/agent/workflows/`. `PI_CODING_AGENT_DIR` changes the user location. Catalog lookup also recognizes a definition's declared name in files such as `01-leader-worker.ts`. Project definitions take precedence over user definitions with the same name. Modules are freshly loaded after edits. The definition file's SHA-256 hash identifies the code used for a run; imported files are not snapshotted.

The loader resolves this package, its recipes, TypeBox and the durable tool API from the installation, so a project workflow does not need a second copy just to import them. Other project dependencies follow normal Node module resolution.

### Every context operation

| Operation | Example | Behavior |
|---|---|---|
| `args` | `ctx.args.path` | Typed launch arguments. |
| `runId`, `cwd`, `depth` | `ctx.log(ctx.runId)` | Run identity, working directory and composition depth. |
| `budget` | `ctx.budget.agents` | Journaled remaining agent and dollar allowance, or `null` when uncapped. Replay returns the original read; admission separately checks current usage. |
| `agent` | `await ctx.agent("Inspect src", { tools: ["read"] })` | Fresh durable conversation; returns text or schema-validated data. |
| `parallel` | `await ctx.parallel([() => ctx.agent("A"), () => ctx.agent("B")])` | Barrier; output positions match input positions. Default failures become `null`. |
| `pipeline` | `await ctx.pipeline(files, inspect, verify)` | Each item advances independently through stages; no stage-wide barrier. |
| `step` | `await ctx.step("save", async ({ signal }) => save(signal))` | Journaled, owned task for application effects, with optional retries and compensation. |
| `workflow` | `await ctx.workflow("review", { path: "src" })` | Owned child run whose usage counts against ancestor budgets. |
| `signal` | `await ctx.signal("approve", { schema: Type.Boolean() })` | Durable external input; status becomes `waiting_signal`. |
| `sleep` | `await ctx.sleep(5_000)` | Durable deadline that survives process restart. |
| `spawn` | `const watcher = await ctx.spawn({ name: "watcher", initialPrompt: "Inspect tests" })` | Persistent background conversation with send, wait, status and stop operations. |
| `swarm` | `await ctx.swarm({ workers: 4, queue: files, worker: { prompt: file => "Review " + file } })` | Durable queue processed by reusable worker conversations. |
| `phase` | `ctx.phase("Verify")` | Progress group for subsequent operations. |
| `log` | `ctx.log("Found candidates", { count: 3 })` | Journaled progress message. |
| `now` | `const started = ctx.now()` | Journaled timestamp; replay returns the same value. |
| `random` | `const sample = ctx.random()` | Journaled random value; replay returns the same value. |

### Agents and structured output

Agents receive `read`, `write`, `edit` and `bash` by default, rooted in the configured cwd. They do **not** receive the launching Pi session's extensions, MCP tools, skills or permission hooks. Restrict `tools` when the task only needs reading. Full Node workflow code and Bash remain trusted host code, so this is not a security sandbox.

```ts
const Result = Type.Object({
  findings: Type.Array(Type.Object({ file: Type.String(), detail: Type.String() })),
});
const result = await ctx.agent("Inspect the changed files; report concrete defects.", {
  schema: Result,
  tools: ["read"],
  label: "reviewer",
});
// result.findings is inferred from Result.
```

Structured agents must finish with a valid `submit_result` tool call. Prose alone triggers one repair turn by default. Exhausting repair attempts produces `invalid_structured_output` with the step key. This repair happens in the same conversation; ordinary agent retry is a separate policy.

| Agent option | Meaning |
|---|---|
| `model` | `"provider/model"` or `{ provider, modelId }`; resolved in the worker. |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, subject to provider support. |
| `instructions` | Additional system instructions for that agent. |
| `tools` | Explicit tool-name allowlist, including `[]`, or `{ remove: ["write", "edit"] }` against the four defaults. |
| `cwd` | Working directory, resolved relative to the run cwd. |
| `isolation` | `"none"` or `"worktree"`. |
| `budget` | Per-agent `maxCostUsd` and/or `maxTurns`. |
| `timeoutMs` | Durable absolute timeout for an attempt; default 10 minutes. |
| `retries` | Additional attempts after a failed agent; default zero. |
| `label`, `phase` | Human-readable progress labels; unique labels also name isolated worktrees. |
| `agentType` | Key in the definition's `agents` map. |
| `key` | Explicit step key when a stable authored identity is needed. |
| `schema` | TypeBox result schema; controls the return type. |

Options merge in this order: worker defaults, definition `defaults`, named `agents[agentType]`, call options. The selected model then falls back to the model captured at launch. Pi launches capture the session model; shell launches should pass `--model` or specify `defaults.model`. There is no silent model substitution.

### Parallel, pipelines and recipes

`parallel` starts indexed branches immediately. The worker-wide semaphore limits actual agent conversations, including children, background work and swarms. Use `{ concurrency: 3 }` to additionally limit active branch callbacks. Do not use a local branch limit around mutually dependent thunks; use the DAG recipe instead.

Choose `{ failure: "failFast" }` to abort in-flight siblings when one fails, or `{ failure: "allSettled" }` for typed `{ status: "fulfilled", value }` / `{ status: "rejected", reason }` results. The default returns `null` in failed slots and allows siblings to complete.

Pipeline stage functions receive `(previousResult, originalItem, index)`. The first stage receives the original item as its previous result. Stages for one item are serial; different items progress independently. An item that fails contributes `null`.

Recipes are plain code using the public context, exported separately:

```ts
import { dag, bestOf, untilDry } from "@nothumanwork/pi-orchestration/recipes";

const report = await dag(ctx, {
  outline: { run: () => ctx.agent("Outline the report") },
  final: { dependsOn: ["outline"], run: deps => ctx.agent(`Write from ${deps.outline}`) },
});

const choice = await bestOf(ctx, 3, i => ctx.agent(`Propose approach ${i}`), {
  score: text => text.length, // Replace with a task-specific deterministic score.
});

const findings = await untilDry(ctx, async (_seen, round) => {
  const value = await ctx.agent(`Find new issues, round ${round}`, { schema: Result });
  return value.findings;
}, { keyOf: item => `${item.file}:${item.detail}`, consecutiveEmpty: 2, maxRounds: 8 });
```

`dag` checks missing dependencies and cycles before running nodes. Failed dependencies make their dependents `null`. `bestOf` preserves candidate order and returns `{ winner, winnerIndex, candidates }`; alternatively supply `judge(candidates)` returning an index. A scorer needs no extra judge conversation. `untilDry` deduplicates against every returned key seen across rounds, not just the latest batch. Preserve rejected candidate keys in your own round logic if verification filters candidates before returning them.

### Effects, retries and compensation

Wrap filesystem, network and subprocess effects in `ctx.step`. Keep the key stable and return the information needed to compensate:

```ts
const savedPath = await ctx.step("save-report", async ({ signal }) => {
  await writeReport("report.json", result, signal);
  return "report.json";
}, {
  retries: 1,
  compensate: async path => removeReport(path),
});
```

A committed result is replayed without invoking the callback again. A process can still die after an external effect but before its durable result commit. Use an external idempotency key or inspect the destination to make such an effect safe to retry. Marking an application callback as a step does not turn an arbitrary service into an exactly-once service.

`retry <runId>` resumes failed work while replaying committed earlier results. `--from <stepKey>` invalidates that step and its later journal suffix; inspect `status --verbose` for exact keys. Changed definition hashes are rejected unless `--allow-changed` explicitly starts a clean journal attempt. That option can repeat effects and should be used only after reviewing the previous attempt.

Retrying from inside a swarm restarts that swarm's full shared queue and conversation generation; its queue cannot be safely split into an arbitrary partial retry. Invalidated detached agents are stopped before replacement handles reuse their names. Changed structured-result schemas receive fresh tool registrations.

`revert` reconstructs recorded compensation callbacks, cancels active owned work, compensates completed steps in reverse order and removes owned worktrees. Completed compensations are remembered. A second successful revert is a no-op. An interrupted or failed compensation is reported for manual recovery; the engine does not guess whether an external undo happened. Changes to ordinary files and external services are not automatically undone.

### Worktrees

Use `isolation: "worktree"` for independent writers:

```ts
await ctx.agent("Implement approach A and commit the result.", {
  label: "attempt-a",
  isolation: "worktree",
});
```

For a simple valid label, the branch is `orch/<runId>/attempt-a` and the checkout is `<home>/worktrees/<runId>/attempt-a`. Labels needing sanitization receive a hash suffix to avoid collisions; the run record contains the exact path and branch. Labels must be unique across distinct isolated steps. Restart reuses the registered branch and worktree without discarding its files.

Worktree results are not merged automatically. Have the workflow explicitly inspect and apply a chosen branch. Revert removes only registered, owned worktrees; Git branches remain for review. The leader-worker and best-of examples return their branch/patch results without modifying the original checkout.

### Signals, sleep and composition

```ts
const approval = await ctx.signal("approve-release", {
  schema: Type.Object({ approved: Type.Boolean(), note: Type.String() }),
  timeoutMs: 86_400_000,
  prompt: "Approve the prepared release?",
});
if (!approval.approved) return { released: false };
await ctx.sleep(1_000);
return ctx.workflow("verify-release", { version: ctx.args.version });
```

Send the value with `pi-workflow signal <runId> approve-release '{"approved":true,"note":"Reviewed"}'`. The value is schema-checked before delivery. An expired signal fails with `signal_timeout`. Deadlines are persisted; a restarted worker waits only for the remaining time.

Child workflows have their own run records and ownership, use the shared concurrency cap, and charge agents/tokens/cost to ancestors. `list` shows roots; `list --all` includes children for a nested view. Cancellation and revert cascade through ownership. The default maximum depth is one: root → child. Set `PI_WORKFLOW_MAX_DEPTH=2` before worker startup to allow another authored level.

Only a person or the root Pi session may launch a workflow. Inner agents must never call the CLI or Pi to create runs. Their execution environments carry the run/step markers and omit the unattended flag; both entry points refuse those launches with `not_from_root`. Worktree-root launches are also refused by the worker. Compose in TypeScript with `ctx.workflow()` so budgets and cancellation remain accountable. These controls prevent accidental recursion; trusted same-user code can bypass environment policy and is not treated as hostile sandboxed code.

### Background agents and swarms

```ts
const watcher = await ctx.spawn({ name: "tests", initialPrompt: "Inspect the current test suite." });
await ctx.parallel([() => ctx.agent("Implement the feature"), () => ctx.agent("Review compatibility")]);
await watcher.send("Recheck after the changes.", { whenBusy: "followUp" });
ctx.log(await watcher.wait({ timeoutMs: 60_000 }));
await watcher.stop();
```

Background handles refer to persistent conversations. `status()` reports `idle`, `busy` or `stopped`; `send` supports `steer` and `followUp`. The control surface exposes `agents --run <runId>` and `steer <runId> <name> "message"`. Agent records also report `active` to distinguish admitted work from messages queued behind the global concurrency cap. Non-detached agents stop at run end. `detach: true` explicitly lets an agent remain available beyond normal completion; cancellation/revert still provide cleanup. Usage is retained with the originating run.

```ts
const migrated = await ctx.swarm({
  workers: 4,
  queue: { initial: ["module-a", "module-b"], allowPush: true },
  worker: {
    prompt: (item, blackboard) => `Migrate ${item}. Shared conventions:\n${blackboard}`,
    instructions: "Record conventions with blackboard. Add discovered modules with queue_push.",
  },
  until: state => state.processed >= 100,
});
```

Swarm workers reuse conversations across durable queue items. The `blackboard` tool reads/appends shared notes; `queue_push` adds work only when `allowPush` is enabled. Canonically equal JSON items are deduplicated. The result is `{ results, blackboard, processed }`. `until` is a deterministic predicate evaluated on committed progress; already claimed work may finish before the swarm stops. Claims and results survive a worker restart. “Exactly once” applies to committed queue results and deduplicated tool receipts, not arbitrary external effects performed while processing an item.

### Extra durable tools

Declare custom tools explicitly; they are not copied from the Pi session:

```ts
import { defineTool } from "@earendil-works/pi-durable";

const normalizeIdentifier = defineTool({
  name: "normalize_identifier",
  description: "Normalize a proposed identifier.",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  execute: async ({ text }) => ({ output: [{ type: "text", text: text.trim().toLowerCase() }] }),
});

export default defineWorkflow({
  name: "normalize",
  tools: [normalizeIdentifier],
  async run(ctx) {
    return ctx.agent("Normalize ' Example '.", { tools: ["normalize_identifier"] });
  },
});
```

Use pi-durable's tool replay contract accurately. `replay: "safe"` is appropriate above because the tool is pure; it is not a blanket choice for external side effects.

## Determinism and durability

`run` is replayed from the beginning after a worker restart. Its operations reconstruct against a durable journal whose keys follow authored structure, such as `root/parallel#0/1/agent#0`. Branch completion order never chooses keys. Operation kind and input fingerprints must match; incompatible replay fails with `journal_mismatch` and the key.

Within workflow control flow, `Date.now()`, argument-free `new Date()`, `Date()`, `Math.random()` and raw timers are forbidden. Use `ctx.now()`, `ctx.random()` and `ctx.sleep()`. Runtime guards cover workflow execution and imported Node timer APIs; `validate` also parses TypeScript and reports direct calls with line numbers, while allowing effects inside step and compensation callbacks. Lint is advisory for indirect/dynamic code; the runtime is the final guard for the covered APIs. Neither mechanism proves arbitrary JavaScript deterministic. Avoid changing external inputs or imported code beneath an in-flight workflow.

The engine atomically records conversation identity with its step and uses stable submission IDs. A completed step/result is reused. A pending conversation is reattached, including after SIGKILL. A single SQLite owner protects each home. Child tasks/conversations provide cancellation ordering; cancellation settles owned work before the run is marked cancelled. Large results are stored separately and referenced by `resultRef`; compact status directs callers to `result` for the full value.

The guarantees have practical limits:

- Completed journal commits survive process crashes. SQLite uses the substrate's WAL and `synchronous=NORMAL`; a machine/power failure may lose recent commits that a process crash would retain.
- A remote request may already have completed when the process dies. External systems need their own idempotency/reconciliation strategy. Unsafe interrupted Bash tools are not blindly repeated by the durable tool layer.
- Bash subprocesses may outlive a killed worker. Graceful cancellation is more controlled than SIGKILL.
- Revert is best-effort compensation. It cannot infer or undo arbitrary edits, remote actions or deleted external state.
- Definition files and imported code must remain available. Changed definition hashes become `outdated`; imported modules are not content-addressed snapshots.
- `signal` and `sleep` hold one script invocation while waiting. They persist deadlines/state, but this version does not implement a separate suspended-invocation scheduler.
- Agent-count limits stop admissions at the configured count; cost/token limits stop further work after recorded usage exceeds the cap. In-flight provider requests can overshoot a cost/token cap; a local counter cannot impose a provider billing limit. Reported cost depends on provider pricing metadata.

## Control surface

All tool actions use the same protocol as the CLI: `run`, `status`, `list`, `result`, `cancel`, `retry`, `revert`, `signal`, `steer`, `agents`, `catalog`, `validate`. `run` accepts `wait: true` with `waitTimeoutMs` up to 600,000; timeout returns the current run state instead of cancelling it. Session tool calls use a stable session/tool-call launch request ID.

```text
pi-workflow run <path.ts|name> [--args JSON|--args-file FILE] [--cwd DIR]
  [--model PROVIDER/MODEL] [--bg] [--request-id ID]
  [--max-agents N] [--max-cost-usd N] [--max-tokens N] [--max-duration-ms N]
pi-workflow status <runId> [--verbose]
pi-workflow poll <runId> [--interval 5s] [--until done|signal] [--once]
pi-workflow watch <runId> [--interval 1s]
pi-workflow list [--status running,failed] [--all]
pi-workflow result|cancel|revert <runId>
pi-workflow revert <runId> --keep-worktrees
pi-workflow retry <runId> [--from KEY] [--allow-changed]
pi-workflow signal <runId> <key> '<json>'
pi-workflow agents [--run ID]
pi-workflow steer <runId> <agent> "message"
pi-workflow catalog [--cwd DIR]
pi-workflow validate <name-or-path> [--cwd DIR]
pi-workflow worker start|stop|status
```

Every command accepts `--home DIR` and `--json`. Single actions emit one JSON document on stdout; `poll` and `watch` emit NDJSON. Progress/errors intended for humans stay off JSON stdout. Socket envelopes are `{ ok: true, data }` / `{ ok: false, error }`; CLI JSON unwraps successful data and prints `{ error: { code, message } }` for errors. The result action returns the complete workflow result directly.

| Exit | Meaning |
|---|---|
| `0` | Successful command/completed run, or an intentional foreground detach. |
| `1` | Usage or validation error. |
| `2` | Failed workflow or refused operation. |
| `3` | Cancelled foreground run/poll. |
| `4` | Worker unavailable. |

Run statuses are `queued`, `running`, `waiting_signal`, `completed`, `failed`, `cancelled`, `reverted`, and `outdated`. A parked durable task is additionally marked `parked`; inspect its error and retry after resolving the cause. `status --verbose` includes phases, steps, attempts, usage, elapsed information, children and worktrees. `watch` builds its display from status alone.

## Worker, data and configuration

Default home: `~/.pi/agent/workflow-runs`, respecting `PI_CODING_AGENT_DIR`; override with `PI_WORKFLOW_HOME` or `--home`. It contains `runs.sqlite` and SQLite sidecars, the exclusive owner-lock database, `worker.sock`, `worker.log`, and `worktrees/`. The home is mode 0700 and the Unix socket mode 0600. Inputs, tool outputs and transcripts may contain project-sensitive data. Authentication is resolved from Pi's configuration/environment rather than copied into a separate orchestration credential store.

The worker starts lazily on the first action that needs it, runs compiled `dist/worker.js` with plain Node, and inherits the environment of the process that started it. Existing workers keep that environment; stop/restart after changing provider configuration or tuning settings. `worker stop` gracefully closes persistence without treating runs as cancelled. The next start replays unfinished runs. A second worker for the same home exits successfully without taking ownership.

| Environment variable | Default / purpose |
|---|---|
| `PI_WORKFLOW_HOME` | Home described above. |
| `PI_WORKFLOW_ALLOW_UNATTENDED` | Must equal `1` for headless launch; read/status/cancel do not require it. |
| `PI_WORKFLOW_NODE` | `node`; absolute Node executable for detached startup when needed. |
| `PI_WORKFLOW_MAX_CONCURRENT_AGENTS` | `min(availableParallelism(), 8)` across the whole worker. |
| `PI_WORKFLOW_MAX_DEPTH` | `1`. |
| `PI_WORKFLOW_RETRY_BACKOFF_MS` | `1000`, used for durable retry backoff. |
| `PI_WORKFLOW_STRUCTURED_RETRIES` | `1` repair turn. |
| `PI_WORKFLOW_AGENT_RETRIES` | `0` automatic additional agent attempts. |
| `PI_WORKFLOW_AGENT_TIMEOUT_MS` | `600000`. |

These are conservative implementation defaults, not values selected by completed live-model rounds. Per-run budgets combine definition limits with explicit launch overrides. Set the same values in evaluation configs when comparing candidates.

No OS service is installed. A user-managed systemd/launchd service can supervise `node /absolute/path/pi-orchestration/dist/worker.js` with a fixed `PI_WORKFLOW_HOME`, the intended Pi configuration and a restart policy. Use one service per home. Keep the source/package version and model environment consistent across restarts.

### Troubleshooting

| Symptom | Check |
|---|---|
| Worker will not start / exit 4 | Read `<home>/worker.log`; verify Node >=22.19, writable home, and a short Unix socket path. |
| Unknown/no model | Use an exact configured provider/model ID. Pass `--model` in CLI launches or set workflow defaults. Session-only providers are not inherited. |
| Headless launch refused | Set `PI_WORKFLOW_ALLOW_UNATTENDED=1` in the root caller environment after reviewing the workflow. |
| `not_from_root` | Move composition into `ctx.workflow()`. Do not recursively launch through an inner agent's shell. |
| `outdated` / hash mismatch | Restore the original file to finish the run, or inspect state before `retry --allow-changed`. |
| `journal_mismatch` | Inspect the named key and changed control flow, prompts or options; do not reuse a key for different operations. |
| `invalid_structured_output` | Inspect the failed step; simplify the schema/prompt or deliberately change repair settings. |
| `signal_timeout` | Check the signal key, run ID and deadline; validate the JSON shape before delivery. |
| Worktree conflict | Use unique labels; inspect registered worktree/branch ownership before removing anything manually. |
| Socket request timed out | The worker may still have admitted the action. Inspect status/list and reuse the same launch request ID instead of creating a duplicate. |

## Relation to Claude Code Workflows

The authoring shape follows the [official dynamic-workflows cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows). The attached brief's comparison is a design reference, not a promise of compatibility with an evolving research preview.

| Reference concept | This package |
|---|---|
| Workflow tool / workflows view | `workflow` tool, `/workflow`, status tree and TUI widget. |
| Plain script owns control flow; fresh agents do model work | Typed `defineWorkflow`, deterministic `run(ctx)`, fresh `ctx.agent` conversations. |
| `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, `budget` | Corresponding context methods/properties. |
| JSON Schema output | TypeBox schema with `Static` result inference and `submit_result`. |
| Named agent configuration | Definition `agents` map and `agentType`. |
| Worktree isolation | Explicit `isolation: "worktree"`, owned paths and deterministic branch names. |
| Saved workflow scripts | Project/user `.pi/workflows/*.ts`. |
| Journaled background execution | Detached pi-durable worker plus retry-from, compensation, signal, sleep, spawn and swarm. |
| Restricted script environment in the brief | Trusted TypeScript/Node module with imports and host permissions; a deliberate divergence. |

## Examples

All nine supplied workflows are adapted under `examples/workflows/` and executed by `test/examples.test.ts` with real pi-durable conversations and the faux provider:

| File | Pattern |
|---|---|
| `01-leader-worker.ts` | Plan, independent worktree workers, synthesis. |
| `02-dag.ts` | Dependency-driven report. |
| `03-parallel-best-of-n.ts` | Independent attempts and one judge. |
| `04-pipeline.ts` | Per-file audit and verification pipeline. |
| `05-swarm.ts` | Shared migration queue and blackboard. |
| `06-background-agents.ts` | Test watcher across parallel feature work. |
| `07-loop-until-dry-verify.ts` | Diverse finding and verification rounds. |
| `08-human-gate.ts` | Approval, Git tag compensation and **publish dry-run only**. |
| `09-composition.ts` | Feature work composed with bug hunt and gated release dry-run. |

The composition example verifies the current checkout; isolated worker branches must be reviewed and merged explicitly before using it for a real release. None of these examples publishes a package.

## Evaluation

The unpublished `eval/` harness provides deterministic dependency-free scenario fixtures, T1 authored workflows, T2 fresh-agent sessions, T3 review tooling, seeded chaos configurations, saved artifacts, reports and offline regrading. The deterministic acceptance tests also exercise real sockets, compiled CLI/Pi print commands, SQLite reopen and SIGKILL recovery; a faux provider controls model responses without provider spend.

| Scenario | Tasks | What deterministic grading checks |
|---|---|---|
| `ledger-cli` | T-A, T-B, T-C | Repair, defect discovery and review; concrete reproductions for planted rounding/date/CSV defects. |
| `tasks-api` | T-D, T-E, T-F | API work with independent attempts, verification and dependency-aware execution. |
| `mono-lite` | T-G, T-H | Multi-module migration and background-agent coordination. |
| `release-gate` | T-I, T-J | Human gate, composition, release artifacts and compensation. |

Fixtures are seeded and byte-checked. Graders reject protected-file edits and execute behavioral checks instead of rewarding defect names. Provider preflight records available model IDs without printing credentials. T2 sessions exclude project instructions, context files, other skills/extensions and this implementation's notes; the fresh author receives the installed public surface and package README.

### Measured results

| Required live evaluation | Runs completed | Mean ± SE | Cost / wall time | Status |
|---|---:|---|---|---|
| S0–S6 cheap-model T1/T2 rounds | 0 | Not measured | Not measured | Blocked: provider credentials unavailable. |
| Final: all scenarios × both cheap outer models × 3 repeats | 0 | Not measured | Not measured | Pending model access. |
| Stronger-model confirmation | 0 | Not measured | Not measured | Pending model access. |
| Fresh-model T3 review | 0 | Not measured | Not measured | Pending model access. |
| Live-model runs of all nine examples | 0 | Not measured | Not measured | Pending model access. |

`eval/results/hill-climb.json` contains no invented rounds or keep/revert decisions. `model-preflight.json` records the missing prerequisite; deterministic checkpoints and test output are separate evidence. Consequently the brief's live-evaluation acceptance requirements remain incomplete, and there are no observed T2 failure frequencies to report. No default was presented as model-tuned.

Observed deterministic development findings changed implementation: conversations/extensions must be reconstructed before resume; live agents must reserve concurrency slots on restart; structural scopes must follow input order; pipeline items must advance without a barrier; completed parallel branches must be traversed during compensation reconstruction; failed attempts must still charge usage; Pi print commands need explicit output handling; and one client's cancellation must not abort another client's worker startup. Tests preserve these cases. These are engineering corrections, not measured model-quality improvements.

Reproduce from this package directory:

```sh
npm test
node --experimental-strip-types --test eval/test/*.test.mjs
node --experimental-strip-types eval/engine.mts --preflight
node --experimental-strip-types eval/engine.mts --dry-run
node --experimental-strip-types eval/engine.mts \
  --config eval/configs/s0.json --round s0-baseline \
  --model openai/gpt-6.1-sol --repeats 3 --max-cost-usd 4.5
node eval/report.mjs eval/results/hill-climb.json --round s0-baseline
node --experimental-strip-types eval/regrade.mjs eval/results/hill-climb.json --round s0-baseline
```

See [eval/README.md](eval/README.md) for T2, T3, chaos, final and confirmation commands and current model prerequisites. Start with the S0 baseline after authentication is configured, then evaluate one change at a time and retain all failed/capped runs. Prioritize failures by the recorded taxonomy: selection, authoring, launch, async handling, aggregation, replay, output and task quality. These are proposed next rounds, not observed failure rankings.

## Design decisions

- `RunRecord.id` is canonical; launch replies use `runId`. `parallel({failure:"allSettled"})` has a discriminated return type rather than an inaccurate nullable-success type.
- One worker, SQLite store and control protocol serve every entry point. No sibling workspace imports are used.
- `jiti` handles fresh TypeScript module loading. `@babel/parser` handles deterministic-call linting so comments, strings and valid step callbacks are not rejected by a text search.
- Worker-only `pi-workflow-runtime` is pinned to Pi 1.4.0 for standalone auth/model resolution. Host-facing Pi packages and TypeBox remain peers; durable/chord are pinned runtime dependencies.
- Installed 1.4.0 declarations govern the implementation. The brief's historical upstream example numbers and `runtime.sleep` reference differ from the installed API; notes record the adapted ownership and timer APIs.
- The architecture's held-wait design takes precedence over the prompt's older `SuspendRun` mention. Restart replays to a stored signal/deadline.
- Worktree branch selection and merging remain explicit. The release example performs a dry run to make its demonstration safe and reviewable.
- The research evaluation infrastructure is implemented, but credentials prevented live hill-climbing. No synthetic score substitutes for the required model rounds.

### Deliberately not built

| Feature | Reason | Evidence that would justify it |
|---|---|---|
| Streaming watch/agent output over the socket | Polling supplies the progress tree with a simpler protocol. | A reviewer/user needs live agent text. |
| Full-screen workflow panel | Widget and text tree expose current state. | T2/T3 finds necessary information hard to obtain. |
| Pause/resume controls | Cancel plus retry-from covers stop-and-reconsider. | A recorded use case needs scheduler-level pause. |
| DAG/best-of/until-dry engine primitives | They are composable public recipes. | Keep them as recipes. |
| Per-launch depth dials or nested shell launch tracking | Root-only launching and authored composition bound ownership. | No planned addition. |
| `agentWithMeta` | Metadata is in the run record; worktrees have recorded deterministic names. | No planned addition. |
| Full Pi session driver per step | It would add a second execution/durability model. | Users require session skills/MCP beyond explicit durable tools. |
| Attachments/manual version/static phases/per-run concurrency/onRevert | Existing args, file hash, phases, shared cap and compensations cover these needs. | No planned addition. |
| Suspended script invocations for long waits | A held promise is sufficient for current scope. | Many days-long waits show memory/restart-limit pressure. |

## Development

From the repository root:

```sh
npm run check --workspace @nothumanwork/pi-orchestration
npm test --workspace @nothumanwork/pi-orchestration
npm run pack:check
npm run test:scripts
npm run publish:package -- pi-orchestration --dry-run
```

Build output in `dist/` is checked in. The npm payload contains the thin Pi entry, source, compiled JavaScript/declarations, binary, examples and this README. Tests, evaluation fixtures/results, verification logs, `NOTES.md` and `AGENTS.md` are development-only. Source and full verification notes remain available in the repository. `NOTES.md` records the exact baseline, implementation findings and checks actually run.
