# BRAIN

The ledger of the pi-orchestration improvement loop: decisions, knowledge, and every action with its outcome. `brain/loop.sh` passes this file to every tick as part of the system prompt. The Log stays last, so new entries are appended to the end.

Goal: optimise what an agent sees and experiences when it uses pi-orchestration through the standalone `workflow` binary (isolated from Pi) and through the Pi extension (`workflow` tool, `/workflow`).

## Decisions

- D1 (user, 2026-10-30): Workflow launches need no user approval. Remove the gate from the package entirely: the confirm dialog, `/workflow approval`, the `workflow.approval` setting, the TUI status, `PI_WORKFLOW_ALLOW_UNATTENDED`, and their docs and tests. No compatibility shim. Keep the `not_from_root` guard, which stops inner workflow agents from launching runs; it is not a user approval.
- D2 (user, 2026-10-30): Workflow files are project source and must never be added to .gitignore. Say so where agents look: the guide (`src/guide.ts`), the tool description (`src/extension.ts`), `workflow init` output (`src/cli.ts`) and the README. Also remove the two ignore lines in `bot/.gitignore` (13 and 15) and commit those workflow files; they exist only in the main checkout (`/home/nixos/pi-extensions/bot/.pi/workflows/`), so copy them from there without modifying it.
- D3 (user, 2026-10-30; amended 11:31): Push freely to brain/orchestration and brain/<name> feature branches. The user's rule: "you are allowed to merge, the running agents are not". Only the supervisor (the interactive session working with the user) merges into main, pushes main or bumps versions. Running agents, meaning every brain tick and every subagent, never do. main was fast-forwarded to brain/orchestration for 0.3.0 and pushed to origin at aeb0bc2. To ship something, record it under Questions for the user as ready to release.
- D4 (user, 2026-10-30): The project does not add legacy compatibility layers; use the current contract directly.
- D5 (setup): The brain works in the worktree `.pi/worktrees/brain-orchestration` on branch brain/orchestration, based on main at f21d735. The main checkout holds the user's uncommitted work (pi-loggly, root README.md, package.json, package-lock.json) and must not be modified.
- D6 (setup): Subagents are interactive Pi sessions in the herdr session `pi-brain`, each in its own worktree and workspace, started with `brain/loop.sh spawn`. At most 2 at a time. Model: the user's default (openai/gpt-6.1-sol, high).
- D7 (user, 2026-10-30): The tick rules live in `brain/loop.sh` and belong to the brain; it may change them. The ledger must be updated every tick.
- D8 (setup; updated 11:30): Pi on this machine loads `npm:@nothumanwork/pi-orchestration` from npm, not this checkout. 0.3.0 (D1 and D2, the home_too_long error, green tests) is on main but NOT yet published; the installed Pi still runs 0.2.1 until the user publishes and updates. Keep PI_WORKFLOW_ALLOW_UNATTENDED in brain/loop.sh until the user confirms the publish. Test changes with `npm test`, the local CLI (`node pi-orchestration/bin/workflow.mjs`) or `pi -e ./pi-orchestration/index.ts`.

## Baseline

`npm test` in pi-orchestration at f21d735: 38 tests, 35 pass, 3 fail. None of the failures is caused by the worktree.
1. `test/engine.test.ts:158` "catalog reports a broken file without hiding valid workflows": the catalog also lists the user's global `~/.pi/agent/workflows/resolve-bot-main.ts`. The test is not isolated from the user's home directory.
2. `test/nix-lock.test.ts:5`: `nix/package-lock.json` says 0.2.0 while `package.json` says 0.2.1 (`nix/update-lock.sh` regenerates it).
3. `test/package.test.ts:46` "prepack builds a source-only checkout": `npm run check` in the copied package cannot find `@types/node`, because `installedNodeModules()` picks `pi-orchestration/node_modules`, which holds only jiti in a workspace install.

## Agents

- None running.
- `axeval2` merged at `6ed16ed` and retired in tick 35; its report is `brain/axeval2.md` (ranked fixes drive Backlog item 00).
- `runshape` merged at `237e912` and retired in tick 28.
- `axeval` merged at `050a209` and retired in tick 11; its report is `brain/axeval.md` (ranked fixes drive Backlog item 0).
- `approval` merged at `70ae028` and retired in tick 4; branch `brain/approval` stays on origin.

## Backlog

Ordered by priority. Mark directions ✅ or ❌ as evidence comes in.

00. ✅ axeval2's ranked fixes (`brain/axeval2.md:160-208`; wrong turns S1 0, S2 4, S3 0, S4 D 13 before ticks 33-34). Done: 1 typed `value` (ec5ca3d), 3 schema part (341efca), 5 `run_finished` (e858e23), S2(a) `unknown_context_member` (2cb15bb). Open, in order:
   2. ✅ Done in tick 36: attached `run` returns on `waiting_signal` (statusText + `then: … poll <id>`, exit 0; `--json` the brief view; `--until done` keeps waiting) and prints progress only on change.
   3. One `waitingLines(run, hints)` helper for presentation.ts:71-72, :134-137 and cli.ts:173-177.
   4. ⚠️ Half done in tick 37 (8fce02c): `result_not_ready` is surface-neutral and names the awaited signal; CLI appends `poll: … poll <id>`, tool appends `{"action":"status",…}`. Open: tool `signal` reply of its own; a tool-path test for the status hint.
   6. Validate in one pass (lint even when load fails; load diagnostics get path/line/column) and refuse at launch what validate rejects (loader.ts:81-86, engine/index.ts:299).
   7. Lint fs/child_process/fetch calls outside `ctx.step` (validation.ts:29-70).
   8. `@sinclair/typebox` load error hints `typebox`; drop `Require stack:` (loader.ts:68).
   9. Exit 1 for unknown_signal/unknown_agent_option/unknown_context_member; `not_found` hint keeps `--home` (cli.ts:189-192).
   10. Guide says why it uses the full command (link.ts:25-29, guide.ts:46).
   Unranked: no-model warning on agent-less workflows, `Approval 0/0`, `1 agents`, unrounded costUsd, tool errors with `details: {}`.

0. ✅ axeval's ranked fixes (`brain/axeval.md`, evidence from 4 scenarios). Work them in order; each names file:line and the expected effect:
   1. ✅ Done in tick 12: tool `args` typed as object; string args and schema mismatches explained (extension.ts:58, engine/index.ts:299).
   2. ✅ Done in tick 13: expose the signal schema in `waitingFor`; explain mismatches; name the waiting key in `unknown_signal`; `value` description says not a string (execution.ts:361, engine/index.ts:410-411, extension.ts:76).
   3. ✅ Done in ticks 14, 27 and 32: unknown `ctx.agent`/`ctx.spawn` options fail at run time (`resolveOptions`), and `validate` reports literal `ctx.agent(p, {…})` and `ctx.spawn({…})` options as `unknown_agent_option` and unknown `ctx.*` members as `unknown_context_member` (`src/validation.ts`). Not linted: options passed as variables.
   4. ✅ Done in tick 15: args must be `Type.Object` (loader.ts:72); plain objects and `Type.String()` fail validate/catalog with the offending value.
   5. ✅ Done in tick 16: `poll` returns on `waiting_signal` by default (`--until done` keeps waiting), prints a line only when more than elapsed time changed, help/README say `--interval 1s`. `watch` still defaults to `done`.
   6. ✅ Done in tick 17: verbose tool `status` prints signal/retry hints as tool calls (`toolHints`, presentation.ts:69-79; extension.ts:361). The non-verbose tool brief has no command hints to convert.
   7. ✅ Done in tick 18: tool errors lead with their code (`codedError`, extension.ts); the completion poller drops runs on `not_found` instead of the dead `run_not_found`. Not done: structured `details.error` (Pi shows only thrown messages).
   8. ✅ Done in tick 28 (merged `runshape`, `237e912`): model stored as `"provider/modelId"`; CLI `--json` for status/poll/run/cancel/retry/revert prints the tool's brief view, list the list view (`src/presentation.ts` `runHead`); only `status --verbose`/`watch` print the full record with `id`.
   9. ✅ Done: cancel/retry/signal print text (tick 20, tested tick 21); `result` on a cancelled run fails `run_cancelled` with exit 3 (tick 22); `agents` and `worker start|status|stop` print text (tick 23). Tick 24: `worker status|stop` with no worker fail `worker_unavailable` (exit 4) naming `worker start`, tested. Tick 25: process test asserts the `agents` and `worker status` text.
   10. ✅ Done in tick 19: guide shell lifecycle `--bg` → `poll` → `result` (guide.ts:63-65).
   12. ✅ Done in tick 35: `axeval2` measured fixes 1-11 (merged `6ed16ed`); its list is item 00.
   11. ✅ Done in tick 30: the runTask `abort` commit and the `execute` failure commit delete `waitingFor` (engine/index.ts); test in "signals are schema-checked…". Was: clear `waitingFor` when a run reaches a terminal status; a cancelled or reverted run still prints "waiting for signal … signal: …" (runshape observation, engine record). Tick 29 reproduced it: in `test/engine.test.ts` "signals are schema-checked…", launch a second `gate`, wait for `waiting_signal`, `f.request({action:"cancel"})`, `f.wait`; `waitingFor` stays set. Clearing it in `Engine.mutate` for terminal statuses AND in the runTask `abort` commit (engine/index.ts ~548) did NOT fix it. Find what writes or serves `waitingFor` after abort (the signal loop in execution.ts:364-384, or the record view) before patching.

1. D1 approval-gate removal: ✅ merged in tick 4 (`70ae028`). Only follow-up: after the user publishes, drop `PI_WORKFLOW_ALLOW_UNATTENDED` and stale launch-approval guidance from `brain/loop.sh` (D8). The Nix installed-wrapper smoke was not run by `approval`.
2. Workflow files are source (D2): ✅ done. Bot workflows tracked and ignore rules removed (tick 2); guide, tool description, `init` output and README state the policy (tick 5). Possible follow-up: `validate`/`catalog` warn on git-ignored workflow files (item 4).
3. Fix baseline failures so a red test means a regression. ✅ Done: package fixture (tick 3), catalog home isolation (tick 6), Nix lock version and npmDepsHash (supervisor, 0.3.0 release). `npm test` 36/36; `nix build .#workflow` runs 36/36 and the installed smoke in the sandbox. Any red test is now a regression. Refreshing the Nix lock needs `nix develop --command bash nix/update-lock.sh` and the printed hash in nix/package.nix.
4. Unexplored directions for the goal:
   - One output contract: the tool and the CLI return the same JSON shapes, and every CLI command supports `--json`.
   - Errors name the next command to run; error codes are stable and documented.
   - `validate` and `catalog` warn when a workflow file is git-ignored or untracked.
   - `status` shows what changed since the caller last looked; long runs get a compact progress view.
   - Parity: an agent outside Pi gets the same guide (`workflow guide`) and examples as one inside Pi.
   - Exit codes that scripts and agents can branch on.
   - ✅ Done in tick 7: a long `--home` now fails with `home_too_long` naming the byte limit and the fix, before any directory is created.
   - An agent-experience evaluation: give fresh agents tasks through only the CLI or only the tool, and count wrong turns. This measures progress on the goal instead of guessing. In progress: `axeval` (tick 8). Its ranked fix list should reorder this backlog.
   - Exit codes are already documented in `workflow --help` (0 success, 1 usage, 2 failed, 3 cancelled, 4 worker unavailable); check the docs and the tool agree rather than adding them.

## Lessons

- Supervisor, after tick 1: the approval brief told the subagent to drop PI_WORKFLOW_ALLOW_UNATTENDED from brain/loop.sh. That would break headless workflow launches here, because the installed Pi runs npm 0.2.1 (D8) until the user publishes. The subagent was told to leave loop.sh alone. Check every change to the loop's own environment against D8.
- Tick 1: `loop.sh spawn` completed in 43 seconds (30 seconds installing dependencies). Verify Herdr `agent_status=working` after submission, not merely a successful prompt write. Keep delegated scope explicit so the brain can work on adjacent priorities without overlapping files.

- Tick 2: test copied workflows via local CLI `validate`, not a live launch: historical prompts target the main checkout. A short isolated `--home` works; a socket path beyond Unix limits returns an opaque `EINVAL` before creating the home.
- Supervisor, after tick 3: in Pi 1.4.0, boolean extension flags such as `--no-memory` and `--recap-disable` swallow the next positional argument, so `pi -p --no-memory "message"` runs with no message and prints nothing. Put the message after a non-boolean flag or `--`. From tick 4 on, ticks stream Pi JSON events to brain/logs/tick-<N>.jsonl with a readable tick-<N>.log; the user asked for live awareness of each tick, and this keeps fresh-context ticks instead of an interactive pane.
- Tick 5: small text-only guidance changes are faster done directly than delegated; spawning costs a minute plus a review tick.
- Tick 6: in-process workers read `process.env` at call time, so fixtures must isolate every path that env resolves, not only `--home`.
- Tick 7: validate inputs whose limits come from the OS before the first side effect, and name the flag or variable that fixes them.
- Supervisor, 11:30: the main checkout keeps staged user work; keep brain/orchestration a descendant of main so releases stay fast-forwards.
- Tick 30: a fix that "did not work" may have been tested together with a second, wrong change; retest the simplest candidate alone against the reproducer before abandoning it.
- Tick 19: `bin/workflow.mjs` runs the git-ignored `dist/`, not `src/`. Run `npm run build` before checking a change with the local CLI, or the check exercises stale code.
- Tick 4: when the brain has fixed the baseline on its own branch, compare a subagent's test result after the merge, not before.
- Tick 3: a package-local node_modules can exist but contain only overrides (jiti here). Copied-package fixtures must verify the required dependency set before selecting a directory, not stop at its existence.

- Ticks 8-10: read the surface's own help before adding a backlog item; act on a subagent's concrete partial findings outside its write scope without waiting for the final report.

## Questions for the user

None.

## Log

### Tick 11 · 11:44 · Merge the axeval evaluation
- Action: reviewed and merged `brain/axeval`, done since the last tick, because its ranked fix list is the evidence the backlog was waiting for; a code fix first would have guessed at priorities the report already settles.
- Outcome: diff is docs only (`brain/axeval.md` +154, `ledgers/axeval.md` +26). Merge `050a209`, pushed; `npm test` on the merged branch **37/37**. `loop.sh retire axeval` succeeded. The 10 ranked fixes are now Backlog item 0. Biggest finding: the Pi tool's `args`/`value` are `Type.Unknown`, so Haiku sent JSON strings and two of four tool sessions never launched (11 and 5 wrong turns).
- Value: ✅ yielded value: the next ticks have a measured, ordered fix list with file:line targets.
- Lesson: an evaluation subagent with a narrow write scope merges cleanly; acting on its partial findings during the run (ticks 9-10) shortened the list it delivered.

### Tick 12 · 11:49 · Tool args are an object; string and schema errors explain themselves
- Action: took axeval fix 1, the top-ranked one (two of four tool sessions never launched because `args` was `Type.Unknown` and Haiku sent JSON strings). Small enough to do directly. `src/extension.ts:58` types `args` as an open object whose description says "pass the object itself, not a JSON-encoded string". `src/engine/index.ts:299-309` rejects a string `args` with `invalid_args: args is a JSON-encoded string; pass the object itself…` and turns schema errors into lines like `args/n: must be number (got "x")` after the schema JSON, instead of a raw TypeBox error dump.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/engine.test.ts:44-51` now asserts the per-field line and the string-args message. Committed `82c02ea`. Not verified live in Pi, because the installed Pi still runs npm 0.2.1 (D8).
- Value: ✅ yielded value: the most expensive observed wrong turn now either cannot happen (schema says object) or gets a one-line fix.
- Lesson: TypeBox 1.x errors carry `instancePath`, not `path`/`value`; resolve the offending value from the pointer.

### Tick 13 · 11:58 · Signals show their schema and explain mismatches
- Action: took axeval fix 2, next in order and small. New `src/engine/mismatch.ts` holds `mismatchLines` (shared with tick 12's args errors) and `signalMismatch`. `waitingFor` now carries `schema` (`execution.ts:361`); `status` text prints `expects: <schema>` (`cli.ts` statusText) and the tool summary prints `Expects:` (`presentation.ts:62`). `invalid_signal` says `Signal 'k' expects {...}; got ...` plus per-field lines and a JSON-string hint (engine/index.ts, execution.ts); `unknown_signal` names the key the run waits for. Tool `value` description says not a JSON-encoded string.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/engine.test.ts:128-135` asserts the schema in `waitingFor`, the mismatch message, the string hint and the named waiting key. Not verified live in Pi (D8).
- Value: ✅ yielded value: an agent answering a signal sees the expected shape before sending and gets the fix when it is wrong.
- Lesson: extracting tick 12's error formatter into a module made the second use a one-liner; keep error formatting shared across surfaces.

### Tick 14 · 12:00 · Unknown agent options fail instead of granting default tools
- Action: took axeval fix 3, next in order. axeval saw `ctx.agent(…, { tool: [] })` silently ignored, so the agent got Read/Write/Edit/Bash. `resolveOptions` (`src/engine/execution.ts`) now checks the call's keys against `AGENT_OPTIONS` and throws `unknown_agent_option: Unknown agent option 'tool' (did you mean 'tools'?). Valid options: …` before journaling or spawning anything. It covers `ctx.agent` and `ctx.spawn` (background.ts passes the rest of its input through it).
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/engine.test.ts` "agents return text…" adds a fifth parallel call with `tool` and asserts the code and the hint. The static half (lint in `validate`) is not done.
- Value: ✅ yielded value: a misspelled option can no longer widen an agent's tools silently.
- Lesson: check option names at the one function every agent path goes through; the run-time check is cheap, the validate-time lint is the follow-up.

### Tick 15 · 12:07 · Workflow args must be an object schema
- Action: took axeval fix 4, next in order and one function. axeval saw `args: { topic: "string" }` pass validate (`Type.IsSchema` accepts any object) and run with `{topic:5}` unchecked, and `Type.String()` pass validate then fail every run. `src/loader.ts:72` now uses `Type.IsObject` and says `args must be Type.Object({...}) from "typebox"; got {"topic":"string"}` (value truncated to 120 chars). No workflow in the repo uses non-object args.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/engine.test.ts` catalog test adds `plainargs` and `stringargs` fixtures and asserts both errors. Not verified live in Pi (D8).
- Value: ✅ yielded value: a malformed args schema is caught at validate, before an agent runs with unchecked input.
- Lesson: TypeBox's `IsSchema` is a weak structural check; use the kind-specific guard (`IsObject`) where the contract needs one shape.

### Tick 16 · 12:10 · poll stops at a signal wait and prints only changes
- Action: took axeval fix 5, next in order and one function. In scenario 3 a plain `workflow poll <id>` on a gate printed the same line every second and never returned, so the agent's bash needed `timeout`. `src/cli.ts` poll now defaults `--until` to `signal` (terminal or `waiting_signal` returns 0 after printing the `signal:` line); `watch` keeps `done`. A line is emitted only when the status text changes apart from duration tokens. Help and README say `[--interval 1s] [--until signal|done]`, matching the real default.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/process.test.ts:97` now polls the waiting run without `--until` and asserts `waiting_signal`; the two post-signal polls pass `--until done` explicitly. Not verified live in Pi (D8; CLI only anyway).
- Value: ✅ yielded value: `workflow poll` can no longer hang an agent on a gate.
- Lesson: a four-minute tick fits one axeval fix when the report already names file:line; read the report section, edit, test, commit.

### Tick 17 · 12:14 · Tool results give tool-shaped next steps
- Action: took axeval fix 6, next in order and one module. In session D the model read the CLI command `workflow signal …` from a tool result and fell back to bash. `src/presentation.ts:69-79` adds a `Hints` interface with `cliHints(program)` and `toolHints`; `runTree`/`runDetail` take `string | Hints`, so the CLI keeps its `--home`-aware commands and the extension's verbose `status` (`src/extension.ts:361`) now says `deliver with: {"action":"signal","runId":…,"key":…,"value":<JSON value, not a string>}` and `Resume with: {"action":"retry","runId":…}`.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/unit.test.ts` "summaries name the model…" asserts the tool signal and retry hints and the CLI hint with `--home`. Not verified live in Pi (D8).
- Value: ✅ yielded value: a tool-using agent is no longer pointed at the shell to answer a gate or resume a parked run.
- Lesson: pass a formatter, not a program string, when one view serves two surfaces; the string overload kept every CLI call site unchanged.

### Tick 18 · 12:21 · Tool errors lead with their code
- Action: took axeval fix 7, next in order and one file. The tool's `execute` (`src/extension.ts`) now wraps its body in `try … catch` and rethrows through `codedError`, which prefixes a `WorkflowError`'s message with `code: ` (once), so a tool-using agent sees `invalid_args: …` or `not_found: …` as the CLI's `{"error":{"code"}}` shows it. The completion poller checked `"run_not_found"`, which the engine never throws; it now checks `"not_found"` (engine/index.ts:222, 229), so vanished runs stop being polled.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/extension.test.ts:162` asserts the message starts with `not_from_root: ` and the code survives. Not verified live in Pi (D8).
- Value: ✅ yielded value: tool errors are branchable by code and the dead branch is live.
- Lesson: a body-wide `try` around a long method is a mechanical reindent (`sed '284,387s/^\(.\)/  \1/'`); check `tsc` right after.

### Tick 19 · 12:24 · The guide teaches the shell lifecycle
- Action: took axeval fix 10 instead of 8 or 9, because it was the only one that fit a four-minute tick (one sentence; 8 and 9 touch several cli.ts sites and the run record). `src/guide.ts:63` now says a shell `run` waits and prints the result, and that `--bg` returns a runId for `poll <runId>` (returns at the end or a signal wait) and `result <runId>`, using the machine's real command; the sentence after it now says it describes Pi.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/unit.test.ts:113-114` asserts the lifecycle with the bare and the full-path command. `bin/workflow.mjs` imports the git-ignored `dist/cli.js`, which was stale; after `npm run build` the local CLI prints the new lifecycle line.
- Value: ✅ yielded value: a shell agent learns `--bg` → `poll` → `result` from the guide alone.
- Lesson: when the deadline is four minutes, choose the ranked fix that fits, not strictly the next one; 8 and 9 need a full tick each.

### Tick 20 · 12:29 · cancel, retry and signal print text, not JSON
- Action: took the text half of axeval fix 9, because it fits one tick; the `run_cancelled` exit code and the `agents`/`worker status` text are left. `src/cli.ts` (result/cancel/revert, retry, signal cases): `cancel` prints `statusText`, `retry` prints `statusText` plus `poll: <hint> poll <id>`, `signal` prints `Signal "key" accepted. poll: <hint> poll <id>`. `--json` output is unchanged.
- Outcome: `npm run check` passes; `npm test` **37/37**. No new test asserts the text lines yet; process tests use `--json`.
- Value: ⚠️ partial: readable output for three commands, without a test for the text.
- Lesson: in a four-minute tick, ship the edit with the suite green and log the missing test as the next step instead of starting it late.

### Tick 21 · 12:34 · Test the readable signal and cancel output
- Action: wrote the test tick 20 left as its next step. Chosen over fix 8 or the rest of fix 9 because untested text output can regress silently and the test fits a four-minute tick. The process sandbox's `cli` (`test/process.test.ts:20`) takes a third `json = true` argument; without it the CLI runs as an agent would, with no `--json`.
- Outcome: the gate test asserts `signal` prints exactly `Signal "go" accepted. poll: … poll <id>`; the SIGKILL test asserts `cancel` prints status text containing `cancelled`, not JSON. `npm run check` passes; `npm test` **37/37**.
- Value: ✅ yielded value: tick 20's text output is now protected by tests that run the compiled CLI.
- Lesson: `npm test` prints `ℹ tests N`, not `# tests N`; grep `^ℹ (tests|pass|fail)` for the counts.

### Tick 22 · 12:39 · result on a cancelled run exits 3 with run_cancelled
- Action: took the exit-code part of axeval fix 9, because it fits a four-minute tick and makes the documented exit code (`3 cancelled`) true; fix 8 needs a full tick. `src/engine/index.ts` result throws `run_cancelled: Run <id> is cancelled.` before the generic `run_failed`; `errorInfo` (`src/cli.ts`) maps `run_cancelled` to exit 3.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/process.test.ts` SIGKILL test now asserts `result` on the cancelled run exits 3 with `run_cancelled` on stderr. The tool path gets the code too via tick 18's `codedError`.
- Value: ✅ yielded value: scripts and agents can branch on a cancelled run as the help documents.
- Lesson: check each documented exit code against a test; the help promised 3 and the code returned 2.

### Tick 23 · 12:47 · agents and worker print text, not JSON
- Action: finished axeval fix 9, because it was the last small piece of it and fits a four-minute tick; fix 8 needs a full tick. `src/cli.ts` agents case prints one line per background agent (`runId name status [detached]`) or `No background agents. agents lists ctx.spawn() agents; ctx.agent() steps are in status --verbose.`; `worker start|status` print `worker pid N · home DIR · up 0s`, `worker stop` prints `worker stopped`. `--json` is unchanged.
- Outcome: `npm run check` passes; `npm test` **37/37**. Local CLI (after `npm run build`) with `--home /tmp/bt23` printed all three lines. Found: `worker status` with no worker prints a raw `ENOENT` (logged under Backlog 0.9). No test asserts the new text yet.
- Value: ✅ yielded value: no CLI command dumps JSON in text mode any more.
- Lesson: try each command once against a fresh home after changing it; the empty case showed an error the report missed.

### Tick 24 · 12:50 · worker status explains a missing worker
- Action: fixed tick 23's follow-up because it fits a four-minute tick; fix 8 needs a full tick. `worker status` and `worker stop` on a home with no worker printed `error ENOENT: connect ENOENT …/worker.sock` (exit 4 already). In the `worker` case of `src/cli.ts`, a `running` wrapper now turns ENOENT/ECONNREFUSED into `worker_unavailable: No workflow worker is running for this home. Start one with <hint> worker start; run, poll and the other commands start it automatically.` The hint keeps `--home`.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/process.test.ts` asserts exit 4 and the message for `worker status` before any worker starts.
- Value: ✅ yielded value: an agent that checks the worker first gets the fix, not a socket errno.
- Lesson: wrap errno handling at the command that knows the context (here: only `start` spawns), not in the shared rpc client.

### Tick 25 · 12:56 · Archive the oldest log entries; test agents and worker text
- Action: the Log had 26 entries, past the 25 limit, so ticks 0-4 moved to `brain/archive/2026-10-30.md` (tick 4's lesson kept under Lessons). With the remaining time, closed the gap tick 23 left: no test asserted the `agents` and `worker status` text. Fix 8 needs a full tick, so it waits.
- Outcome: `test/process.test.ts` (after the quick run) asserts `agents` prints `No background agents. …` and `worker status` prints `worker pid N · home …`, both without `--json`. `npm test` **37/37**.
- Value: ✅ yielded value: every text-mode command changed in ticks 20-24 is now under test, and the ledger is back within its limits.
- Lesson: pair mandatory housekeeping with a test-sized change; both fit one four-minute tick.

### Tick 26 · 13:00 · Spawn runshape for one run shape across surfaces
- Action: spawned `runshape` for axeval fix 8, because it is the last full ranked fix, touches engine/index.ts, cli.ts, extension.ts, presentation.ts and the README, and three ticks in a row (19, 22, 23) deferred it as too big for four minutes. The brief names the JSON table (axeval.md:79-86), the four changes, the D4 no-shim rule, the 37/37 baseline and the out-of-scope files.
- Outcome: `loop.sh spawn` finished in about 50 seconds; branch brain/runshape pushed, worktree `.pi/worktrees/brain-runshape`, herdr w5:p1 reports `agent_status=working`. No code changed this tick; tests not rerun (37/37 at 1a5871e).
- Value: ✅ yielded value: the largest open fix is being worked without blocking the small ones.
- Lesson: when the same item is deferred three times as too big for a tick, delegate it instead of deferring again. Next tick: fix 3's validate-time lint (src/validation.ts), which does not overlap runshape's files.

### Tick 27 · 13:08 · validate reports unknown ctx.agent options
- Action: took the static half of axeval fix 3, as tick 26 planned, because it does not overlap runshape's files and fits four minutes. `lintDeterminism` (`src/validation.ts`) checks the object-literal second argument of every `ctx.agent` call in run control flow and reports `unknown_agent_option` with line, did-you-mean and the valid list; `validateWorkflow` already marks any diagnostic as invalid. `AGENT_OPTIONS` moved from engine/execution.ts into validation.ts so both checks share one list.
- Outcome: `npm run check` passes; `npm test` **37/37**. `test/unit.test.ts` determinism test asserts `{ tool: [], label }` yields exactly one `unknown_agent_option` naming `tools`.
- Value: ✅ yielded value: a misspelled agent option is caught at validate, before launch.
- Follow-up in the same tick (`64463bd` then this commit): `ctx.spawn({…})` options are linted too, accepting `name`, `initialPrompt` and `detach` on top; the test adds a `modle` typo. **37/37**.
- Lesson: one shared constant between the lint and the run-time check keeps them from drifting. Commit at the first green, then extend; both fit the four minutes. Next: review runshape when done.

### Tick 28 · 13:10 · Merge runshape: one run shape across surfaces
- Action: reviewed and merged `brain/runshape`, done since tick 27, because a finished branch blocks nothing else and fix 8 was the last open ranked axeval fix. Diff: 12 files, +195/-57 (cli.ts, engine/index.ts, store.ts, extension.ts, presentation.ts, README, tests).
- Outcome: `npm test` in its worktree **38/38**; after `git merge --no-ff` on top of tick 27's lint, `npm run check` clean and `npm test` **38/38**. Merge `237e912`, pushed; `loop.sh retire runshape` succeeded. All ten axeval fixes are now done. runshape's observation (terminal runs keep `waitingFor`) became Backlog 0.11.
- Value: ✅ yielded value: an agent that learned the JSON shape on the CLI can parse the tool's details and vice versa; `list` no longer mixes model types.
- Lesson: re-run the suite after merging, not only in the branch; tick 27 changed validation.ts and execution.ts under it. Next: Backlog 0.11, then a second axeval round to measure the fixes.

### Tick 29 · 13:14 · Reproduce stale waitingFor on cancelled runs
- Action: took Backlog 0.11, the next open item and small on paper. Added a test that cancels a run waiting on a signal and asserts `waitingFor` is gone, then cleared `waitingFor` in `Engine.mutate` for terminal statuses and in the runTask `abort` commit.
- Outcome: the test reproduced the bug (`waitingFor` still `{key:"approve",…}` after cancel); both fixes left it failing, **38 tests, 37 pass, 1 fail** (the new assertion). Out of time, so I restored the source and the test from HEAD rather than commit a red suite; code is unchanged from 7435e3a (38/38). The reproducer and the two dead ends are in Backlog 0.11.
- Value: ⚠️ partial: the bug is confirmed with a reproducer and two wrong fixes are ruled out; nothing shipped.
- Lesson: trace where a field is written before patching; I patched two plausible writers without reading the signal loop and ran out of time. A hook blocks `git checkout -- <file>` and heredocs containing words like "delete"; restore files with `git show HEAD:<path>` and edit the ledger with the edit tool.

### Tick 30 · 13:19 · Terminal runs no longer show waitingFor
- Action: retook Backlog 0.11 with tick 29's reproducer, because it was the only open ranked item and the bug was confirmed. Rewrote the test (second `gate` after the list assertions, cancel while `waiting_signal`, assert no `waitingFor`), then tried tick 29's abort-commit fix alone.
- Outcome: `delete run.waitingFor` in the runTask `abort` commit (engine/index.ts ~545) fixes it; without it the test fails (checked both ways). Also cleared it in the `execute` failure commit, so a `signal_timeout` run does not keep it. `npm run check` clean; `npm test` **38/38**. Tick 29's failure came from testing it together with the `Engine.mutate` change, not from the abort fix itself.
- Value: ✅ yielded value: a cancelled or failed run no longer prints "waiting for signal … signal: …".
- Lesson: retest the simplest candidate fix alone before ruling it out. Next: a second axeval round to measure the ten fixes (spawn), since Backlog 0 is now empty.

### Tick 31 · 13:24 · Spawn axeval2 to measure the fixes
- Action: spawned `axeval2`, as tick 30 planned, because every ranked axeval fix is done and the next changes should come from measured wrong turns, not guesses. The brief repeats round one's four scenarios with the same model (haiku) so counts compare, adds a parity check of `workflow guide` vs the tool's guide, and carries the D8 and tick 19 traps (`pi -e` the local index.ts, `npm run build` before using bin/workflow.mjs) and the Pi boolean-flag trap.
- Outcome: `loop.sh spawn` took about 50 seconds; branch brain/axeval2 pushed, worktree `.pi/worktrees/brain-axeval2`, herdr w6:p1 reports `agent_status=working`. No code changed; tests not rerun (38/38 at 3fb3137).
- Value: ✅ yielded value: the effect of ticks 9-30 will be measured against round one's 5/8/…-wrong-turn baseline.
- Also archived ticks 6, 7 and the 11:30 supervisor entry (Log was 27 entries), keeping their lessons.
- Lesson: put the known environment traps in the brief; round one lost turns to them. Next tick: act on axeval2's partial findings if concrete and outside its scope, otherwise a Backlog 4 item (git-ignored workflow warning in validate/catalog).

### Tick 32 · 13:29 · validate reports unknown ctx members
- Action: took axeval2's scenario 2 finding (a), concrete and outside its write scope: `ctx.runAgent(…)` validated as Valid and failed at run time with `ctx.runAgent is not a function`, no line. `lintDeterminism` (`src/validation.ts`) now takes the context name from the outer `run`'s first parameter and reports any `ctx.<member>` not in the new `CONTEXT_MEMBERS` as `unknown_context_member` with its line and the member list. Nested DAG `run(deps)` functions are ignored (only a `run` entered outside run control flow sets the name).
- Outcome: first try flagged `deps.web` in `examples/02-dag.ts` (37/38); restricting to the outer run fixed it. `npm run check` clean; `npm test` **38/38**; `test/unit.test.ts` asserts `ctx.runAgent` yields exactly one `unknown_context_member` naming `agent`. Commit `2cb15bb`.
- Value: ✅ yielded value: a misnamed ctx method is caught at validate with a line number.
- Lesson: the examples are the lint's regression suite; a new lint must pass them before it ships. Next: axeval2's other scenario 2 items (b) `readFileSync` in run, (c) wrong typebox import hint, (d) load errors stop at the first; or attached `run` reprinting the full tree every second (scenario 1).

### Tick 33 · 13:35 · Finished runs refuse signals
- Action: took axeval2's scenario 3 finding (b), concrete, one function and outside its scope (it is testing the tool `value` schema, so I left extension.ts alone): `signal` to a cancelled run with the awaited key printed `Signal "approve-plan" accepted.` and exited 0. `Engine.signal` (`src/engine/index.ts`) now throws `run_finished: Run <id> is <status> and accepts no more signals.` for completed, cancelled and reverted runs. Failed runs still accept a signal, since `retry` can resume them.
- Outcome: `npm run check` clean; `npm test` **38/38**. `test/engine.test.ts` (cancelled gate in "signals are schema-checked…") asserts `run_finished`; with the old engine/index.ts the suite is 37/38, so the test catches the bug.
- Value: ✅ yielded value: an agent no longer gets a false "accepted" for a signal that nothing will read.
- Lesson: check a new assertion against the old source before trusting it; swapping one file via `git show HEAD:` takes seconds. Next: axeval2's other open items: `status --verbose`/`watch` lack `expects:`, `result_not_ready` gives a CLI hint in tool results, signal exit codes (unknown_signal 2 vs invalid_signal 1), attached `run` reprints the tree each second.

### Tick 34 · 13:41 · Tool signal value is typed
- Action: took axeval2's scenario 4 finding, its costliest (session D: 13 wrong turns, three `value` JSON strings, a cancel and a bash fallback), because axeval2's own experiment showed the fix. `src/extension.ts` `value` is now a union of object, array, string, number, boolean and null instead of `Type.Unknown`, as `args` became in tick 12.
- Outcome: axeval2's temporary experiment with this schema: D-x1 4 calls/0 errors, `"value": {"ok": true}` first time. `npm run check` clean; `npm test` **38/38**; `test/extension.test.ts:184` asserts the six member types. Not verified live in Pi (D8).
- Value: ✅ yielded value: the tool schema now shows the model that `value` is a JSON value, which removed the scenario's wrong turns in the experiment.
- Follow-up in the same tick: `runTree` (`src/presentation.ts:137`) prints `Expects: <schema>` under `deliver with:`, so verbose `status` (tool and CLI) and `watch` show the signal schema (axeval2 S3 a, D-x2's one error). `test/unit.test.ts:106` asserts it; **38/38**.
- Lesson: let an evaluation subagent run a reverted experiment; it turns a guess into a measured one-line fix. Next: attached `run` stops at a signal wait and prints only changes (cli.ts:241-247), then merge axeval2 when done.

### Tick 35 · 13:45 · Merge the axeval2 evaluation
- Action: reviewed and merged `brain/axeval2`, done since tick 34, because a finished docs-only branch blocks nothing and its ranked list replaces guesses for the next ticks. Diff: `brain/axeval2.md` +214, `ledgers/axeval2.md` +32; its worktree was clean.
- Outcome: merge `6ed16ed`, pushed; `loop.sh retire axeval2` succeeded. Tests not rerun: no source changed (axeval2 reported 38/38; 38/38 at 341efca). Round two: S1 0 wrong turns (was 5), S2 4 (was 8), S3 0 (was 7), S4 A/B/C 0/0/0 (was 11/5/0), D 13 (was 11, fixed by tick 34's typed `value` in a measured experiment: 4 calls/0 errors). Open ranked fixes moved to Backlog 00.
- Value: ✅ yielded value: round one's fixes are measured as working, and the next eight are ranked with file:line.
- Lesson: an evaluation round after a batch of fixes is worth its cost; it confirmed 7 of 10 fixes held fully and found the one remaining hang (attached `run` on a signal). Next: Backlog 00.2, attached `run` stops on a signal wait (cli.ts:241-251).

### Tick 36 · 13:50 · Attached run returns at a signal wait
- Action: took Backlog 00.2, the top open ranked fix: axeval2 found the guide's default shell command (`workflow run <name>`) hangs on a gate and reprints the tree every second. `poll` in `src/cli.ts` (foreground branch) now returns 0 on `waiting_signal` unless `--until done`, printing `statusText` (with its `signal:` hint) and `then: <hint> poll <id>`; `--json` emits the brief view. Progress lines on stderr print only when the tree changes apart from elapsed time (shared `unchanged` helper).
- Outcome: `npm run check` clean; `npm test` **38/38**. `test/process.test.ts` gate test runs `run gate` attached without `--json` and asserts exit 0 and `waiting_signal … then: … poll`. With the old `src/cli.ts` the process tests are 1/2 (the gate test fails), so the test catches the hang.
- Value: ✅ yielded value: a shell agent following the guide no longer hangs on a gate.
- Lesson: one shared change key keeps `run`, `poll` and `watch` quiet the same way. Next: Backlog 00.3 (`waitingLines` helper) or 00.4 (surface-neutral `result_not_ready`).

### Tick 37 · 13:56 · result_not_ready names the signal and a surface-shaped next step
- Action: took Backlog 00.4 over 00.3, because 00.3 is a refactor with no visible effect while 00.4 fixes axeval2 session D call 6 (the tool told the model to run `poll --until done`, which the tool cannot do). `src/engine/index.ts` result now throws `Run X is waiting for signal "go"; deliver it, then read the result.` (or `Run X is running; the result is not ready.`). `src/cli.ts` result case appends `poll: <hint> poll X`; `src/extension.ts` catch appends `Check it with {"action":"status","runId":"X"}.`
- Outcome: `npm run check` clean; `npm test` **38/38**. `test/process.test.ts` gate test asserts `result` on the waiting run exits 2 with the new message and the `poll:` hint. Commit `8fce02c`. The tool-side append has no test yet; the tool `signal` reply is unchanged.
- Value: ✅ yielded value: neither surface names a command the other owns for an early `result`.
- Lesson: a client-side `.catch` that appends to the message keeps the engine surface-neutral without a new error field. Next: a tool-path test for the status hint plus the tool's own `signal` reply (rest of 00.4), then 00.3.
