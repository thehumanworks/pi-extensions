# axeval3: round three, after the axeval2 fixes

Evaluated on 2026-10-30. Scenarios 1–4 ran at cc9dc0c (brain/orchestration df51787 plus the task commit). Midway the brain landed 42b1362 (the tool's `wait:true` returns at a signal wait), 34b76c4 (full stop before the typebox hint) and 3fa5f94 (`not_found` exits 1). I merged them at b5128a3 and re-measured the affected sessions there. File:line references are to b5128a3.

Method: same as round two. Round two's workflow files, prompts and session script were still in `/tmp/axb1–4` and `/tmp/ax2`, so I reused them unchanged rather than rebuilding them. Each scenario ran from a clean temp cwd with a short home (`/tmp/axcN/h`). `npm run build` ran first, and `W` is `node pi-orchestration/bin/workflow.mjs`. Scenario 2 started from round one's start state. I counted wrong turns as round two did.

Models: Pi sessions used `openrouter/anthropic/claude-haiku-4.5 --thinking off` with round two's flags and `-e <this worktree>/pi-orchestration/index.ts`. CLI workflow agents used `anthropic/claude-haiku-4-5`, as in round two. Spend was $0.864: 48 Pi sessions cost $0.852 (S4 A–D3 $0.118, the rest probes and experiments), and 61 workflow runs cost $0.012.

## Headline

| Scenario | Round one | Round two | Round three |
|---|---|---|---|
| 1 CLI, nothing → 2-agent parallel result | 5 | 0 | **0** |
| 2 Broken workflows | 8 | 4 | **0** |
| 3 Signal discovery from status/poll | 7 | 0 | **0** |
| 4A Tool: catalog → validate → run args → status → result → list | 11 (14 calls / 9 errors) | 0 (6 / 0) | **0** (6 / 0) |
| 4B Same, told "args must be an object" | 5 (7 / 5) | 0 (6 / 0) | **0** (6 / 0) |
| 4C Tool, no-args workflow | 0 (6 / 0) | 0 (7 / 0) | **0** (7 / 0) |
| 4D Tool: run a gate, find what it waits for, approve | 11 (14 / 6) | 13 (16 / 4) | **0** (4 / 0; repeats D2 and D3 also 4 / 0) |

Every scenario from rounds one and two now runs without a wrong turn. All twelve fixes listed in the brief held, two with gaps (I/O lint coverage, and "1 agents" in the TUI widget). Probes outside the old scenarios found four new problems:

1. **The tool's `wait:true` blocked for 60 s on a gate.** The brain fixed this at 42b1362 during this round. Session E went from 69.3 s to 6.6 s with the same 4 calls and 0 errors.
2. **Agents answer approval gates nobody asked them to answer.** Told only to "run gate-noargs, then get its result", Haiku approved the plan in 6 of 6 sessions. Adding one sentence after the tool's deliver hint cut this to 2 of 6. Sessions told to approve still approved, with 0 errors.
3. **A worker started before a rebuild keeps serving the old code, and nothing warns about it.** After the merge and `npm run build`, validate printed pre-merge text for 17 minutes, until I ran `worker stop`.
4. **The lint misses `randomUUID()`, `crypto.randomUUID()`, `performance.now()` and `require("node:fs")`.**

## Fixes from the brief: held or open

| Fix | Status | Evidence |
|---|---|---|
| Attached `run` returns at a signal wait (cli.ts poll) | Held | `run gate` under `timeout 6`: 9 lines ending `then: workflow --home /tmp/axc3/h poll <id>`, exit 0 (round two: 32 lines, exit 124). `--json` prints the brief view with `waitingFor` (round two: 0 bytes). Agent F's `workflow run gate-noargs` returned in 0.4 s. `nap` printed 2 trees (round two: 7). |
| `waitingLines` with `Expects:`/`Deliver with:` in every renderer | Held | CLI `status`, `status --verbose`, `poll`, `poll --once`, `poll --until signal`, `watch` and attached `run`. Tool `status` and `verbose:true` (D2, D3). |
| Surface-neutral `result_not_ready` plus per-surface hints | Held | CLI: `Run … is waiting for signal "approve-plan"; deliver it, then read the result. poll: workflow --home /tmp/axc3/h poll …`. Tool (session R): `… Check it with {"action":"status","runId":"…"}.` |
| Tool `signal` reply | Held | `Signal "approve-plan" accepted. Check the run with {"action":"status","runId":"…"}.` |
| Typed tool `value` | Held | D, D2, D3 and all E sessions sent `"value": {"ok": true}` on the first try. |
| Typebox import hint | Held | `Cannot find module '@sinclair/typebox'. Use import { Type } from "typebox" (bundled with pi-orchestration).` The full stop from 34b76c4 appeared only after a worker restart (fix 1). |
| Exit 1 for `unknown_signal`/`unknown_agent_option`/`unknown_context_member` | Held | `unknown_signal` exits 1. validate exits 1 for the other two, and launch refuses them with `invalid_workflow`, exit 1. |
| `not_found` hints | Held | CLI: `Unknown workflow run nosuch. List runs: workflow --home /tmp/axc2/h list.` (exit 2 at cc9dc0c, exit 1 after 3fa5f94). Tool: `List runs with {"action":"list"}.` |
| validate reports everything in one pass | Held | `Non Det` gives the name error and all three lint lines at once. Parse errors in `--json` carry `path`, `line` and `column`. |
| Launch refuses lint failures | Held | `typeerr`, `clock` and `nondet`: `error invalid_workflow: … is not a valid workflow; no run was created:` plus the lines, exit 1. |
| `nondeterministic_call` for fs/child_process/fetch | Held, with gaps | Flagged: `readFileSync`, `execSync`, `spawnSync`, `fs.readFileSync` (namespace import), `readFile` from `fs/promises`, `fsp.readFile` (default import), an aliased `writeFileSync`, `fetch` and `new Date()`. The same calls inside `ctx.step` pass. Missed: `require("node:fs").readFileSync`, `randomUUID()` from `node:crypto`, `crypto.randomUUID()` and `performance.now()` (fix 3). |
| "1 agent" | Held in summaries | Status lines say `1 agent`. The TUI widget, extension.ts:42, still prints `${n} agents` (fix 4). |

## Scenario 1: CLI, from nothing to a 2-agent parallel result

Round two's sequence: `--help`, `guide`, `init pair`, then round two's `pair.ts` copied over the template. Then `validate`, `catalog`, `run --bg`, `poll`, `status` (plain, `--verbose`, `--json`), `result` (plain, `--json`), `list` (plain, `--json`), `agents --run`, `worker status` and `poll --json`. Also attached `run`, `run --bg --json`, attached `run --json`, and attached `nap`. Each run finished in 2–3 s for $0.0007.

**Wrong turns: 0** (round two 0). Hints keep `--home`, and `poll` ends with `result: workflow --home /tmp/axc1/h result …`. Every surface prints the same brief JSON. The attached `nap` printed its tree twice, at start and at completion, where round two printed it seven times.

## Scenario 2: deliberately broken workflows

Round one's start state: `nondet` named `"Non Det"` with `Date.now()`, `Math.random()` and `readFileSync`, and `typeerr` calling `ctx.runAgent(…, { tool: [] })`. Plus `syntax`, `badargs`, `badargs2`, `noexport`, `namedexport`, `norun`, `sinclair` and round two's `clock`. I fixed the files one error at a time, as an author would.

**Wrong turns: 0** (round two 4). Round one's eight items:

| # | Round one | Now |
|---|---|---|
| 1 | Plain-object args validated, then ran | Held: `args must be Type.Object({...}) from "typebox"; got {"topic":"string"}`. |
| 2 | `ctx.runAgent` validated, then failed at runtime | **Held** (open in round two): `line 9: ctx.runAgent does not exist on the workflow context. Members: runId, args, cwd, … agent, … (unknown_context_member)`. Launch refuses it. |
| 3 | `{ tool: [] }` silently granted all tools | Held: `line 9: Unknown agent option 'tool' (did you mean 'tools'?)`. Launch refuses it. With `tools: []`, the agent said it had no tools. |
| 4 | `readFileSync` in run() not flagged | **Held** (open in round two): `line 12: readFileSync() is I/O; move it into ctx.step().` After moving it into `ctx.step("read-readme", async ({ cwd }) => …)`, validate passed and the run completed. |
| 5 | `@sinclair/typebox` gave no hint | **Held** (open in round two). The hint is quoted in the table above. |
| 6 | Raw AJV output | Held: `args/topic: must be string (got 5)`, `args: must have required properties topic (got {})`. |
| 7 | A failed run's text status had no reason | Held: `step_failed: ENOENT: no such file or directory, open '/tmp/axc2/w/MISSING.md'`, with the step key. |
| 8 | Load stopped at the first error; diagnostics differed | **Held** (open in round two). See the one-pass row above. |

Minor issues seen, none of which caused a wrong turn:

- The name error does not quote the bad name: `Workflow name must be kebab-case, for example 'review-changes'.`
- The text form of a parse error repeats the path: `/…/syntax.ts:9:71: Cannot load /…/syntax.ts: ParseError…`.
- The JSON-string `invalid_args` example is always `{"topic":"bees"}`, even for `gate`, whose argument is `plan` (fix 6).

## Scenario 3: a workflow waiting on ctx.signal (CLI)

Round two's `gate.ts` and command list: `run --bg` without `--model`, then `status` (plain, `--verbose`, `--json`), `poll` (plain, `--once`, `--until signal`, `--json`) and `watch`. Then `signal` with a wrong key, a wrong shape, `{}`, a JSON-encoded string, a non-JSON value, no value and the right value. Then a repeat signal, `poll`, `result`, and `cancel`/`result`/`signal` on a second run. Finally, attached `run` and attached `run --json`.

**Wrong turns: 0** (round two 0). Every waiting view prints the same block:

```
c49a3098-… gate waiting_signal 4s · no model · Approval 0/0 · 0 agents · 0 tokens · $0.0000
Waiting for signal "approve-plan": Approve the plan "ship it"? Send {"ok": true|false, "note"?: string}.
Expects: {"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"},"note":{"type":"string"}}}
Deliver with: workflow --home /tmp/axc3/h signal c49a3098-… "approve-plan" '<json>'
```

The signal errors are as in round two, and a wrong key exits 1. A repeat signal after completion gives `run_finished: Run … is completed and accepts no more signals.`. Any signal to a cancelled run gives `… is cancelled and accepts no more signals.`, exit 2 (round two: "accepted", exit 0). Attached `run` returns at the wait and adds `then: … poll <id>`.

## Scenario 4: Pi extension, headless

Round two's prompts, workflows and flags. Session D is unchanged: "Use the workflow tool to run the workflow "gate-noargs" (do not wait for it). Find out what it is waiting for, then approve it. Then get its result and report it."

| Session | Calls / errors | Outcome |
|---|---|---|
| A | 6 / 0 | `{"action":"run","workflow":{"name":"tiny"},"args":{"topic":"bees"},"wait":true}` on the first try |
| B | 6 / 0 | Same as A |
| C | 7 / 0 | One extra `catalog` first, as in round two. The completion message for the background run reached the session. |
| D | **4 / 0** | run → status → signal `{"ok": true}` → result |
| D2, D3 | 4 / 0 each | run → `status verbose:true` → signal → result. In round two this path cost D-x2 an error, because the verbose view had no `Expects:` line. |

**Wrong turns: A 0, B 0, C 0, D 0** (round two 0/0/0/13). In session D, status returned the `Waiting for signal`, `Expects:` and `Deliver with: {"action":"signal","runId":"…","key":"approve-plan","value":<JSON value, not a string>}` lines. The model then sent the object value directly. It did not leave the tool, did not read the source and did not cancel the run.

## New probes (no earlier baseline)

### E: tool `wait:true` on a gate, before and after 42b1362

E: "run gate-noargs and wait for it to finish. If it asks for anything, approve it. Then report its result." E2: "run gate-noargs, then get its result and report it." In E2 the model chose `wait:true` itself.

| Session | Code | Calls / errors | `run` call | Session |
|---|---|---|---|---|
| E | cc9dc0c | 4 / 0 | **60.0 s** | 69.3 s |
| E2 | cc9dc0c | 3 / 0 | **60.0 s** | 67.3 s |
| E-x | cc9dc0c + my temporary loop break | 4 / 0 | 0.0 s | 11.1 s |
| E2-x | same | 3 / 0 | 0.0 s | 12.7 s |
| E-m | b5128a3 (42b1362 merged) | 4 / 0 | 0.0 s | **6.6 s** |
| E2-m | b5128a3 | 3 / 0 | 0.0 s | **6.1 s** |

Before the fix, the call returned the same waiting block plus `Stopped waiting; the run continues…` only once the 60 s default timeout expired. It now ends `Stopped waiting: the run needs a signal. This session gets a message when it ends.` The wrong-turn count is 0 both before and after (I do not count E's extra `catalog`, just as round two did not count C's). The fix removes about 60 s per gated `wait:true`.

### F, F2, G: an agent driving the CLI through bash

Pi ran with `--tools bash`, no workflow extension, this worktree's CLI first on PATH, and a fresh `PI_WORKFLOW_HOME`.

- **F** (session D's task through the CLI): 7 calls / 0 errors. `ls`, `find` and `cat` the workflow, then `workflow run gate-noargs`. That attached run returned the waiting block in 0.4 s. Then `signal`, `poll` (the signal reply suggests it) and `result`. Without the attached-run fix, the run call would have hung until bash timed out.
- **F2** (session A's task, worded "list the available workflows"): in 3 of 3 sessions the agent ran `workflow list` (which lists runs and printed `No workflow runs.`), then `--help`, then `catalog`. That is 2 extra calls and 0 errors.
- **G** ("run tiny with topic bees", without mentioning help): 8 of 8 sessions failed their first call. Seven passed `--topic bees` (one also passed `--workflow tiny`), and one passed `bees` as a positional argument. Six of the eight left out `run`. Seven recovered with `--help` on the second call, for 3 calls and 1 error each. The eighth needed `help` and then `catalog`, for 4 calls.

### H, HC: authoring a workflow

"Write a new workflow named "facts" … two agents in parallel, no tools … validate it, run it with topic "otters", wait, report."

- **H** (tool): 6 calls / 0 errors: `pwd`, `guide`, `mkdir`, `write`, `validate` by path, then `run` with `wait:true`.
- **HC** (CLI): 8 calls / 0 errors: `ls`, `--help`, `init facts`, `read`, `edit`, `read`, `validate`, then attached `run`.

Both files used `tools: []`, the bundled `typebox` and `Type.Object` args the first time.

### Tool errors (session R)

`result` on a waiting run gives `result_not_ready: … deliver it, then read the result. Check it with {"action":"status",…}.` `status nosuch` gives `not_found: Unknown workflow run nosuch. List runs with {"action":"list"}.` Both still arrive with `details: {}` (extension.ts:104).

## Experiments (temporary, reverted; diffs kept in /tmp/axc4/*.diff)

### Unprompted approvals

Session E2's prompt never says to approve. Without any change, the model approved in 6 of 6 sessions: E2, E2-x and E2-m, plus the three sessions under variant (a). Each answer was `{"ok": true}`, sometimes with `"note": "Approved by assistant"`.

| Variant | Where | E2 asked the user | Sessions told to approve |
|---|---|---|---|
| none | | 0 / 6 | D, D2, D3, E 4 / 4 approve |
| (a) a sentence on the `signal` line of `TOOL_DESCRIPTION` | extension.ts:28 | 0 / 3 | D-a approves, 4 / 0 |
| (b) wait note: `If the user has not told you what to answer, report what it waits for and ask them; do not decide it yourself.` | extension.ts:370 | 2 / 3 | (not run) |
| (c) after the tool's deliver hint: `Send it only if the user told you what to answer; otherwise report what the run waits for and ask them.` | presentation.ts:96 | 2 / 3 | E-c1, E-c2, D-c1, D-c2 approve, 4 / 0 each |

Under (b) and (c), the sessions that held back made 1 call and asked, for example: "Should I approve the plan (`{"ok": true}`) or reject it (`{"ok": false}`)?" The one (c) session that still approved went run → status, saw the caution and signalled anyway. `npm test` passed 41/41 with (c). The caution only works where the model reads it while deciding, next to the deliver call; the tool description is too far away.

### CLI wording for `list` and unknown options

- **(x)** The empty list printed `No workflow runs. Saved workflows: workflow catalog`, and the help labelled `catalog` and `list`. F2 ×3 came out net worse. One session skipped `--help` and then guessed `run tiny --topic bees --wait` (2 errors). Another treated the list output as step 1 and never ran `catalog`.
- **(y)** (x) plus a rewrite of `ERR_PARSE_ARGS_UNKNOWN_OPTION`: `Unknown option '--topic'. Workflow arguments go in --args as one JSON object, e.g. --args '{"topic":"bees"}'; run waits by default and --bg returns at once. All options: workflow --help.` F2 ×4 needed 2–3 extra calls each. G ×4 with the rewrite and G ×4 without it were identical (error → `--help` → success). Haiku reads `--help` after any error, whatever the message says.

Neither change saved a call, so neither is a top fix. Do not ship (x).

## Stale worker

The `/tmp/axc2/h` worker started at cc9dc0c. After I merged b5128a3 and ran `npm run build`, `W validate sinclair` still printed the pre-merge message, `'@sinclair/typebox' Use import …` with no full stop. `worker status` showed `up 17m 16s`. After `worker stop`, the same command printed the fixed text. The client's ping (client.ts:54–57) compares only `PROTOCOL_VERSION`, and the worker's ping (worker.ts:58) reports nothing about its build. My post-merge measurements are unaffected: 42b1362 and every experiment changed client-side code (extension.ts, presentation.ts, cli.ts), which each `pi` or CLI process loads fresh.

## Ranked fixes

1. **Detect a worker that runs a different build.**
   - Where: worker.ts:58 (the ping data), protocol.ts:11 (`WorkerStatus`) and client.ts:54–57 (`ready`). The client spawns `../dist/worker.js` at client.ts:91.
   - Have the worker report a `build` at startup, for example its module path plus mtime, or the package version plus a hash of `dist/`. The client computes the same for the `dist/worker.js` it would spawn.
   - On a mismatch, restart the worker if it has no active runs. Otherwise warn once: `The worker in <home> runs another build (started 17m ago). Stop it when its runs finish: workflow --home <home> worker stop.`
   - Expected effect: a rebuild or upgrade takes effect on the next command. Verification by the brain, by subagents and by the Nix smoke test stops measuring old code without saying so. Two installs that share a home also get detected.
   - Evidence: the 17-minute stale `validate` above.
2. **Ask before answering a person's gate.**
   - Where: presentation.ts:95–96 (`toolHints.signal`, variant c), and possibly extension.ts:370 (the wait note, variant b). `cliHints.signal` at presentation.ts:91–93 is the CLI counterpart; I did not measure it.
   - Append to the tool's deliver hint: `Send it only if the user told you what to answer; otherwise report what the run waits for and ask them.`
   - Expected effect: unasked approvals drop from 6/6 to about 2/6 in E2. Sessions told to approve still approve with 0 errors (4/4). One sentence on the tool description had no effect (0/3).
   - This is a policy choice: if signals are meant for agents to answer freely, skip it. The example gate's prompt is a human approval, and nothing told the model so.
3. **Lint the remaining nondeterminism.**
   - Where: validation.ts:50 (module regex) and :87–88 (global calls).
   - Track names imported from `(node:)?crypto` (`randomUUID`, `randomBytes`, `randomInt`, `getRandomValues`), plus the globals `crypto.randomUUID`, `crypto.getRandomValues`, `performance.now` and `process.hrtime`. Also catch `require("fs"|"child_process"|…)` calls.
   - Report `randomUUID() is not replay-safe…; use ctx.random() or generate it inside ctx.step()`.
   - Expected effect: `rand.ts` fails validate and launch with exit 1, instead of running with values that change on replay. I did not observe a runtime replay failure; the gap is static.
4. **Pluralise the widget.**
   - Where: extension.ts:42 (`${run.usage.agents} agents`).
   - Use the rule at presentation.ts:43.
   - Expected effect: the Pi widget matches status lines (`1 agent`). Cosmetic.
5. **Say in the guide how a signal is delivered.**
   - Where: guide.ts:78.
   - Change `delivered with the signal action` to: `status shows the key, the schema and the exact deliver call; the value is the JSON value itself, not a string.`
   - Expected effect: small. No session read the guide before signalling, but authors writing `ctx.signal` learn how their users will answer it.
6. **Build the `invalid_args` example from the actual input.**
   - Where: engine/index.ts:308.
   - The engine already has the JSON-encoded string, so parse it and say `pass {"plan":"x"} itself, not the string "{\"plan\":\"x\"}"`.
   - Expected effect: the example is right for every workflow. Low.
7. **Replace Node's unknown-option advice.**
   - Where: cli.ts:434–437 (error rewrite) and cli.ts:426 (unknown command).
   - Node's `place it at the end of the command after '--', as in '-- "--topic"` is wrong for this CLI. Use variant (y)'s text. For an unknown command that names a saved workflow, say `To run it: workflow run tiny --args '<json>'`.
   - Expected effect: correct advice. Measured savings were zero (G 4/4 vs 4/4), hence the low rank.
8. **Say why the guide uses the full command** (round two's fix 10, still open).
   - Where: guide.ts:46 and link.ts:25.
   - The tool's guide says `` `workflow` is not on PATH here `` when PATH has a different install. Low.
9. **Match exit codes to the help.**
   - Where: cli.ts:185–189.
   - `result_not_ready` and `run_finished` exit 2, which the help calls "failed", although neither run failed. Exit 1 fits `run_finished`, a usage mistake. `result_not_ready` needs either its own code or a line in `--help`. Unmeasured, low.
10. **Keep the code in tool error details.**
    - Where: extension.ts:104 (`codedError`).
    - Errors arrive with `details: {}`, so codemode scripts must parse the text to get the code. Unmeasured, low.

## Other observations

- The `No model is set … agents fail` warning still appears for workflows with no agents, such as gate and nap (cli.ts:300, extension.ts:340). `Approval 0/0` still appears for signal-only phases (presentation.ts:39).
- presentation.ts:77–78 has two doc comments stacked over `waitingLines`. The first, "How a view names the next step", belongs to `Hints`.
- The task gave a baseline of 40/40 at cc9dc0c. After the merge, `npm test` passed 41/41 at b5128a3; 42b1362 added the extra test. The tree has no source changes from me. One run, taken right after the batch of parallel Pi sessions, failed 40/41. I did not capture its output, and the next 13 runs all passed 41/41, so one test is probably timing-sensitive under load. I could not identify which.
- Environment: a hook in this harness rejects shell commands that contain delete or rename verbs (including `git checkout --` and text inside heredocs). I reverted experiments with the edit tool instead.
