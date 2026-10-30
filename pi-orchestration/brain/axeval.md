# axeval: what a fresh agent hits when using pi-orchestration

Evaluated on 2026-10-30. Base: brain/orchestration at 303a9c1. The file:line references below are against 9b8f46a, which was merged into brain/axeval. Each scenario ran from a clean temp cwd with a short `--home` (`/tmp/axN/h`) and used only help text, the guide, the README (where the guide points) and error messages; the source was read only afterwards, to locate fixes. Total spend was about $0.12: four headless Pi sessions came to $0.11, and 13 workflow runs to $0.005.

`W` below stands for `node pi-orchestration/bin/workflow.mjs`.

## Already fixed during the evaluation (not ranked)

- **Next-step hints dropped `--home`** (fixed in 4eb0dc1). The original hint `poll: workflow poll <id>` reached the default home: `error not_found: Unknown workflow run 8dd870d1-…. Use workflow list.` (exit 2, home not named). Hints now read `workflow --home /tmp/ax3/h …`.
- **Plain `status`/`poll` text hid the next step** (fixed in 9b8f46a). A failed run printed only `… typeerr failed 0s · … · 0 agents · 0 tokens · $0.0000`, with no reason. A signal wait printed `… gate waiting_signal 4s · no model · Approval 0/0 · …` with no key. A completed run gave no `result` hint. I re-checked all three against 9b8f46a: they now print `workflow_failed: ctx.runAgent is not a function`, `waiting for signal "approve-plan": …` plus `signal: workflow --home … signal <id> "approve-plan" '<json>'`, and `result: workflow --home … result <id>`.

## Scenario 1: CLI, from nothing to a 2-agent parallel result

Commands: `W --help`, `W guide --home /tmp/ax1/h`, `W init pair`, then I rewrote it to two `ctx.parallel` agents with `tools: []`. Then `W validate pair`, `W catalog`, `W run pair --args '{"topic":"honey"}' --model anthropic/claude-haiku-4-5 --bg --max-agents 2 --max-cost-usd 0.20`, `W poll <id>`, `W status <id> [--verbose|--json]`, `W result <id> [--json]`, `W list`, `W agents --run <id>`, `W worker status`. It completed in 3 s for $0.0006.

**Wrong turns: 5** (2 since fixed: the `--home` hint and the missing `result` hint).

1. The guide's run section is written for the tool. guide.ts:65: `Without wait, run returns a runId at once; the launching session gets a message when the run ends.` In the shell, `run` attaches until the run ends. `--bg` and `poll` appear only in `--help`.
2. I copied the `--bg` hint `poll: workflow poll <id>` without `--home` → `error not_found` (fixed in 4eb0dc1).
3. `poll` finished with a bare summary line and no pointer to `result` (fixed in 9b8f46a).
4. `W agents --run 8dd870d1-…` for a run with 2 agents printed `[]`, raw JSON in text mode. Nothing explains that `agents` lists only `ctx.spawn` background agents.
5. The JSON keys disagree between commands. `run --bg --json` gives `{"runId":…,"status":"queued","model":"anthropic/claude-haiku-4-5"}`. `status --json`/`list --json`/`poll --json` key the same run as `"id"`. Attached `run --json` emits both `id` and `runId`. `result --json` is the bare value with no status (documented in the README, but unlike every other command). `worker status` prints pretty JSON in text mode.

## Scenario 2: deliberately broken workflows

Files: `syntax.ts` (missing `)`), `badargs.ts` (`args: { topic: "string" }`), `badargs2.ts` (`args: Type.String()`), `noexport.ts`, `namedexport.ts`, `nondet.ts` (name `"Non Det"`, then `Date.now()`, `Math.random()`, `readFileSync`), `norun.ts`, `sinclair.ts` (`import { Type } from "@sinclair/typebox"`), `typeerr.ts` (`ctx.runAgent(…, { tool: [] })`). Each was validated with and without `--json`; the plausible ones were run with `--max-agents 1 --max-cost-usd 0.05`.

These worked well: the syntax error gives `…/syntax.ts:9:70`, a missing or named default export gives `must export default defineWorkflow({ name: 'kebab-case', async run(ctx) { ... } })`, a bad name gives `Workflow name must be kebab-case, for example 'review-changes'.`, a missing run() gives `Workflow must define an async run(ctx) function.`, the lint reports `line 10: Date.now()/Date() is not replay-safe …`, and an unknown name gives `Workflow not found: nosuch. Use catalog --cwd /tmp/ax2/w, or pass a workflow file path.`

**Wrong turns: 8** (1 since fixed: a failed run's text status had no reason).

1. `badargs` (plain object args) → `Valid: badargs (…)`. `run badargs --args '{"topic":5}'` then started an agent, which received `hello 5`. The schema check never runs.
2. `typeerr` (`ctx.runAgent`) → `Valid: typeerr (…)`. It failed only at runtime: `workflow_failed: ctx.runAgent is not a function`, with no line number.
3. After correcting to `ctx.agent(…, { tool: [] })`, validate still said Valid. The misspelled option was silently ignored, and the agent, asked to list its tools, answered **`Read, Write, Edit, Bash`**. The author asked for none.
4. `readFileSync("README.md")` directly in run() is not flagged, although the guide says "I/O only inside ctx.step. validate flags the common mistakes."
5. `@sinclair/typebox` → `Cannot load …: Cannot find module '@sinclair/typebox'\nRequire stack:\n- …/sinclair.ts`. It gives no hint that the bundled package is `typebox`.
6. `run badargs2 --args '{"topic":"x"}'` → `error invalid_args: Arguments do not match the workflow schema: [{"keyword":"type","schemaPath":"#","instancePath":"","params":{"type":"string"},"message":"must be string"}]`. This is raw AJV output, and validate had called the string schema Valid.
7. A failed run's text `status`/`poll` showed no reason, so I needed `--json` or `result` (fixed in 9b8f46a).
8. Diagnostics differ by error type. Load errors put `file:line:col` inside `message` and omit `path`/`name`. Lint errors have a `line` field. Load stops at the first error, so the bad name hid the two lint findings until I fixed it.

## Scenario 3: a workflow waiting on ctx.signal (CLI)

`gate.ts` calls `ctx.signal("approve-plan", { schema: Type.Object({ ok: Type.Boolean(), note: Type.Optional(Type.String()) }), prompt })` and runs no agents. Commands: `W run gate --args '{"plan":"ship it"}' --bg` (no `--model`, which warns correctly), `W status`, `status --verbose`, `status --json`, `poll`, `poll --once`, `poll --until signal`, `watch`, `signal` with a wrong key, a wrong shape, a non-JSON value and then a correct one, plus `cancel` and `result`.

**Wrong turns: 7** (2 since fixed: plain `status`/`poll` had no key, and the `--home` hint).

1. Plain `status` and `poll --until signal` gave no key. Only `--verbose`, `watch` or `.waitingFor` in `--json` had it (fixed in 9b8f46a).
2. **Plain `poll` never returns on `waiting_signal`.** My `timeout 12` run printed the same line 12 times and exited 124. It is still open after 9b8f46a, which now prints 3 lines per tick. The help reads `poll <runId> [--interval 5s] …`, but the default is 1 s. An agent running `W poll <id>` without a timeout blocks forever.
3. The signal schema is shown nowhere: `waitingFor` is `{key, prompt}` only. A wrong shape gives only `error invalid_signal: Signal 'approve-plan' does not match its schema.`, with no field, expected type or received value. I succeeded only because my own prompt text described the shape.
4. Wrong key → `error unknown_signal: No waiting signal 'approve'. Use status --verbose to see the requested key.` It sends the agent to another command instead of naming `approve-plan`.
5. `signal` and `cancel` print pretty JSON in text mode. `cancel` dumps the full 60-line run record, including a stale `waitingFor`.
6. `result` on the cancelled run → `error run_failed: Run 602d… is cancelled.` with **exit 2**, while the help says `3 cancelled`.
7. I copied the `--home`-less signal hint (fixed in 4eb0dc1).

## Scenario 4: Pi extension, headless

`cd /tmp/ax4/w && PI_WORKFLOW_HOME=/tmp/ax4/h pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline -e …/pi-orchestration/index.ts --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- '<prompt>'`. Two environment issues forced this model: `anthropic/*` returned "You're out of extra usage", and `openai/*` mini models were rejected for the ChatGPT Codex account. I captured the `tool_execution_*` events from the NDJSON.

| Session | Prompt | Tool calls / errors | Outcome |
|---|---|---|---|
| A | catalog → validate `tiny` → run `{"topic":"bees"}` wait → status → result → list | 14 / 9 | **Never launched.** 8× `run` with `"args":"{\"topic\":\"bees\"}"` (a string), then read/find of the file. The final answer blamed "a backend schema validator". |
| B | same, plus "args must be a JSON object value, not a string" | 7 / 5 | **Never launched.** It sent the string again 4 times, and once with no args. |
| C | no-args `tiny-noargs`: run wait → status verbose → result → list → run (no wait) → status | 6 / 0 | Worked first time. |
| D | no-args `gate-noargs`: run, find out what it waits for, approve | 14 / 6 | 6× `signal` with `"value":"true"`, `"\"approved\""`, `"null"`, `"{}"`, `"{\"ok\": true}"` (all strings). Then it read the source and **fell back to `bash: workflow signal … '{"ok": true}'`**, which worked. |

**Wrong turns: A 11, B 5, C 0, D 11.** Both blocks have the same cause: the tool declares `args` and `value` as `Type.Unknown` (extension.ts:58, :76), so Haiku sends JSON-encoded strings. The errors give no hint of that:
- `Arguments do not match the workflow schema: [{"keyword":"type","schemaPath":"#","instancePath":"","params":{"type":"object"},"message":"must be object"}]`
- `Signal 'approve-plan' does not match its schema.`

Both arrive with `"details":{}`, so there is no error code either.

Other observations from the tool results:
- Non-verbose `status` is good. It says `Waiting for signal "approve-plan": Approve the plan?` and includes `waitingFor` in `details`.
- Verbose `status` ends with the CLI command `deliver with: workflow signal <id> "approve-plan" '<json>'`, inside a tool result (extension.ts:358 → presentation.ts:112). That is probably what sent session D to bash.
- `catalog` ends with `To write a new workflow, call guide.` and returns `searched`/`examples`. That is good.

### CLI `--json` and tool `details` compared

| Action | CLI `--json` | Tool `details` |
|---|---|---|
| run (detached) | `{runId, status, model:"openrouter/anthropic/claude-haiku-4.5"}` | `{runId, status, model:{provider, modelId}}` |
| run (attached / `wait:true`) | full record with **both** `id` and `runId` | brief `{runId, workflow:"tiny-noargs", status, summary, result}` |
| status | full record: `id`, `workflow:{name,path,hash}` | brief `{runId, workflow:<name>, status, summary, error?, waitingFor?, result?}`; full record only with `verbose` |
| list | array of full records (`id`) | array of brief `{runId, workflow, status, summary}` |
| result | bare value | bare value |
| errors | `{"error":{"code","message"}}` | text only, `details: {}` |
| run.error inside a record | `{reason, message}` | same, while CLI errors use `code` |
| `model` inside a record | string for CLI launches | `{provider, modelId}` for tool launches; one `list` mixes both |

## Ranked fixes

1. **Make the tool's `args` an object and explain string arguments.**
   - Where: extension.ts:58 and engine/index.ts:300.
   - Change the parameter to `args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "For run: a JSON object matching the workflow's args schema, e.g. {\"path\":\"src/a.ts\"} — not a JSON-encoded string. Default {}." }))`.
   - In engine/index.ts:300, when `typeof request.args === "string"`, throw `invalid_args: args is a JSON-encoded string; pass the object itself, e.g. {"topic":"bees"}`. Otherwise turn `Value.Errors` into lines such as `args/topic: must be string (got 5); expected {"topic": string}`.
   - Expected effect: sessions A and B succeed on the first call, removing 13 failed tool calls and both never-launched sessions. Workflows whose args are not objects are covered by fix 4.
2. **Show the signal schema and explain signal mismatches.**
   - Where: execution.ts:361, presentation.ts:61 and :112, cli.ts `statusText`, engine/index.ts:411 and execution.ts:368, extension.ts:76.
   - At execution.ts:361, add `schema: current.schema` to `waitingFor`. presentation.ts:61, presentation.ts:112 and cli.ts `statusText` print `expects: {"ok": boolean, "note"?: string}`.
   - At engine/index.ts:411 and execution.ts:368, say `Signal 'approve-plan' expects {"type":"object","required":["ok"],…}; got "true" (a string). /ok: must be boolean.`, adding `pass the JSON value itself, not a JSON-encoded string` when the value is a string.
   - Also at engine/index.ts:410, name the waiting key: `No waiting signal 'approve'. The run is waiting for 'approve-plan'.`
   - At extension.ts:76, extend the `value` description to `the JSON value itself (an object, array, number, boolean or null), not a JSON-encoded string`.
   - Expected effect: session D answers in 1 call instead of 6 failures, a source read and a bash fallback. CLI scenario 3 no longer depends on the author describing the shape in the prompt.
3. **Reject unknown `ctx.agent` options; lint unknown `ctx` members.**
   - Where: execution.ts:297 (`resolveOptions`) and validation.ts:50.
   - In `resolveOptions`, throw `invalid_agent_options: Unknown agent option 'tool' (did you mean 'tools'?). Known: model, thinkingLevel, instructions, tools, cwd, isolation, budget, timeoutMs, retries, schema, label, phase, agentType, key.`
   - In validation.ts:50, add a diagnostic for `ctx.<name>` where the name is not in the documented ctx API (`ctx.runAgent` → `did you mean ctx.agent?`). Add one for literal option objects passed to `ctx.agent` with unknown keys.
   - Expected effect: the silent grant of Read/Write/Edit/Bash in scenario 2 becomes a validate error. Typos fail before launch instead of with a runtime `is not a function`.
4. **Require args to be a TypeBox object.**
   - Where: loader.ts:72, plus `defineWorkflow` in index.ts:83.
   - Replace `Type.IsSchema(definition.args)` with `Type.IsObject(definition.args)`. `Type.IsSchema({topic:"string"})` returns `true`; `Type.IsObject` returns `false`.
   - New message: `…: args must be Type.Object({...}) from "typebox"; got {"topic":"string"}.`
   - Expected effect: `badargs` fails validate instead of running with `{topic:5}`. Tool args are always objects, which fix 1 relies on.
5. **Stop `poll` on a signal wait by default and print only changes.**
   - Where: cli.ts:22, :227–228, :244–247.
   - By default, `poll` returns when the run is terminal **or** `waiting_signal`, after printing the `signal:` line. Keep `--until done` for the old behaviour.
   - Print a line only when the summary changes, apart from elapsed time.
   - Make the help match the 1 s default: `[--interval 1s]`.
   - Expected effect: `W poll <id>` can no longer hang an agent's bash tool on a gate. In scenario 3 the session needed `timeout` to get out.
6. **Give tool results tool-shaped hints.**
   - Where: extension.ts:358 and presentation.ts:110–113.
   - Pass a formatter so verbose tool status prints `deliver with: {"action":"signal","runId":"<id>","key":"approve-plan","value":<json value>}` instead of the CLI command. Apply the same to `retry` hints in `runTree`.
   - Expected effect: models stay in the tool instead of switching to bash, as happened in session D.
7. **Give tool errors a code.**
   - Where: around the `client.request` call at extension.ts:318.
   - Catch `WorkflowError` and rethrow it with the message `invalid_args: …` (code first), or return `isError` with `details: { error: { code, message } }`. That matches the CLI's `{"error":{"code","message"}}` and lets codemode scripts branch on it.
   - Fix the dead branch at extension.ts:179: it checks `"run_not_found"`, but the engine throws `"not_found"` (engine/index.ts:221, :228).
   - Expected effect: tool and CLI errors share one shape, and runs that vanished stop being polled.
8. **Use one run shape across surfaces.**
   - Where: engine/index.ts:302 (or extension.ts:291 and cli.ts `modelOption`), and cli.ts `status`/`list`.
   - Store `model` in one form, either always `"provider/modelId"` or always `{provider, modelId}`, whichever surface launched the run.
   - Make CLI `status --json` and `list --json` emit the tool's brief view (`runId`, `workflow` name, `status`, `summary`, `error?`, `waitingFor?`, `result?`), keeping the full record for `status --verbose --json`.
   - Drop the duplicate `id`/`runId` in attached `run --json`.
   - Expected effect: an agent that learned the shape on one surface can parse the other, and `list` never mixes model types.
9. **Stop dumping JSON in text mode and fix exit codes.**
   - Where: cli.ts:322 (cancel), :327 (retry), :331 (signal), :339 (agents), :384 (worker status), engine/index.ts:491 and cli.ts:178.
   - `cancel`/`retry`: print `statusText(run, hint)`.
   - `signal`: `Signal "approve-plan" accepted. poll: workflow … poll <id>`.
   - `agents` with no entries: `No background agents. agents lists ctx.spawn() agents; ctx.agent() steps are in status --verbose.`
   - `worker status`: `worker pid 2185559 · home /tmp/ax1/h · up 36s`.
   - For `result` on a cancelled run, use code `run_cancelled` and make `errorInfo` return exit 3, as the help documents.
   - Expected effect: text output is readable in one line, and exit codes match `--help`.
10. **Give the guide a shell lifecycle.**
   - Where: guide.ts:63–65.
   - Replace the shell bullet and the sentence after it with: `- Shell: workflow run review-file --args '{"path":"src/a.ts"}' --model provider/model waits and prints the result. Add --bg to get a runId at once, then workflow poll <runId> (returns when it ends or waits for a signal) and workflow result <runId>.` followed by `In Pi, run without wait returns a runId at once and the session gets a message when the run ends.`
   - Expected effect: a shell agent learns `--bg` → `poll` → `result` from the guide alone; today the guide describes only tool semantics.

## Other observations (not ranked)

- `readFileSync`/`fetch`/`child_process` in run() control flow are not linted (validation.ts:50–64). Flag calls whose callee comes from `node:fs`, `node:child_process` or global `fetch`, outside `ctx.step`.
- `Cannot find module '@sinclair/typebox'` could add `use import { Type } from "typebox" (bundled)` (loader.ts:68).
- `not_found` (exit 2) and `workflow_not_found` (exit 1) are both lookup failures but exit differently (cli.ts:186). `Unknown workflow run <id>` does not name the home it searched.
- `catalog --home /tmp/ax1/h` still lists `~/.pi/agent/workflows`, because `--home` isolates run state, not the catalog. That matches the docs but may surprise someone isolating a test.
- Phases with only signals show `Approval 0/0`. `costUsd` is emitted unrounded (`0.0006230000000000001`).
