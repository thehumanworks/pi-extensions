Status: open — 10 tasks, none started (baseline `npm test` 44/44 at 43756f5)

# Task ledger: parity

Created 2026-10-30. Two sources: a review of pi-orchestration against Claude Code Dynamic Workflows, and two user requests about launch approval and headless runs. Each task is written so a fresh session can start it without that conversation.

Line numbers are for commit 43756f5. If they have drifted, search for the quoted symbol.

## How to work a task

1. Read `AGENTS.md`, then this section, then one task. Read `BRAIN.md` Decisions for context, noting that D1 and D2 are changed by the decisions below.
2. Set the task's Status to `in progress`. Work on a branch named `brain/<task-id>`, such as `brain/t2-yolo`.
3. Finish with `npm test`, writing the output to a file and grepping `^ℹ (tests|pass|fail)`. Check each new assertion fails on the old source (`git show HEAD:<path>`).
4. If the task changes CLI output or JSON shapes, also run the Nix smoke test (commands in `AGENTS.md`).
5. Set Status to `done`, add a dated line to the Log at the end of this file, and commit on the branch.

Rules that apply to every task:

- Do not merge to main, push main or bump versions (D3). Release steps are in `AGENTS.md`; the user decides when to release.
- No legacy compatibility layers (D4).
- The engine and client word errors without naming a surface. `src/cli.ts` adds the shell command and `src/extension.ts` the tool call. Error codes are stable.
- Use a short `--home` under `/tmp`, and stop every worker you start. Do not stop a worker you did not start: the user may have one on the default home.
- Fixtures must isolate `PI_CODING_AGENT_DIR` as well as the home.

## Decisions

These were made when the ledger was written. A task may refine one, but must record the change here.

| ID | Decision | Reason |
|---|---|---|
| L1 | **Amends D1.** Launch approval returns as a setting, `/workflow yolo [on\|off]`. Default is yolo **on**, so behaviour does not change until the user turns it off. | The user asked for an easy setting. D1 (no approval) was also a user decision, so the default keeps it. **The user can flip this default**; it is one constant. |
| L2 | The setting is stored only in the global `<agentDir>/settings.json`, as `"workflow": { "yolo": false }`, and read from that file at each gated action. It does not use `pi.getSettings()`. | `getSettings()` merges project settings (`pi-coding-agent/dist/core/extensions/types.d.ts:1285`), so a cloned repo could turn the gate off. It is also an in-memory snapshot, so it would miss a write made from another session. |
| L3 | Only agent-initiated launches are gated: the tool's `run`, and `retry` with `allowChanged`. `/workflow run` and the shell `workflow` are not. | A person typing a command has already approved it. Gating them is what made headless use need an env var. |
| L4 | With yolo off and no UI, a tool launch fails at once with `approval_required`. It never waits, and no env var overrides it. | Headless runs must not hang. The fix is the setting. |
| L5 | The gate is a guard against surprise, not a security boundary. An agent with `bash` can still run `workflow` or edit `settings.json`. The README says so. | Consistent with the README's "trusted same-user code" stance. |
| L6 | **Refines D2.** Inline workflows (T6) live in the workflow home and are not committed. D2 still applies to saved workflows in `.pi/workflows/`. | An inline script is a one-off, like a Claude Code inline script. |

## Index

Do T1 and T2 first: they are the user's explicit requests. T3 has the highest value of the rest. T4 and T5 are small and independent. T10 goes last because earlier tasks change what it documents.

| Task | Title | Size | Depends on | Main files |
|---|---|---|---|---|
| T1 | Finish the headless cleanup | S | none | `brain/loop.sh`, `README.md`, `BRAIN.md` |
| T2 | `/workflow yolo` setting | M | none | `src/extension.ts`, new `src/approval.ts` |
| T3 | Keep the unchanged prefix when retrying an edited workflow | L | T2 for the gate on `retry` | `src/engine/index.ts`, `src/engine/execution.ts`, `src/engine/scopes.ts` |
| T4 | Default agent cap per run | S | none | `src/engine/index.ts`, `src/settings.ts` |
| T5 | Provider retries and a longer agent timeout | S | none | `src/engine/index.ts`, `src/settings.ts` |
| T6 | Inline workflow scripts | M | T2 | `src/extension.ts`, `src/cli.ts`, `src/paths.ts` |
| T7 | Give workflow agents project context files | S | none | `src/engine/execution.ts`, `src/engine/background.ts` |
| T8 | Make `maxTokens` exclude cache reads; expose tokens in `ctx.budget` | S | none | `src/engine/index.ts`, `src/index.ts` |
| T9 | Remove unchanged worktrees after a run | M | none | `src/engine/worktrees.ts`, `src/engine/index.ts` |
| T10 | Correct the README comparison | S | T1–T9 | `README.md` |

T3, T4, T5, T8 and T9 all edit `src/engine/index.ts`, so run them one after another rather than in parallel.

---

## T1. Finish the headless cleanup

**Status:** open · **Size:** S

**Why:** The user does not want to set an env var to run workflows headlessly. That is already true of the code, so what remains is stale material that says otherwise.

**Verified 2026-10-30, env var unset, against the installed 0.3.2:**

- `PI_WORKFLOW_ALLOW_UNATTENDED` appears nowhere in the installed `src`, `dist` or README, nor in this repository's `src`, `test` or `nix`.
- `workflow run noop.ts` with no agents: completed, exit 0.
- `pi --no-session --no-extensions -e <installed>/index.ts -p "/workflow run noop.ts" </dev/null`: completed, exit 0.
- Not verified: a tool launch from a headless model turn, because that needs a paid model call. `test/extension.test.ts:170` covers it with a fake host in every Pi mode.

**Do:**

1. Remove the variable from `brain/loop.sh`. D8's condition ("until Pi runs 0.3.0 or later") is met by the installed 0.3.2.
   - Line 35: drop it, keep `PI_MEMORY_CAPTURE=0 PI_MEMORY_DREAM=0`.
   - Line 83: remove the clause naming it, keep the rest of the rule.
   - Line 105: delete the line. It says the installed tool asks a human, which is no longer true.
   - Line 246: drop that one `--env` argument.
2. `README.md:501`: replace "headless opt-in" with "launching without opt-in".
3. Add a README troubleshooting row: `pi -p "/workflow …"` prints nothing and never returns. Cause: `pi -p` waits for stdin when stdin is an open non-terminal, as under another program's shell. Fix: add `</dev/null`. The same command timed out at 60 seconds with stdin open and finished at once with it closed.
4. In `BRAIN.md`, update D8 (it says Pi runs 0.2.1; it runs 0.3.2, and npm's latest is 0.3.2 while the repo is at 0.4.0, unpublished). Add D10 recording L1–L5 and pointing here. Keep the Log last.

**Tests:** `bash -n brain/loop.sh`. `git grep PI_WORKFLOW_ALLOW_UNATTENDED -- . ':!BRAIN.md' ':!ledgers' ':!brain/archive' ':!brain/axeval*'` prints nothing.

**Done when:** the grep is empty, and `README.md` and `BRAIN.md` match the facts above.

**Note for the user, not a code change:** neither `~/.local/bin` nor `~/bin` is on the login PATH here, so the extension could not link `workflow` and the command is missing. To use it from a shell, run `nix profile add 'github:thehumanworks/pi-extensions?dir=pi-orchestration#workflow'` or add one of those directories to PATH. `pi -p "/workflow …"` works either way.

---

## T2. `/workflow yolo` setting

**Status:** open · **Size:** M · **Follows:** L1–L5

**Why:** The user wants no-approval launches to be a setting that is easy to change from Pi. D1 removed the old gate, so nothing can be changed today. The old gate also fell short: `/workflow approval` lasted one session, and persisting it meant editing `settings.json` by hand.

**Starting point:** the removed gate is in git. Read `git show 6fd0797:pi-orchestration/src/extension.ts`, lines 281–327 (`approval`, `approvalCommand`, `authorize` with its `ctx.ui.confirm` text). Reuse the confirm text. Do not restore the session override, `reset`, the footer status, `assertUnattended` or `authorizeRun`.

**Do:**

1. New `src/approval.ts`, imported only by `src/extension.ts` so the standalone CLI gains no peer dependency:
   - `readYolo(agentDir): Promise<boolean>`: read `<agentDir>/settings.json`. A missing file or key returns `true`. Unparseable JSON, or a value that is not a boolean, throws `invalid_setting`.
   - `writeYolo(agentDir, value): Promise<void>`: copy the approach of `pi-memory/src/settings.ts:15-38`: `withFileMutationQueue`, `settings.json.lock`, follow symlinks, keep the file mode, write a temp file and rename. Merge only the `workflow` key. Copy the code rather than importing it: the README records no sibling workspace imports.
2. Gate in `executeTool` (`src/extension.ts:300`), after `assertRootLaunch`, for `run` and for `retry` with `allowChanged`:
   - Yolo on: continue.
   - Yolo off with `ctx.hasUI`: `ctx.ui.confirm`. Declined throws `cancelled`, as the old gate did. Name `/workflow yolo on` in the dialog.
   - Yolo off without UI: throw `approval_required`, with a message naming `/workflow yolo on` and saying a person must change it.
3. Command: in the `/workflow` handler, before `runCli` (`src/extension.ts:440-441`), intercept `yolo`:
   - No argument: print the state and that it is stored in settings.json.
   - `on` or `off`: write it, then print the new state.
   - Anything else: `Usage: /workflow yolo [on|off]`.
   - It must work in print mode, so `pi -p "/workflow yolo off" </dev/null` persists.
4. Show the command in `/workflow help` only: `help(program)` in `src/cli.ts` adds the line when `program === "/workflow"`. The shell command does not get `yolo`.
5. Docs: replace "Launches start immediately from all three entry points" (`README.md:105`) with the behaviour of both states and L5. Add a line to `src/guide.ts` for agents: a launch may need approval, and `approval_required` is for the user to resolve.

**Tests** (`test/extension.test.ts`; extend `harness()` at line 31 with a temp `PI_CODING_AGENT_DIR` in `env` and a recording `ui.confirm`):

- No setting: launches do not call confirm in any mode. The existing matrix at line 170 keeps proving this.
- Off, TUI: accept launches; decline throws `cancelled` and sends no `run` request.
- Off, print: the tool throws `approval_required` immediately, and `/workflow run` still launches.
- Off: `retry` with `allowChanged` is gated; plain `retry` is not.
- `/workflow yolo off` then `on` round-trips, keeps sibling settings keys, and writes through a symlinked `settings.json`.
- `.pi/settings.json` in the project cannot change the result.
- Invalid value: `invalid_setting`.
- A write is seen by the next tool call without reloading the session.

**Done when:** the tests pass, and `/workflow yolo off` in one session takes effect in a new headless session with no env var.

---

## T3. Keep the unchanged prefix when retrying an edited workflow

**Status:** open · **Size:** L

**Why:** This is the largest gap with Claude Code. There, resuming an edited script reuses the longest unchanged prefix. Here any edit, even a comment, changes the file hash. `retry` then refuses, and `--allow-changed` wipes the journal (`src/engine/index.ts:402-404`), so every agent runs and bills again. Agents write these scripts and often get them wrong, so this is the common path.

**Semantics:**

- `retry --allow-changed` reuses what still matches.
- New `retry --clean` (tool `clean: true`) does what `--allow-changed` does today. No compatibility alias (D4).
- `--from` with changed code stays refused (`index.ts:387`). Not in scope.

**Traps found in the code. A plain "compare fingerprints" version gets these wrong:**

1. A completed combinator hides its children. `parallel` and `pipeline` return their stored result without running the thunks (`execution.ts:171`, `:200`), and their fingerprints hold only the count, options and items (`:165`, `:199`). An edited prompt inside a completed `parallel` would be missed. Reset completed `parallel` and `pipeline` steps to `pending` when reconciling, so replay descends. Reused children return at once.
2. `ctx.step` fingerprints ignore the callback (`execution.ts:221` holds only `retries` and `compensate`). An edited body with the same key would be silently reused. Store a separate `sourceHash` of `fn.toString()` plus `compensate.toString()`, compared only when reconciling, so in-flight runs' fingerprints do not change. A missing hash counts as a mismatch.
3. A `ctx.workflow` step fingerprints the reference and args (`execution.ts:389`), not the child's code. Compare the child run's recorded `workflow.hash` with the file's current hash.
4. `journal()` (`:286`), `claim()` (`:137`), `helper()` (`:243`), `phase()` (`:258`) and the end-of-run check (`:120`) all throw `journal_mismatch`. Each needs a reconcile branch.
5. `sequence` order is timing-dependent inside `parallel`, so "everything after sequence N" invalidates unrelated branches. Use the scope tree instead (below).
6. A removed `ctx.step` with a compensation can no longer be reconstructed, and `revert` would fail with `missing_compensation` (`index.ts:467`).
7. Keys embed ordinals (`structuralKey`, `scopes.ts:77-80`), so inserting a call shifts later siblings. That is acceptable: they fall after the divergence and run live.

**Do:**

1. `Engine.retry` (`index.ts:372`): when changed and not clean, lint the new file exactly as `launch` does (`:303-305`), refusing with `invalid_workflow` before changing anything. This also closes the gap noted in BRAIN 00.6. Then update the hash, set a persisted `run.reconcile = true`, keep the journal, and apply trap 1. Treat a swarm as one unit, as `:395` does.
2. Add divergence to `Scope` (`scopes.ts:8`): a node `{ diverged, parent }`. A new scope inherits the parent's current value. Marking a node also marks its ancestors, never its siblings. So a changed branch does not re-run other `parallel` branches, and everything after that `parallel` in the parent runs live, because it may use the changed result.
3. In reconcile mode, a mismatch or a record in a diverged scope resets that step and marks the scope. Reused steps need no extra work, because a result that changed also changes the next prompt's fingerprint.
4. Extract the field list at `index.ts:407-409` into a shared `resetStep`. Also delete `run.signals[name]` for a reset signal step, and call `cleanupBackgroundSteps` for reset `spawn` and `swarm` steps.
5. End of run (`execution.ts:120`): in reconcile mode, drop unvisited positions and their steps instead of throwing. For a completed compensatable step, clear `compensatable` and log that it can no longer be reverted. Clear `run.reconcile` when the run ends.
6. Log to `run.logs`, shown by status: `Reused N of M steps`, and each completed `ctx.step` that re-ran, because its effect was repeated. `retry` replies before replay, so these cannot go in its reply.
7. Update `src/cli.ts:27,212,355`, the tool schema (`src/extension.ts:76`, `:324`), the protocol validator, `README.md:226` and the troubleshooting rows.

**Known limits, for the README:** edits to `definition.tools` code and to imported files are not detected. An agent that reads a file written by an earlier agent in a sibling branch is not tracked. A reset worktree agent reuses its checkout with the earlier files (already true of `retry`).

**Tests** (`test/engine.test.ts`, counting faux-model calls):

- Comment-only edit: zero model calls, run completes.
- A failed third agent, with its prompt fixed: the first two are reused.
- Edit one branch of a completed `parallel`: only that branch and later operations run.
- Edit a `ctx.step` body under the same key: it re-runs and the log says so.
- Insert an early call; remove a call: both finish with no `journal_mismatch`.
- A failed lint refuses and leaves the run unchanged.
- `--clean` matches the old behaviour.
- `revert` after a reconciled retry works.
- A workflow containing `spawn` and `swarm` steps.
- Worker restart in mid-reconcile (`test/process.test.ts:153` shows the SIGKILL pattern).

**Done when:** the tests pass and the Nix smoke test passes.

---

## T4. Default agent cap per run

**Status:** open · **Size:** S

**Why:** Claude Code stops a run at 1,000 agents. Here `maxAgents` is optional and nothing applies by default (`index.ts:338`), and launches need no approval by default. A bad `while` loop spends until someone cancels it. `ctx.step`-only loops are out of scope.

**Do:**

1. `src/settings.ts`: add `maxAgentsPerRun` from `PI_WORKFLOW_MAX_AGENTS_PER_RUN`, default 1000, minimum 1. `worker.ts:35` spreads `workerSettings()` into the engine, so add it to `EngineOptions` and `Engine.settings` (`index.ts:39-51`, `:76-79`).
2. `reserveAgent` (`index.ts:99-114`): use `run.limits.maxAgents ?? this.settings.maxAgentsPerRun`. An explicit `maxAgents` wins, in either direction. This one function covers `ctx.agent` (`execution.ts:475`) and background agents and swarms (`background.ts:308`). Confirm swarm workers go through `create`.
3. Do not put the default into `limits`: `ctx.budget.agents` must stay `null` when uncapped (`README.md:123`).
4. Error: `budget_exceeded`, naming the limit and that `budget.maxAgents` raises it. It already stops the whole run rather than becoming a `null` (`execution.ts:184`, `:209`).
5. Docs: the README env table, and the budget rule in `src/guide.ts:86`.

**Tests:** with a low cap and no `budget`, a `while (true)` agent loop fails with `budget_exceeded` at exactly the cap, and `ctx.budget.agents` is `null`. An explicit higher `maxAgents` beats the default. A child run's agents count against the root. See how `test/helpers.ts` configures a worker, and restore any env you set.

**Done when:** the tests pass.

---

## T5. Provider retries and a longer agent timeout

**Status:** open · **Size:** S

**Why:** One transient 429 loses an agent. Harness retries are 0 (`index.ts:568`, there since the first commit `25d7bdb` with no recorded reason) and agent retries default to 0. In `parallel` the failure becomes `null`, which `examples/workflows/07-loop-until-dry-verify.ts:53` counts as a "not real" vote. An agent that runs past the absolute 10-minute default does the same.

**Do:**

1. `src/settings.ts`: add `providerRetries` from `PI_WORKFLOW_PROVIDER_RETRIES`, default 3, minimum 0. Pass it at `index.ts:568`: `retry: { maxRetries: … }`. The field is `Partial<ConversationRetryPolicy>`. Check the defaults for `enabled` and `baseDelayMs` in pi-durable's `dist/harness`.
   - Use this rather than raising `PI_WORKFLOW_AGENT_RETRIES`. Harness retries repeat the failed model request inside the same conversation (`pi-durable/dist/harness/generation.js:423-429`) and keep the agent's work. Agent retries start a new conversation and can repeat bash effects, so that default stays 0.
   - Context overflow is excluded, and only errors matching pi-ai's `isRetryableAssistantError` (`pi-ai/dist/utils/retry.js:202`) are retried.
2. Raise the default agent timeout from 10 to 30 minutes in `settings.ts:17`. Use one constant for the fallbacks at `execution.ts:310` and `:488`, which repeat `600_000`. The deadline is set after the semaphore is acquired (`:445` then `:488`), so queueing does not count. 30 minutes is a judgement, not a measurement; say so in the README.
3. Docs: the env table (`README.md:394-403`) and the `timeoutMs` row (`:165`).

**Tests:** `FAIL_ONCE` returns `"scripted provider failure"` (`test/helpers.ts:57-60`), which may not match pi-ai's pattern, so add a directive with a 429-style message. Assert that an agent with no `retries` option completes on the same conversation with `agentAttempt` 1. A non-retryable error still fails. With the setting at 0 the transient error fails. Backoff must not slow the suite: check how the fixture handles time. Keep the test at `test/engine.test.ts:240` passing.

**Done when:** the tests pass.

---

## T6. Inline workflow scripts

**Status:** open · **Size:** M · **Depends on:** T2 · **Follows:** L6

**Why:** Claude Code runs a one-off script passed inline, which suits scouting then fanning out over what was found. Here a launch needs a file, and D2 says workflow files are committed, so one-offs either clutter the repo or break the rule.

**Do:**

1. Keep the worker protocol unchanged: the client side resolves source to a file and sends `{ path }`. `WorkflowRef` stays as it is (`protocol.ts:27`).
2. `src/paths.ts`: add `scripts` to `workflowPaths`. Add a shared helper that writes `<home>/scripts/<sha256 of requestId>.ts` with mode 0600. The same request ID with the same content succeeds, keeping launches idempotent. Deriving the name from the request, not the content, lets an agent edit the file and `retry` with `allowChanged`.
3. Tool: add `{ source: string }` to `workflowSchema` (`extension.ts:52-54`), handled at `:305` and `:317`, for both `run` and `validate`. Use `toolCallId` for the name. The launch text gives the saved path and that editing it and calling `retry` with `allowChanged` iterates on it. Do not add it to the JSON reply; `status --verbose` already has `workflow.path`.
4. CLI: `workflow run -` reads the script from stdin, using the same helper with `--home`.
5. T2's gate applies. The dialog names the saved path and line count, not the whole script.
6. Keep the file with its run, because replay and `retry` reload it (`index.ts:241`, `:381`). No clean-up in this task.
7. Docs (`src/guide.ts:53`, `README.md:113`): when to use inline. Copy a script to `.pi/workflows/` and commit it to keep it. Inline scripts can import only what the loader aliases: `typebox`, pi-durable, pi-ai and this package (`loader.ts:18`, `:60-64`). Relative imports and project dependencies will not resolve from the home.

**Tests:** tool path through the fake client (`harness()`): the request carries a path whose file matches the source, and repeating the call is safe. `validate` with `source` returns diagnostics. Lint refusal creates no run. End to end through the compiled CLI: `run -` from stdin completes, and survives a worker restart. An inline script does not appear in `catalog`.

**Done when:** the tests pass and the Nix smoke test passes.

---

## T7. Give workflow agents project context files

**Status:** open · **Size:** S

**Why:** Claude Code subagents get CLAUDE.md. Pi's own sessions load `AGENTS.md` and `CLAUDE.md`, but workflow agents do not, so project rules silently stop applying inside a workflow. Confirmed: pi-durable's only reference to those files is a conformance test, and the engine's instructions (`execution.ts:482`) add none.

**Do:**

1. Load with `loadProjectContextFiles({ cwd, agentDir })`, exported by `pi-workflow-runtime` (`resource-loader.d.ts:63`), which `src/worker.ts:6` already imports. Pass `agentDirectory()`. Use one shared helper to format the result.
2. Append it to the instructions at all three sites: `execution.ts:482`, `background.ts:315`, and swarm workers (`swarm.ts:177`, which reach `background.ts`; avoid adding it twice).
3. Use the final cwd, after worktree creation (`execution.ts:469`, `background.ts:300`).
4. Add agent option `contextFiles?: boolean`, default true: `AGENT_OPTIONS` (`validation.ts:7`), `AgentOptions` in `src/index.ts`, the README table (`:156`) and the guide (`guide.ts:73`). An unset option must not change a fingerprint, which `JSON.stringify` already ensures for `undefined`. Check that this holds after `resolveOptions`.
5. Update `README.md:140` and `guide.ts:87`: agents get context files, but still not extensions, MCP tools or skills.

**Tests:** add a faux-model directive that echoes the system prompt (`test/helpers.ts:33`). A sentinel in the project's `AGENTS.md` reaches `ctx.agent`, `ctx.spawn` and a swarm worker, and a worktree agent reads its own checkout. `contextFiles: false` omits it. Isolate `PI_CODING_AGENT_DIR`.

**Done when:** the tests pass.

---

## T8. Make `maxTokens` exclude cache reads; expose tokens in `ctx.budget`

**Status:** open · **Size:** S

**Why:** `inputTokens` includes cache reads and writes (`index.ts:140`), and `maxTokens` limits `input + output`. Cache reads repeat on every turn, so a long cached agent exhausts the limit quickly while spending little. `ctx.budget` also shows only agents and USD (`execution.ts:63-66`), so a token-scaled loop cannot read its allowance. Claude Code's budget counts output tokens only; numbers do not carry over between the two, and this task does not try to make them.

**Do:**

1. Add `cacheReadTokens` to `Usage` (`src/index.ts:94`). `inputTokens` becomes `input + cacheWrite`. Keep the cached count in usage so spend stays explainable.
2. Update `accountConversation` (`index.ts:137-153`, including the delta and `accountedUsage`), `addUsage` (`:116-124`) and the initial usage (`:335`). Treat a missing field as 0 for runs already stored. The checks at `:108`, `:131` and `execution.ts:332` then need no change, but confirm them. Phase tokens (`execution.ts:539`) follow.
3. Add `tokens` to `ctx.budget`: the remaining `maxTokens`, or `null` when uncapped (`execution.ts:63-66`, `src/index.ts:53`, `README.md:123`).
4. Document that `maxTokens` means fresh input plus output, and that cost is the better spend limit.

**Tests:** a faux response with a large `cacheRead` does not trip `maxTokens`, and `costUsd` still counts it. `ctx.budget.tokens` falls after an agent and is `null` when uncapped, and replay returns the journaled read. Usage rolls up to a parent run. Keep `test/engine.test.ts:236` (`inputTokens > 0`) true.

**Done when:** the tests pass and the Nix smoke test passes (`usage` is in the full record).

---

## T9. Remove unchanged worktrees after a run

**Status:** open · **Size:** M

**Why:** Claude Code removes a worktree the agent did not change. Here worktrees are removed only by `revert` (`index.ts:477`), so every successful run leaves checkouts and branches behind under the home.

**Do:**

1. Record the commit each worktree started from. `ensureWorktree` (`worktrees.ts:37`) adds `base` to `Worktree` from `git rev-parse HEAD` before `worktree add`. Save it on `step.worktree` and `run.worktrees` after creation (`execution.ts:469`, `background.ts:300`). The intent is saved before creation (`execution.ts:462-468`), so a crash can leave no `base`: treat that as changed and keep the worktree.
2. New `pruneUnchangedWorktrees(run)`, called in `Engine.execute` after `cleanupBackground` (`index.ts:259`), for completed runs only. Failed and cancelled runs keep theirs for `retry`.
3. Unchanged means `git status --porcelain` is empty and the branch tip equals `base`. Then call `removeWorktree` and delete that branch with a new helper. Deleting is safe because the branch holds nothing. Changed worktrees and their branches stay, as the README promises.
4. Skip a worktree in use by a detached background agent that has not stopped (`background.ts:27`).
5. A pruning failure is logged and never fails the run.
6. Update `README.md:243-245`.

**Tests:** the existing test at `test/engine.test.ts:260` has an agent that changes nothing, yet asserts the worktree stays (`:273`). Change that agent to write a file. Add: an unchanged agent's worktree and branch are gone; an uncommitted change keeps it; a new commit keeps it; a failed run keeps it; a `retry --from` on a pruned step recreates it; a pruning failure leaves the run completed.

**Done when:** the tests pass.

---

## T10. Correct the README comparison

**Status:** open · **Size:** S · **Depends on:** T1–T9 for rows 4–5. Items 1–3 can be fixed at any time.

**Do:**

1. `README.md:7`: says version 0.2.0; the package is 0.4.0. Remove the number so it cannot go stale.
2. `:427`: says "evolving research preview". The cookbook does not call it that; it lists requirements of Claude Code 2.1.154 or later on paid plans. Say instead that the comparison is a design reference and no compatibility is promised.
3. `:433`: lists `budget` as corresponding. Give it its own row: Claude Code has a shared turn-level ceiling on output tokens; this package has per-run limits on agents, cost, tokens and duration.
4. `:438`: note the main difference. Claude Code resumes within a session; this package survives session exit, restart and SIGKILL.
5. Add rows for agent environment, launch approval, default limits (1,000 agents, 16 concurrent per workflow against 8 across the worker) and editing a script before resuming. Write them from what T2–T9 actually shipped.

Keep the table's `:439` row about the unrestricted script environment: it is a deliberate divergence. Check Claude Code's limits against its current docs before stating them, because the feature changes.

**Done when:** every row matches the shipped code and `npm test` passes. `test/unit.test.ts` covers the guide and may assert README text.

---

## Log

- 2026-10-30 Ledger written. `npm test` 44/44 at 43756f5. Headless launches checked against the installed 0.3.2 (T1). Nothing else was changed; no task has started.
