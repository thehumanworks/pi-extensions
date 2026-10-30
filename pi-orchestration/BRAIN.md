# BRAIN

The ledger of the pi-orchestration improvement loop: decisions, knowledge, and every action with its outcome. `brain/loop.sh` passes this file to every tick as part of the system prompt. The Log stays last, so new entries are appended to the end.

Goal: optimise what an agent sees and experiences when it uses pi-orchestration through the standalone `workflow` binary (isolated from Pi) and through the Pi extension (`workflow` tool, `/workflow`).

## Decisions

- D1 (user, 2026-10-30): Workflow launches need no user approval. Remove the gate from the package entirely: the confirm dialog, `/workflow approval`, the `workflow.approval` setting, the TUI status, `PI_WORKFLOW_ALLOW_UNATTENDED`, and their docs and tests. No compatibility shim. Keep the `not_from_root` guard, which stops inner workflow agents from launching runs; it is not a user approval.
- D2 (user, 2026-10-30): Workflow files are project source and must never be added to .gitignore. Say so where agents look: the guide (`src/guide.ts`), the tool description (`src/extension.ts`), `workflow init` output (`src/cli.ts`) and the README. Also remove the two ignore lines in `bot/.gitignore` (13 and 15) and commit those workflow files; they exist only in the main checkout (`/home/nixos/pi-extensions/bot/.pi/workflows/`), so copy them from there without modifying it.
- D3 (user, 2026-10-30): Push freely to brain/orchestration and brain/<name> feature branches. Never push to or merge into main; the user merges to main at the end.
- D4 (user, 2026-10-30): The project does not add legacy compatibility layers; use the current contract directly.
- D5 (setup): The brain works in the worktree `.pi/worktrees/brain-orchestration` on branch brain/orchestration, based on main at f21d735. The main checkout holds the user's uncommitted work (pi-loggly, root README.md, package.json, package-lock.json) and must not be modified.
- D6 (setup): Subagents are interactive Pi sessions in the herdr session `pi-brain`, each in its own worktree and workspace, started with `brain/loop.sh spawn`. At most 2 at a time. Model: the user's default (openai/gpt-6.1-sol, high).
- D7 (user, 2026-10-30): The tick rules live in `brain/loop.sh` and belong to the brain; it may change them. The ledger must be updated every tick.
- D8 (setup): Pi on this machine loads `npm:@nothumanwork/pi-orchestration` (0.2.1), not this checkout, so changes here only reach the installed tool after a publish, which is the user's call. Test changes with `npm test`, the local CLI (`node pi-orchestration/bin/workflow.mjs`) or `pi -e ./pi-orchestration/index.ts`.

## Baseline

`npm test` in pi-orchestration at f21d735: 38 tests, 35 pass, 3 fail. None of the failures is caused by the worktree.
1. `test/engine.test.ts:158` "catalog reports a broken file without hiding valid workflows": the catalog also lists the user's global `~/.pi/agent/workflows/resolve-bot-main.ts`. The test is not isolated from the user's home directory.
2. `test/nix-lock.test.ts:5`: `nix/package-lock.json` says 0.2.0 while `package.json` says 0.2.1 (`nix/update-lock.sh` regenerates it).
3. `test/package.test.ts:46` "prepack builds a source-only checkout": `npm run check` in the copied package cannot find `@types/node`, because `installedNodeModules()` picks `pi-orchestration/node_modules`, which holds only jiti in a workspace install.

## Agents

- None active. `approval` merged at `70ae028` and retired in tick 4; branch `brain/approval` stays on origin.

## Backlog

Ordered by priority. Mark directions ✅ or ❌ as evidence comes in.

1. D1 approval-gate removal: ✅ merged in tick 4 (`70ae028`). Only follow-up: after the user publishes, drop `PI_WORKFLOW_ALLOW_UNATTENDED` and stale launch-approval guidance from `brain/loop.sh` (D8). The Nix installed-wrapper smoke was not run by `approval`.
2. Workflow files are source (D2): ✅ bot workflows now tracked and ignore rules removed (tick 2). Remaining: guide, tool description, `init` output and README. Now unblocked: `approval` has merged, so no file overlap remains.
3. Fix baseline failures so a red test means a regression. ✅ Package source-only fixture fixed in tick 3: after the D1 merge the brain result is 33/35 passing (D1 replaced five gate tests with two matrices). Remaining: isolate catalog from the user's home; refresh standalone Nix lock metadata and its dependency hash without bumping package versions.
4. Unexplored directions for the goal:
   - One output contract: the tool and the CLI return the same JSON shapes, and every CLI command supports `--json`.
   - Errors name the next command to run; error codes are stable and documented.
   - `validate` and `catalog` warn when a workflow file is git-ignored or untracked.
   - `status` shows what changed since the caller last looked; long runs get a compact progress view.
   - Parity: an agent outside Pi gets the same guide (`workflow guide`) and examples as one inside Pi.
   - Exit codes that scripts and agents can branch on.
   - ✅ Reproduced: a long `--home` produces opaque `connect EINVAL …/worker.sock` (tick 2); diagnose Unix socket path limits with an actionable shorter-home hint.
   - An agent-experience evaluation: give fresh agents tasks through only the CLI or only the tool, and count wrong turns. This measures progress on the goal instead of guessing.

## Lessons

- Supervisor, after tick 1: the approval brief told the subagent to drop PI_WORKFLOW_ALLOW_UNATTENDED from brain/loop.sh. That would break headless workflow launches here, because the installed Pi runs npm 0.2.1 (D8) until the user publishes. The subagent was told to leave loop.sh alone. Check every change to the loop's own environment against D8.
- Tick 1: `loop.sh spawn` completed in 43 seconds (30 seconds installing dependencies). Verify Herdr `agent_status=working` after submission, not merely a successful prompt write. Keep delegated scope explicit so the brain can work on adjacent priorities without overlapping files.

- Tick 2: test copied workflows via local CLI `validate`, not a live launch: historical prompts target the main checkout. A short isolated `--home` works; a socket path beyond Unix limits returns an opaque `EINVAL` before creating the home.
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
