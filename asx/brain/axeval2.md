# axeval2: did round one's fixes remove the wrong turns?

Evaluated on 2026-10-30 against brain/orchestration at 3fb3137, where all ten fixes from [axeval.md](axeval.md) are merged. File:line references are to that commit. I repeated round one's four scenarios with the same workflow files and the same command sequences. Each ran from a clean temp cwd with a short `--home` (`/tmp/axbN/h`). I used only `--help`, the guide, the README and error messages, and read `src/` only afterwards to locate fixes. `npm run build` ran first; `W` below is `node pi-orchestration/bin/workflow.mjs`.

Models: the CLI workflow agents used `anthropic/claude-haiku-4-5`. Headless Pi sessions on that model returned `400 … You're out of extra usage` (round one hit the same error), although the worker's agents ran on it. So the Pi sessions used `openrouter/anthropic/claude-haiku-4.5 --thinking off`, the model round one's scenario 4 also used, and the counts compare directly. Spend was $0.158: seven Pi sessions cost $0.152 (including two experiment sessions and one guide capture), and 27 workflow runs cost $0.006.

## Headline

| Scenario | Round one | Now |
|---|---|---|
| 1 CLI, nothing → 2-agent parallel result | 5 | **0** |
| 2 Broken workflows | 8 | **4** (3 after 2cb15bb) |
| 3 Signal discovery from status/poll | 7 | **0** |
| 4A Tool: catalog → validate → run args → status → result → list | 11 (14 calls / 9 errors, never launched) | **0** (6 / 0) |
| 4B Same, told "args must be an object" | 5 (7 / 5, never launched) | **0** (6 / 0) |
| 4C Tool, no-args workflow | 0 (6 / 0) | **0** (7 / 0) |
| 4D Tool: run a gate, find what it waits for, approve | 11 (14 / 6, bash fallback) | **13** (16 / 4, cancelled the run, bash fallback) |

Of the ten fixes, seven held fully and three held in part (2, 6 and 7). I found no regressions. At 3fb3137, session D still failed, for the same root cause as round one: the tool's `value` parameter was still `Type.Unknown` (extension.ts:79). With `value` typed as a union, the same session took 4 calls with 0 errors (experiment below). The other main new finding is that attached `workflow run`, the guide's default shell command, never returns on a signal wait. That is the same hang that fix 5 removed from `poll`.

**Fixed on brain/orchestration after these runs (per the brain; I did not re-run them):**

- 2cb15bb: `ctx.runAgent` (scenario 2).
- e858e23: a signal to a completed, cancelled or reverted run now fails with `run_finished` (ranked fix 5).
- ec5ca3d: the tool's `value` is a typed JSON-value union (ranked fix 1, the D-x1 variant).
- 341efca: `status --verbose`/`watch` print `Expects: <schema>` (ranked fix 3).

The open top fix is now ranked fix 2: attached `run` must return on a signal wait.

## Scenario 1: CLI, from nothing to a 2-agent parallel result

Commands: `W --help`, `W guide`, `W init pair`, then I rewrote the file to two `ctx.parallel` agents with `tools: []` (as round one did). Then `validate pair`, `catalog`, `run pair --args '{"topic":"honey"}' --model anthropic/claude-haiku-4-5 --bg --max-agents 2 --max-cost-usd 0.20`, `poll`, `status [--verbose|--json]`, `result [--json]`, `list [--json]`, `agents --run [--json]`, `worker status [--json]` and `poll --json`. I also ran it attached, with `run --bg --json` and with attached `run --json`. It completed in 1 s for $0.0007.

**Wrong turns: 0** (round one 5). All five held:

- Guide (fix 10): `Shell: workflow run review-file --args '{"path":"src/a.ts"}' --model provider/model waits and prints the result. Add --bg to get a runId at once, then workflow poll <runId> (returns when the run ends or waits for a signal) and workflow result <runId>.`
- Hints keep `--home`: `poll: workflow --home /tmp/axb1/h poll ea8c2698-…`.
- `poll` ends with `result: workflow --home /tmp/axb1/h result ea8c2698-…`.
- `agents --run` (fix 9): `No background agents. agents lists ctx.spawn() agents; ctx.agent() steps are in status --verbose.` `worker status`: `worker pid 2317258 · home /tmp/axb1/h · up 10s`.
- One shape (fix 8): `run --bg --json` gives `{"runId":…,"status":"queued","model":"anthropic/claude-haiku-4-5"}`. `status --json`, `poll --json` and attached `run --json` all print the same single brief document, `{"runId","workflow":"pair","status","model","summary","result"}`, with no `id`. `list --json` gives the list view.

New: attached `run` in text mode reprints the whole step tree on every 1 s tick even when only elapsed time changed. `nap.ts` (`ctx.sleep(6000)`) printed 7 identical trees. `poll` and `watch` print only on change (cli.ts:250–253). The attached branch (cli.ts:247) has no such filter. See fix 2.

## Scenario 2: deliberately broken workflows

I used round one's nine files, copied from `/tmp/ax2`, starting where round one started: `nondet` named `"Non Det"`, and `typeerr` calling `ctx.runAgent(…, { tool: [] })`. Each file was validated with and without `--json`, and the plausible ones were run with `--max-agents 1 --max-cost-usd 0.05`.

**Wrong turns: 4** (round one 8). Round one's wrong turns, one by one:

| # | Round one | Now |
|---|---|---|
| 1 | `badargs` (`args: { topic: "string" }`) validated, then ran with `{topic:5}` | **Held (fix 4).** `Invalid: …/badargs.ts: args must be Type.Object({...}) from "typebox"; got {"topic":"string"}. (invalid_workflow)`. `run` refuses with exit 1. |
| 2 | `ctx.runAgent` validated, failed at runtime | **Open at 3fb3137:** `Valid: typeerr`, then `workflow_failed: ctx.runAgent is not a function`. **Fixed after this report at 2cb15bb** (`unknown_context_member` with the line, per the brain); not re-run here. |
| 3 | `{ tool: [] }` silently granted Read/Write/Edit/Bash | **Held (fix 3).** `line 9: Unknown agent option 'tool' (did you mean 'tools'?). Valid options: model, thinkingLevel, … (unknown_agent_option)`, and the same message at runtime. With `tools: []` the agent had no tools. |
| 4 | `readFileSync` in run() not flagged | **Open.** `Valid: nondet`, then `workflow_failed: ENOENT: no such file or directory, open 'README.md'`. |
| 5 | `@sinclair/typebox` gave no hint | **Open.** `Cannot load …/sinclair.ts: Cannot find module '@sinclair/typebox'\nRequire stack:\n- …/sinclair.ts (invalid_workflow)`. |
| 6 | raw AJV for `badargs2` | **Held (fixes 1 and 4).** validate rejects `Type.String()` args. Args errors are now lines: `Arguments do not match the workflow schema {"type":"object",…}:\nargs/topic: must be string (got 5)`, `args: must have required properties topic (got {})`, `args: must be object (got [1])`. |
| 7 | failed run's text status had no reason | **Held.** `workflow_failed: …` and `unknown_agent_option: …` are under the summary line. |
| 8 | load stops at the first error; diagnostics differ | **Open.** `Non Det` gives only `Workflow name must be kebab-case…`; the two `Date.now()`/`Math.random()` findings appear only after renaming. Load diagnostics are `{message, code}` with `…/syntax.ts:9:70` inside `message`, while lint diagnostics have `{code, line, message}`. |

Also seen:

- `run` launches a workflow that validate calls Invalid, and the run then fails at runtime. `typeerr` with `{tool: []}` produced `run … started`, then `typeerr failed 0s … unknown_agent_option: …` with exit 2. `clock.ts` (`Date.now()`) produced `nondeterministic_call: Date.now() is not replay-safe…` with exit 2 and no line. The launch at engine/index.ts:299 loads the workflow but does not lint it.
- The `invalid_args` message for a JSON-encoded string uses a fixed example (engine/index.ts:302): `pass the object itself, e.g. {"topic":"bees"}`, whatever the workflow's args are.

## Scenario 3: a workflow waiting on ctx.signal (CLI)

I used round one's `gate.ts`, copied from `/tmp/ax3`. Commands: `run gate --args '{"plan":"ship it"}' --bg` (without `--model`, which warns), `status`, `status --verbose`, `status --json`, `poll`, `poll --once`, `poll --until signal`, `poll --json` and `watch`. Then `signal` with a wrong key, a wrong shape, a missing field, a JSON-encoded string, a non-JSON value, no value and finally the correct value. After that, a repeat signal, `poll`, `result`, and `cancel`/`result`/`signal` on a second run.

**Wrong turns: 0** (round one 7). All seven held:

- Plain `status` and `poll`:
  ```
  4899bfc9-… gate waiting_signal 3s · no model · Approval 0/0 · 0 agents · 0 tokens · $0.0000
  waiting for signal "approve-plan": Approve the plan "ship it"? Send {"ok": true|false, "note"?: string}.
  expects: {"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"},"note":{"type":"string"}}}
  signal: workflow --home /tmp/axb3/h signal 4899bfc9-… "approve-plan" '<json>'
  ```
- Fix 5: plain `poll`, `poll --once` and `poll --until signal` each print that block once and exit 0. Round one's `timeout 12` exited 124.
- Fix 2: `--json` `waitingFor` carries `schema`. A wrong shape gives `Signal 'approve-plan' expects {…}; got {"ok":"yes"}.\nvalue/ok: must be boolean (got "yes")`. A missing field gives `value: must have required properties ok (got {})`. A string-encoded value gives `… Pass the JSON value itself, not a JSON-encoded string.` A wrong key gives `No waiting signal 'approve'. The run is waiting for 'approve-plan'.`
- Fix 9: signal prints `Signal "approve-plan" accepted. poll: workflow --home /tmp/axb3/h poll 4899bfc9-…`. `cancel` prints one summary line, with no stale `waitingFor` (tick 30). `result` on the cancelled run gives `error run_cancelled: Run 1f5ca752-… is cancelled.` with **exit 3**.

New:

- **`status --verbose` and `watch` omit the schema.** They print the prompt and `Waiting for approve-plan; deliver with: …` but no `expects:` line, so the verbose view shows less than the plain one. runTree (presentation.ts:134–137) is a third copy of the waiting text, after presentation.ts:71–72 and cli.ts:173–177. Session D-x2 below hit this gap.
- **A signal to a cancelled run is "accepted".** `W signal <cancelled-id> approve-plan '{"ok":true}'` gives `Signal "approve-plan" accepted. poll: …` with exit 0. Another key on the same run gives `No waiting signal 'other-key'. The run is not waiting for a signal (status cancelled).` engine/index.ts:415–427 never checks the run's status.
- **Attached `run` never returns on a signal wait.** The guide's default shell form, `W run gate --args '{"plan":"attached"}'` under `timeout 6`, wrote 32 lines (the 5-line tree once a second) and exited 124. `W run gate … --json` wrote **nothing at all**, not even the runId, until it was killed. The runs survived the kill. This is round one's poll hang, moved to `run` (cli.ts:241–247).
- `unknown_signal` and `signal_already_set` exit 2 (`--help`: `2 failed`), while `invalid_signal` exits 1 (cli.ts:189–192).

## Scenario 4: Pi extension, headless

`cd /tmp/axb4/w && PI_WORKFLOW_HOME=/tmp/axb4/h pi -p --mode json --no-session --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline -e <worktree>/pi-orchestration/index.ts --model openrouter/anthropic/claude-haiku-4.5 --thinking off -- '<prompt>'`. Round one did not record its workflows or prompts, so I rebuilt them from its table: `tiny` (`args: {topic}`, one agent with `tools: []`), `tiny-noargs`, and `gate-noargs`. `gate-noargs` waits on `approve-plan` with schema `{ok: boolean, note?: string}` and prompt `Approve the plan?`, which does not describe the shape. `--no-memory` is rejected under `--no-extensions`.

| Session | Prompt | Calls / errors | Outcome |
|---|---|---|---|
| A | catalog → validate `tiny` → run topic "bees" and wait → status → result → list | 6 / 0 | `{"action":"run","workflow":{"name":"tiny"},"args":{"topic":"bees"},"wait":true}` on the first try. |
| B | same, plus "args must be a JSON object value, not a string" | 6 / 0 | Same as A. |
| C | `tiny-noargs`: run wait → status verbose → result → list → run (no wait) → status | 7 / 0 | One extra `catalog` first. The completion message reached the session: `[workflow] f794b12f-… completed`. |
| D | `gate-noargs`: run (no wait), find what it waits for, approve, get the result | 16 / 4 | See below. |

**Wrong turns: A 0 (was 11), B 0 (was 5), C 0 (was 0), D 13 (was 11).** I count every call except the necessary run, status and result as a wrong turn, as round one did.

Session D, call by call:

1. `run` (ok).
2. `status` (ok). It showed `Waiting for signal "approve-plan": Approve the plan?` and `Expects: {"type":"object","required":["ok"],…}`.
3. `signal` with `"value":"{\"ok\": true}"` → `invalid_signal: Signal 'approve-plan' expects {…}; got "{\"ok\": true}". Pass the JSON value itself, not a JSON-encoded string.`
4. The same signal again, with the same error.
5. `status` again.
6. `result` → `result_not_ready: Run … is waiting_signal. Use poll 30495624-… --until done.` That is a CLI command in a tool result, and the tool has no poll action.
7. The same string signal a third time.
8. `status verbose:true`. It printed `deliver with: {"action":"signal",…,"value":<JSON value, not a string>}` (fix 6 held) but no `Expects:` line.
9–10. `find` and `read` of the workflow source.
11. **`cancel` of the waiting run.**
12. A new `run`.
13. `bash sleep 2`.
14. `status`.
15. `bash: workflow signal … '{"ok": true}'`. This was the installed 0.2.1 CLI on PATH, which printed pretty JSON.
16. `result` (ok).

The model said in its final answer: "I had trouble sending the signal through the workflow tool's parameter interface and ended up cancelling it to start fresh."

The cause is the one round one found. Fix 1 typed `args` as `Type.Object` (extension.ts:58), and sessions A and B now succeed. Fix 2 only lengthened `value`'s description and left it `Type.Unknown` (extension.ts:79). With no type in the schema, Haiku sends a string, and the new error text did not change that in three tries.

**Experiment.** I temporarily edited extension.ts:79 and reverted it afterwards; nothing was committed. The edit was `value: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()], { description: <unchanged> }))`, with the same prompt.

- D-x1: **4 calls, 0 errors**: run → status → `signal` with `"value": {"ok": true}` → result.
- D-x2: 5 calls, 1 error. It used `status verbose:true` (no `Expects:`), sent `"value": true`, read `expects {…}; got true.` and then sent `{"ok": true}`. The remaining error is the verbose-status gap from scenario 3.

Other notes from the tool results:

- Fix 7 held in part. Error text leads with the code (`invalid_signal: …`, `result_not_ready: …`), and the poller now drops `not_found` runs (extension.ts:193). But errors still arrive with `details: {}`, because `codedError` rewrites the message and rethrows (extension.ts:102, :397).
- The tool's `signal` reply is pretty JSON, `{"runId": …, "key": "approve-plan", "accepted": true}` (extension.ts:394, the default branch). The CLI says `Signal "approve-plan" accepted. poll: …`.
- Tool `details` and CLI `--json` now match: `runId`, `workflow` name, string `model` (`"openrouter/anthropic/claude-haiku-4.5"`), `summary`, and `waitingFor` with `schema`. Verbose status gives the full record with `id` on both surfaces.

### Parity: `workflow guide` and the tool's `guide` action

Both come from `guide()` (guide.ts:44); the tool calls it at extension.ts:311 and the CLI at cli.ts:376. I diffed the tool's text, captured from a session's `tool_execution_end`, against `W guide`. They teach the same things: the template, the Pi tool, `/workflow` and the shell lifecycle (`--bg` → `poll` → `result`), the model rules, the ctx API and the rules. The text differs in two places:

1. The tool appends `This session's model is openrouter/anthropic/claude-haiku-4.5:off.`, which is intended.
2. The tool's shell line reads ``Shell: `workflow` is not on PATH here, so use the full command: node …/pi-orchestration/bin/workflow.mjs run …``. In fact `workflow` *is* on PATH, as a different install (0.2.1, `/etc/profiles/per-user/nixos/bin/workflow`). link.ts:25–29 returns `node <bin>` whenever the PATH command's realpath differs. The fallback is right, but the reason it gives is wrong, and session D's bash fallback used that other install.

A gap common to both: the guide says only that a signal is "delivered with the signal action" (guide.ts ctx list). It never says the value is the JSON value itself, or that `status` shows the key and schema. This matters less than the schema fix, because session D never called `guide`.

## Fixes from round one: held, partial or open

| Fix | Status | Evidence |
|---|---|---|
| 1 tool `args` object; explain string args | Held | Sessions A and B 0 errors; `args is a JSON-encoded string; pass the object itself…` |
| 2 signal schema; explain mismatches | Partial | `expects:`/`Expects:` in plain status and poll, mismatch lines, the wrong key named. Missing: `value` still `Type.Unknown` (D 13 wrong turns), and verbose status and watch have no schema. |
| 3 unknown agent options; unknown ctx members | Held | `unknown_agent_option` with did-you-mean; `ctx.runAgent` fixed at 2cb15bb after this run. |
| 4 args must be `Type.Object` | Held | `args must be Type.Object({...}) from "typebox"; got {"topic":"string"}` |
| 5 `poll` stops on a signal and prints only changes | Held for `poll` | Attached `run` still hangs (new fix 2). |
| 6 tool-shaped hints | Partial | Verbose status prints `{"action":"signal",…}`; `result_not_ready` still says `Use poll <id> --until done.` |
| 7 tool errors carry a code | Partial | The code leads the message; `details` is still `{}`. |
| 8 one run shape | Held | Identical keys on CLI `--json` and tool `details`; string model. |
| 9 no JSON in text mode; exit codes | Held | cancel, signal, agents and worker status print one line; `run_cancelled` exits 3. |
| 10 guide shell lifecycle | Held | Quoted in scenario 1. |

## Ranked fixes

1. **Type the tool's signal `value`.** *Fixed after this report at ec5ca3d.*
   - Where: extension.ts:79.
   - Replace `Type.Unknown({…})` with `Type.Union([Type.Object({}, { additionalProperties: true }), Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()], { description: <unchanged> })`. Keep `String` so string-valued signals still work.
   - Expected effect: session D goes from 16 calls / 4 errors / a cancelled run / a bash fallback to 4 calls / 0 errors (D-x1). It is the last case where a model leaves the tool.
   - Evidence: session D vs D-x1 and D-x2 above. Round one's D failed the same way.
2. **Make attached `run` stop on a signal wait and print only changes.**
   - Where: cli.ts:241–247, the `foreground` branch of `poll`.
   - Reuse the change key from cli.ts:250–251 so a tree prints only when something besides elapsed time changes.
   - On `waiting_signal`, print `statusText(run, hint)` (key, prompt, `expects:`, `signal:` hint) plus `The run continues; after signalling: <hint> poll <id>`, and return 0 (detached, not cancelled).
   - In `--json` mode, emit the brief view at that point instead of nothing.
   - Expected effect: an agent that follows the guide's shell command on a gating workflow gets the key, the schema and the command back from one bash call. Today it hangs until its tool times out (`timeout 6` → 32 lines, exit 124; `--json` → 0 bytes). The 6 s nap would print 2 trees, not 7.
3. **Use one formatter for a waiting signal, with the schema in every view.** *The schema part is fixed after this report at 341efca (verbose status and watch print `Expects:`). Whether the three copies were merged is not checked here.*
   - Where: presentation.ts:134–137 (runTree, used by verbose status and watch), presentation.ts:71–72 and cli.ts:173–177.
   - Add a helper `waitingLines(run, hints)` that returns the key and prompt, `Expects: <schema>` and the surface's hint, and call it from all three places.
   - Expected effect: removes D-x2's remaining error. CLI `status --verbose`/`watch` and tool `verbose:true` stop hiding the schema that the plain views show.
4. **Name only next steps that exist on the surface.**
   - Where: engine/index.ts:500 and extension.ts:394.
   - Make the engine message surface-neutral: `Run X is waiting for signal "approve-plan"; deliver it, then read the result.` (or `Run X is running; the result is not ready.`). The CLI appends `poll: <hint> poll X`, and the tool appends `{"action":"status","runId":"X"}`.
   - Give the tool's `signal` reply its own case: `Signal "approve-plan" accepted; the run continues. This session gets a message when it ends.`
   - Expected effect: the tool never tells a model to run `poll --until done`, which it cannot do (session D call 6), and the signal reply reads like the CLI's.
5. **Refuse signals to finished runs.** *Fixed after this report at e858e23 (`run_finished`).*
   - Where: engine/index.ts:416–425.
   - When the run's status is terminal and the key has no stored value, throw `run_not_waiting: Run X is cancelled; it no longer waits for 'approve-plan'. Start a new run.`
   - Expected effect: an agent can no longer read `Signal "approve-plan" accepted. poll: …` (exit 0) about a cancelled run and report it approved.
6. **Validate everything in one pass, and refuse at launch what validate rejects.**
   - Where: loader.ts:81–86 and engine/index.ts:299.
   - When loading fails but the path resolves, still run `lintDeterminism` on the source and merge its findings. Give load diagnostics `path`, `line` and `column`, parsed from the `file:line:col` suffix.
   - At launch, lint the source and throw `invalid_workflow` with the diagnostics before creating a run.
   - Expected effect: `Non Det` shows the name error and both lint lines at once. `{tool: []}` and `Date.now()` fail with exit 1 before a run exists, instead of producing a failed run with exit 2.
7. **Lint I/O in run() control flow.**
   - Where: validation.ts:66–70, next to the timer-import tracking at validation.ts:29–38.
   - Track names imported from `fs`, `fs/promises` and `child_process` (with or without `node:`), plus global `fetch`. Report calls outside `ctx.step` as `nondeterministic_call: readFileSync() is I/O; move it into ctx.step().`
   - Expected effect: `nondet.ts` fails validate instead of `workflow_failed: ENOENT…` at runtime. The guide's "validate flags the common mistakes" then covers I/O too.
8. **Hint the bundled TypeBox package.**
   - Where: loader.ts:68.
   - When the message matches `Cannot find module '@sinclair/typebox'`, say `import { Type } from "typebox" (bundled with pi-orchestration)`, and drop the `Require stack:` lines from load errors.
   - Expected effect: a one-edit fix instead of a search.
9. **Make lookup errors and exit codes match the help.**
   - Where: cli.ts:189–192 and engine/index.ts:222.
   - Add `unknown_signal`, `unknown_agent_option` and `unknown_context_member` to the exit-1 list.
   - Make the CLI rewrite `not_found` as `Unknown workflow run <id> in /tmp/axb1/h. List runs: workflow --home /tmp/axb1/h list.` Today it says `Use workflow list.`, the same `--home`-less hint that round one fixed elsewhere.
   - Expected effect: exit codes follow `--help`, and a copied hint reaches the same home.
10. **Say why the guide uses the full command.**
    - Where: link.ts:25–29 and guide.ts:46.
    - Return whether `workflow` is missing or belongs to another install, and print ``Shell: `workflow` on PATH is another install (/etc/profiles/…/workflow); use: node …/bin/workflow.mjs``.
    - Expected effect: models stop assuming the PATH `workflow` matches the tool's version, as session D did. This is low impact and mostly affects development checkouts loaded with `-e`.

## Other observations (not ranked)

- The `No model is set … agents fail` warning appears for workflows that run no agents (gate, nap, clock) (cli.ts:296, extension.ts:338).
- The brief view's `error` is `{reason, message}`, while CLI errors are `{"error":{"code","message"}}`. Tool errors have `details: {}`.
- Round one's polish items are still open: `Approval 0/0` for signal-only phases (presentation.ts:39), `1 agents`, unrounded `costUsd` (`0.0007460000000000001` in `status --verbose --json`), and `catalog` listing `~/.pi/agent/workflows` under a test `--home`.
- Environment: `pi` sessions get `out of extra usage` on `anthropic/*` while the worker's agents run on `anthropic/claude-haiku-4-5`. Both use Pi provider auth, so the difference is probably in the request path. It does not affect this package.
