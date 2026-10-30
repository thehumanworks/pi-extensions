Status: working — just started

# Subagent validate1

Branch brain/validate1, spawned 2026-10-30T14:19:35+00:00 by the brain.

## Task

Goal: make 'workflow validate' (CLI) and {action:"validate"} (Pi tool) report every problem in one pass, refuse at launch what validate rejects, and lint I/O in run() control flow. Source: brain/axeval2.md fixes 6 and 7 (lines ~186-195), measured in axeval2 scenario 2 (an agent needed several validate/run rounds because load errors hid lint findings and Date.now()/{tool:[]} only failed after a run was created).
Work in pi-orchestration/:
1. src/loader.ts validateWorkflow (~line 86): when loading fails but the file path resolves, still run lintDeterminism on the source and merge its diagnostics with the load error. Give load diagnostics path, line and column when the message has a file:line:col suffix.
2. src/engine/index.ts launch (~line 299, where args are checked): lint the workflow source before creating a run and throw WorkflowError('invalid_workflow', ...) listing the diagnostics (line numbers and codes), so nothing is created. CLI exit code for invalid_workflow must be 1 (check errorInfo in src/cli.ts).
3. src/validation.ts (~lines 29-70, next to the timer-import tracking): track names imported from fs, fs/promises, child_process (with or without node: prefix) plus global fetch; report calls in run() control flow outside ctx.step as code nondeterministic_call with message like 'readFileSync() is I/O; move it into ctx.step().' and the line. The examples/ directory must still validate clean (they are the lint's regression suite).
Acceptance: npm run check clean; npm test passes (baseline 38/38 at b63b97e); new tests in test/unit.test.ts or test/engine.test.ts for: a file with a load error plus a Date.now() shows both; launch of a workflow with {tool: []} fails invalid_workflow with no run created; readFileSync in run() outside ctx.step is reported, inside ctx.step is not. Check each new assertion fails against the old source. Run npm run build before trying bin/workflow.mjs (it runs dist/).
Rules: keep engine messages surface-neutral (no CLI commands in engine errors). No compatibility shims. Do not touch brain/loop.sh, BRAIN.md, README beyond a line if behaviour docs change, or the extension's schemas. Commit on brain/validate1 and push; write progress and 'done' in your ledger.

## Log

- 14:23 Read brief, axeval2 fixes 6–7 and scenario 2, loader.ts, validation.ts, engine launch, cli errorInfo (invalid_workflow already exits 1). Baseline `npm test` at 2e72547 under load avg ~27 (other agents, chromium, tsc): first run failed `a SIGKILLed worker resumes runs…` (process.test.ts, "never reached its sleep"); a second run failed the two process/package timing tests instead. These are timeouts from machine load, not the code; I'll rerun them in isolation before calling done.
