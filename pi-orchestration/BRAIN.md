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

- `approval`: working (spawned tick 1), branch `brain/approval`, worktree `/home/nixos/pi-extensions/.pi/worktrees/brain-approval`, ledger `pi-orchestration/ledgers/approval.md`. Owns D1 gate removal across CLI/extension/docs/tests and obsolete loop environment/rules. Verified Herdr `agent_status=working` at 10:52. Review and test before merging.

## Backlog

Ordered by priority. Mark directions ✅ or ❌ as evidence comes in.

1. D1 approval-gate removal: delegated to `approval` in tick 1. Await implementation, then review diff, run `npm test` in its worktree and merge only if no worse than baseline. Retain `not_from_root` on all launch paths; do not confuse business `ctx.signal()` approval examples with the removed launch policy.
2. Workflow files are source (D2): guide, tool description, `init` output, README, `bot/.gitignore`.
3. Fix the 3 baseline failures so a red test means a regression.
4. Unexplored directions for the goal:
   - One output contract: the tool and the CLI return the same JSON shapes, and every CLI command supports `--json`.
   - Errors name the next command to run; error codes are stable and documented.
   - `validate` and `catalog` warn when a workflow file is git-ignored or untracked.
   - `status` shows what changed since the caller last looked; long runs get a compact progress view.
   - Parity: an agent outside Pi gets the same guide (`workflow guide`) and examples as one inside Pi.
   - Exit codes that scripts and agents can branch on.
   - An agent-experience evaluation: give fresh agents tasks through only the CLI or only the tool, and count wrong turns. This measures progress on the goal instead of guessing.

## Lessons

- Supervisor, after tick 1: the approval brief told the subagent to drop PI_WORKFLOW_ALLOW_UNATTENDED from brain/loop.sh. That would break headless workflow launches here, because the installed Pi runs npm 0.2.1 (D8) until the user publishes. The subagent was told to leave loop.sh alone. Check every change to the loop's own environment against D8.
- Tick 1: `loop.sh spawn` completed in 43 seconds (30 seconds installing dependencies). Verify Herdr `agent_status=working` after submission, not merely a successful prompt write. Keep delegated scope explicit so the brain can work on adjacent priorities without overlapping files.

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
