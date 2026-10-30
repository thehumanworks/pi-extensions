Status: working — implementing one run shape (model string, brief JSON views in the CLI)

# Subagent runshape

Branch brain/runshape, spawned 2026-10-30T12:59:34+00:00 by the brain.

## Task

Goal: axeval fix 8 (pi-orchestration/brain/axeval.md lines 79-86 and 129-134): one run shape across the CLI and the Pi tool, so an agent that learned the JSON shape on one surface can parse the other. Work in pi-orchestration/. Changes: (1) Store the run's model in one form whichever surface launched it: always the string "provider/modelId" (engine/index.ts launch path near the model handling; extension.ts run action; cli.ts modelOption). Today CLI runs store a string and tool runs store {provider, modelId}, so list mixes types. (2) CLI status --json, list --json and poll --json emit the tool's brief view {runId, workflow:<name>, status, summary, error?, waitingFor?, result?} using the same function the extension uses (src/presentation.ts / extension.ts brief); status --verbose --json keeps the full record. (3) Attached run --json emits the brief view once, not both id and runId. (4) Update README and help text where they show these JSON shapes. Do not add a compatibility layer for the old shapes (project rule D4). Acceptance: npm run check passes; npm test in pi-orchestration stays 37/37 (current baseline) plus new or updated assertions in test/process.test.ts and/or test/unit.test.ts that CLI status --json, list --json and run --bg --json use runId and a string model, and that the tool's details match. Run npm run build before checking with the local CLI (bin/workflow.mjs runs dist/). Out of scope: brain/loop.sh, BRAIN.md, validation.ts lint (fix 3), anything outside pi-orchestration/, version bumps, publishing, merging to main. Commit on your branch and push brain/runshape; mark your ledger done with test counts.

## Log

- 13:05 Baseline: `npm test` 37/37 pass. Read cli.ts, extension.ts, presentation.ts, engine launch. Plan:
  1. engine launch normalises the chosen model through `resolveModel` to `"provider/modelId"`, so the stored record and launch reply are strings whichever surface launched (RunRecord.model typed as the string form). Extension run action and /workflow command pass the session model as a string too.
  2. presentation.ts owns both views: `runBrief(run).view` (adds `model` when set) and a new `runListView(runs)` moved out of extension.ts. CLI status/poll/run(attached)/cancel/retry/revert `--json` emit the brief view; list `--json` emits `runListView`; `status --verbose --json` and `watch --json` keep the full record.
  3. Tests: process.test (CLI run --bg/status/list/run --json shapes, string model via a sandbox models.json), extension.test (tool details carry the same keys and string model), engine.test (object model input is stored as a string).
