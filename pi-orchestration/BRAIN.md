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

- `axeval` (spawned tick 8, 11:30; task `303a9c1`, herdr w4:p1): agent-experience evaluation of the CLI and the Pi tool through 4 scenarios; delivers `brain/axeval.md` with wrong turns and a ranked fix list. Evaluation only, no src/ changes.
  Its scenario 1 finding "hints drop --home" was fixed in tick 9; drop it from its ranked list on merge.
- `approval` merged at `70ae028` and retired in tick 4; branch `brain/approval` stays on origin.

## Backlog

Ordered by priority. Mark directions ✅ or ❌ as evidence comes in.

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
- Tick 3: a package-local node_modules can exist but contain only overrides (jiti here). Copied-package fixtures must verify the required dependency set before selecting a directory, not stop at its existence.

## Questions for the user

None.

## Log

### Tick 0 · 10:50 · Setup (interactive session with the user)
- Action: created this worktree and branch, brain/loop.sh and this ledger; installed dependencies; ran the baseline tests.
- Outcome: baseline recorded above (35/38 pass). Loop started in the herdr session pi-brain.
- Value: ✅
- Lesson: `npm test` takes about 15 seconds after `npm ci` (about 35 seconds) in a fresh worktree.

### Tick 1 · 10:52 · Delegate approval-gate removal
- Action: spawned `approval` for D1, the highest-priority user decision and too broad for a four-minute tick. The brief covers CLI and extension launches, obsolete loop environment/rules, documentation, and regression tests; it excludes D2 and unrelated baseline fixes.
- Outcome: task committed and pushed as `efdc0f5` on `brain/approval`; Herdr workspace `w3`, pane `w3:p1`, confirmed `agent_status=working` at 10:52. Acceptance requires root interactive/headless launches without approval, nested launches still returning `not_from_root`, `npm run check`, `npm test` compared with 35/38 baseline, and `bash -n` for loop changes. No code changed in the brain worktree this tick, so no test rerun yet.
- Value: ✅ yielded value — the largest explicit request now has an independently running implementer and verifiable acceptance criteria.
- Lesson: delegate multi-surface removal as one coherent task; retain the recursion guard explicitly and avoid deleting unrelated signal-based approvals.

### Tick 2 · 10:55 · Track bot workflow source
- Action: completed the source-control part of D2 without overlapping `approval`'s active CLI/extension edits. Copied the two existing workflows from the main checkout, removed their individual ignore rules and documented the source policy in `bot/.gitignore`; did not modify the main checkout or run either workflow.
- Outcome: committed and pushed `42887ba`. `native-web.ts` and `bot-workspace.ts` are byte-identical to the originals (`cmp`); neither is git-ignored. Local CLI `validate --json` reports both valid with zero diagnostics. `npm test`: 38 tests, 35 pass, the same 3 baseline failures. Long isolated `--home` first reproduced `connect EINVAL`; a shorter home validated both and its worker stopped successfully. Remaining D2 authoring guidance stays in Backlog. Cleanup of untracked `.b2/` (only `runs.sqlite`, `runs.sqlite.owner`, `worker.log`) was refused by the harness's agent-definition deletion guard even with exact filenames; no agents or definitions were involved. Leave it alone unless a safe cleanup path is available.
- Value: ✅ yielded value — real workflow definitions will now travel with project source instead of silently disappearing from Git.
- Lesson: split adjacent work by conflict boundaries; validate historical source without executing its old implementation prompts. Capture incidental CLI failures as reproducible backlog items.

### Tick 3 · 11:03 · Repair source-only package verification
- Action: fixed dependency selection in `test/package.test.ts` while `approval` finished adjacent launch-policy work. The fixture now checks every declared dependency before selecting local or hoisted node_modules; regression assertions cover a dangling local link, a partial local install, a complete local install and no complete install. Existing scratch `.b2/` was not modified by this tick.
- Outcome: `npm run check` and `git diff --check` passed. `npm test`: **38 tests, 36 pass, 2 fail**, improving the original 35/38 baseline. The source-only copied package now passes its real typecheck, prepack, compiled CLI/guide and loader validation checks. Remaining failures are the original global-catalog leak and stale Nix lock version. `approval` became done at `53b421f` during verification; review/merge is deliberately deferred to the next tick rather than rushed into this action.
- Value: ✅ yielded value — packaging regressions are now detectable instead of hidden behind a broken workspace fixture.
- Lesson: dependency directories are not necessarily complete installs; exercise the hoisted-plus-local-override layout explicitly.

### Tick 4 · 11:05 · Review and merge D1 approval-gate removal
- Action: reviewed `brain/approval` (13 files, +114/−237): `assertUnattended`, the confirm dialog, `/workflow approval`, `workflow.approval`, footer status and session restoration are gone; `assertRootLaunch` stays on the CLI, client and extension tool paths and run/step markers are still set for inner agents. Merged with `--no-ff` because the review and test run fit in one tick and unblock D2's guidance edits.
- Outcome: merge `70ae028`, pushed. `npm test` on the merged branch: **35 tests, 33 pass, 2 fail**. The 2 are the known catalog leak from the home directory and the stale Nix lock, so it is no worse than the baseline: the merge brought the subagent's 32/35 together with tick 3's package fixture fix. `grep` for `UNATTENDED|workflow.approval|assertUnattended` in src, test and README finds nothing. `loop.sh retire approval` succeeded.
- Value: ✅ yielded value: user decision D1 is implemented on brain/orchestration with regression coverage for the root guard in all four Pi modes.
- Lesson: when the brain has fixed the baseline on its own branch, compare the subagent's result after the merge, not before.

### Tick 5 · 11:10 · State the workflow-source policy where agents look (D2)
- Action: finished D2 myself instead of spawning: four one-sentence edits fit a four-minute tick and no subagent was running. Added "workflow files are project source: commit them, never add them to .gitignore" to `src/guide.ts:53`, the tool description `src/extension.ts:19`, `workflow init` output `src/cli.ts` (init case) and README.md (resolution paragraph, line 113).
- Outcome: `npm run check` passes; `npm test` **35 tests, 33 pass, 2 fail**, the same two baseline failures (catalog home leak, Nix lock). Local CLI verified: `init demo --cwd /tmp/brain-t5` prints the new `Commit it:` line after `Next:`, and `guide` prints the policy in section 1. Existing `test/unit.test.ts:120` regex still matches the init output.
- Value: ✅ yielded value: user decision D2 is fully implemented on brain/orchestration.
- Lesson: small text-only guidance changes are faster done directly than delegated; spawning costs a minute plus a review tick.

### Tick 6 · 11:16 · Isolate fixture catalogs from the user's home
- Action: fixed baseline failure 1 instead of spawning, because a one-line fix leaves exactly one known red test, so any future red is a regression signal. The in-process worker resolves user workflows through `agentDirectory()` (`src/paths.ts:5`), so the user's `~/.pi/agent/workflows/resolve-bot-main.ts` leaked into catalog fixtures. `fixture()` in `test/helpers.ts` now points `PI_CODING_AGENT_DIR` at its own temp root.
- Outcome: `npm run check` passes; `npm test` **35 tests, 34 pass, 1 fail**. The only failure is the stale `nix/package-lock.json` version (0.2.0 vs 0.2.1).
- Value: ✅ yielded value: the suite no longer depends on the machine's home directory.
- Lesson: in-process workers read `process.env` at call time, so fixtures must isolate every path that env resolves, not only `--home`.

### Tick 7 · 11:21 · Actionable error for over-long workflow homes
- Action: replaced the opaque `connect EINVAL …/worker.sock` (reproduced in tick 2) with a stable error, because it was the only backlog item that was concrete, small and directly about what an agent sees. The Nix lock fix needs `nix develop` and a hash prefetch, which does not fit a four-minute tick. `assertSocketPath` in `src/paths.ts` checks the socket path against sun_path (107 bytes on Linux, 103 on macOS); `rpc` (`src/client.ts`) and `startWorker` (`src/worker.ts`) call it before connecting or creating the home.
- Outcome: `npm run check` passes; `npm test` **36 tests, 35 pass, 1 fail**, the only failure the known Nix lock. New test in `test/unit.test.ts` covers both limits and the client path. Local CLI with a 110-character home prints `Error home_too_long: … is 127 bytes, the limit is 107. Pass a shorter --home or set PI_WORKFLOW_HOME to a shorter directory.` and creates no directory.
- Value: ✅ yielded value: an agent that picks a deep temp directory for `--home` now gets the fix in the error instead of an errno.
- Lesson: validate inputs whose limits come from the OS before the first side effect, and name the flag or variable that fixes them.

### Supervisor · 11:30 · Release 0.3.0 and fast-forward main (user request)
- Action: the user allowed merging to main and asked for a version bump to publish. Paused the loop with brain/STOP after tick 7, bumped pi-orchestration to 0.3.0 (breaking for 0.x: `/workflow approval`, `workflow.approval` and `PI_WORKFLOW_ALLOW_UNATTENDED` are gone), regenerated nix/package-lock.json (only the version fields changed) and set the new npmDepsHash. The root package-lock.json was left alone, as in earlier bumps, because the user has uncommitted changes in it.
- Outcome: `npm test` 36/36; `nix build .#workflow` 36/36 plus the installed smoke; `npm pack --dry-run` ships 92 files with no BRAIN, brain/, ledgers, test or nix files. main fast-forwarded to brain/orchestration in the main checkout, preserving the user's staged work; main is not pushed. Loop restarted.
- Value: ✅
- Lesson: the main checkout keeps staged user work, so a non-fast-forward merge there would abort. Keep brain/orchestration a descendant of main so releases stay fast-forwards.

### Tick 8 · 11:30 · Spawn the agent-experience evaluation
- Action: spawned `axeval` to run 4 scenarios as a fresh agent (CLI author-validate-run-poll-result, broken-workflow errors, signal discovery from status, the Pi tool headless) and rank fixes by wrong turns. Chosen over another small fix because the backlog's remaining items are guesses; an evaluation turns them into evidence, and it is too long for one tick.
- Outcome: `loop.sh spawn` took 44 seconds; task committed as `303a9c1` on `brain/axeval`, Herdr w4:p1 confirmed `agent_status=working`. Found while writing the brief: `workflow --help` already documents exit codes, so that backlog item shrinks to a parity check. No code changed; tests not rerun (36/36 at aeb0bc2).
- Value: ✅ yielded value: the next code changes will be chosen from observed wrong turns, not guesses.
- Lesson: read the surface's own help before adding a backlog item; one listed gap was already closed.

### Tick 9 · 11:34 · Next-step hints keep --home
- Action: fixed the first wrong turn `axeval` logged in scenario 1 (its ledger): hints printed after `run --bg`, detach, `init`, `watch`/`status --verbose` trees and the foreground run dropped `--home`, so a copied `workflow poll <id>` hit the default worker and returned `not_found`. Chosen over waiting for the full report because it is observed, small and independent of axeval's remaining scenarios (axeval changes no src/). `src/cli.ts:184-207` builds a `hint` prefix (`workflow --home DIR`, shell-quoted when needed) used at every hint site; usage and help text keep the bare program.
- Outcome: `npm run check` passes; `npm test` **37 tests, 37 pass** (new test in `test/unit.test.ts` covers quoted, plain and absent `--home`). Committed `4eb0dc1`; axeval was told via herdr prompt (still `working`) to list it as fixed.
- Value: ✅ yielded value: an agent with an isolated home can now copy-paste every next step.
- Lesson: act on a subagent's partial findings when they are concrete and outside its write scope; no need to wait for the final report.
