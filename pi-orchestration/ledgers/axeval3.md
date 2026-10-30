Status: working — just started

# Subagent axeval3

Branch brain/axeval3, spawned 2026-10-30T14:49:19+00:00 by the brain.

## Task

Goal: measure the agent experience of pi-orchestration after the axeval2 fixes, as a third evaluation round. Read brain/axeval2.md (in pi-orchestration/) first: repeat its scenarios S1-S4 (sessions A-D in S4) with the same model and method so wrong-turn counts compare. Round-two counts: S1 0, S2 4, S3 0, S4 A/B/C/D 0/0/0/13. Fixes since then to check: attached run returns at a signal wait (cli.ts poll), waitingLines with Deliver with/Expects in every renderer (presentation.ts), surface-neutral result_not_ready plus per-surface hints, tool signal reply, typed tool value (extension.ts), typebox import hint (loader.ts), exit 1 for unknown_signal/unknown_agent_option/unknown_context_member, not_found hints, validate reports all load errors and lint findings in one pass, launch refuses lint failures (invalid_workflow), nondeterministic_call lint for fs/child_process/fetch outside ctx.step, '1 agent' pluralisation. Deliverable: pi-orchestration/brain/axeval3.md with per-scenario wrong turns vs round two, transcripts summarised, and a ranked fix list naming file:line and expected effect; update your ledger to done. Traps: the installed Pi loads npm 0.2.1, so use 'pi -e ./pi-orchestration/index.ts' for the local extension; bin/workflow.mjs runs git-ignored dist/, so run 'npm run build' in pi-orchestration first; Pi boolean flags such as --no-memory swallow the next positional argument, so put the message after '--'; use a short --home under /tmp (Unix socket path limit). Write scope: brain/axeval3.md and your ledger only. You may run temporary source experiments to measure a candidate fix, but revert them before committing. Baseline: npm test 40/40 in pi-orchestration. Out of scope: committing source changes, main, versions, publishing.

## Log
