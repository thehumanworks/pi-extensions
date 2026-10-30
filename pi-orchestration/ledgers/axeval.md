Status: working — just started

# Subagent axeval

Branch brain/axeval, spawned 2026-10-30T11:29:35+00:00 by the brain.

## Task

Goal: measure what a fresh agent experiences using pi-orchestration, and turn the wrong turns into a ranked list of concrete fixes. Do NOT fix code yourself; this task is evaluation only.

Context: pi-orchestration (this worktree's pi-orchestration/ directory) runs durable multi-agent workflows. Two surfaces: the standalone CLI (node pi-orchestration/bin/workflow.mjs; 'workflow --help' lists guide/init/catalog/validate/run/status/poll/watch/list/result/cancel/revert/retry/signal/agents/steer/worker) and the Pi extension (workflow tool + /workflow; source src/extension.ts, guide text src/guide.ts, CLI src/cli.ts). Baseline: npm test in pi-orchestration is 36/36 green.

Method: run at least 4 short scenarios as a fresh agent would, each from a clean temp cwd and a SHORT --home (e.g. /tmp/axN/h; long homes hit home_too_long). Use only what the surface tells you (help text, guide, error messages), not the source, and log every wrong turn: misleading text, missing next step, inconsistent JSON shape between commands, unclear error, extra commands needed. Scenarios: (1) CLI: from nothing, write a 2-agent parallel workflow with init+guide, validate it, run it in the background, poll to completion, read the result. Use a cheap model and --max-agents 2 --max-cost-usd 0.20. (2) CLI: deliberately broken workflow (syntax error, bad args schema, missing export) -> how good are validate errors? (3) CLI: a workflow waiting on ctx.signal -> can the agent discover the key and answer it from status alone? (4) Pi extension: run 'pi -e ./pi-orchestration/index.ts' headless (put the prompt after -- because boolean flags swallow positionals) asking it to use the workflow tool to catalog/validate/run a tiny workflow; inspect what the tool returns. Compare --json output shapes of the CLI with the tool's results.

Deliverable: pi-orchestration/brain/axeval.md committed on this branch: per scenario the commands run, the exact confusing output (quoted), and the wrong-turn count; then a ranked list of at most 10 fixes, each with the file:line to change, the proposed text or behaviour, and the expected effect. Keep cost low (cheap model, small budgets). Out of scope: changing src/ or tests, brain/loop.sh, BRAIN.md, the main checkout, ~/.pi. Mark your ledger done when axeval.md is pushed.

## Log

- 2026-10-30 baseline: `npm test` in pi-orchestration 36/36 green. Starting scenarios with `node pi-orchestration/bin/workflow.mjs` from temp cwds under /tmp/axN.
- Scenario 1 (CLI happy path) done in /tmp/ax1 with anthropic/claude-haiku-4-5: init→edit→validate→run --bg→poll→result works ($0.0006). Wrong turns: next-step hints drop --home (copy-paste → not_found, exit 2, no home named); guide's shell section omits --bg/poll/result; poll's terminal line has no `result` hint; `agents --run` prints raw `[]` for a 2-agent run; JSON keys differ (`runId` vs `id`, result --json is bare value, worker status prints JSON in text mode).
