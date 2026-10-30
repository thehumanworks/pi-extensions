Status: working — just started

# Subagent worker1

Branch brain/worker1, spawned 2026-10-30T15:29:18+00:00 by the brain.

## Task

Goal: a running pi-orchestration worker must not keep serving old code after an upgrade or 'npm run build' (Backlog 000.1 in pi-orchestration/BRAIN.md; evidence in pi-orchestration/brain/axeval3.md, 'Ranked fixes' item 1). Today src/client.ts:56 ready() compares only PROTOCOL_VERSION (src/protocol.ts:6, WorkerStatus at :11), and the worker's ping reply (src/worker.ts:58) sends {version, pid, home, uptimeMs}. Do: (1) add a build id to the ping reply and WorkerStatus: package version from package.json plus something that changes on every build of the running code (e.g. mtime or hash of the worker's own module file via import.meta.url); share one function between worker and client. (2) In ensureWorker/ready (src/client.ts:54-75): when the build differs and the worker has no non-terminal runs, stop it and start a fresh one transparently; when it has active runs, keep using it and surface a one-line warning naming the fix (CLI: stderr 'Workflow worker runs an older build (<old>); stop it with <program> worker stop when its runs finish.'; tool: append the same advice using the tool's own words, no CLI command in the engine). Keep messages surface-neutral in the engine/client and let cli.ts/extension.ts word the next step (the project pattern since tick 37). (3) 'worker status' text shows the build. Tests: a process or engine test that starts a worker, fakes a different build id (e.g. an env override or an injectable function) and asserts an idle worker is replaced (new pid) and a busy one is kept with the warning. Baseline: npm test in pi-orchestration 42/42 at b057433. Run 'npm run build' before using bin/workflow.mjs (it runs dist/). Use a short --home under /tmp (socket path limit). Also run the Nix smoke test if CLI output shape changes: see BRAIN.md Lessons (supervisor release check 14:30). Out of scope: protocol changes beyond the ping reply, lint, docs other than one README line, brain/loop.sh, versions. No legacy compatibility layer (D4). Commit on brain/worker1 with tests green, push, and mark your ledger done.

## Log
