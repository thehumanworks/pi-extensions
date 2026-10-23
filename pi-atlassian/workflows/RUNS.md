# Local orchestration run history

> This is historical evidence for the v1 runs. Interactive write approval below was the policy at that time; it has since been removed. Current writes are authorized by trusted runtime opt-in plus exact single-use plan confirmation; see [README.md](../README.md).

Dagu2.18.2 / Pi1.0.4. All generation/review uses Pi as harness, provider openai with Codex OAuth. Execution: gpt-6.1-sol; research/review: gpt-6-luna. Source/workflows/prompts are versioned; tenant credentials are external and never logged. The initial v1-manifest.json is retained; later state is separately hashed in v1-current-manifest.json.

| Run ID | Workflow / models | Outcome | Evidence / lesson |
| --- | --- | --- | --- |
| atlassian-research-v1-001 | Initial research / luna | Aborted | Top-level name failed validation; stopped duplicate. Require validate success before launch. |
| atlassian-research-v1-002 | research / 2x luna | Succeeded | Exclusive API/agent research, ~3m12s. |
| atlassian-build-v1-001 | build / 2x sol | Succeeded | ~20m50s; source plus independent tests;72 offline tests. Numeric page-ID success path fixed. |
| atlassian-review-v1-001 | verify --only independent_review / luna | Succeeded | ~2m4s; bare-host/hybrid-page/TLS integration findings needed repair. |
| atlassian-repair-v1-001 | repair / sol | Succeeded | Safe host/continuation normalization, lossless bounded paging, TLS/path fixes;104 offline tests. |
| atlassian-verify-v1-001 | verify / luna review | Failed overall | Typecheck/offline checks/review succeeded; .env-authoritative live auth failed. Review found no remaining offline blockers. |
| atlassian-verify-v1-002 / -003 | verify --only live_readonly_e2e | Failed | Genuine auth errors retained. Disabling Dagu dotenv loading/adding overload did not make the new token valid. |
| atlassian-agent-smoke-v1-001 | native Pi smoke / sol | Not valid evidence of live success | Model exit alone could report failed checks. Added deterministic verdict gate. |
| atlassian-agent-smoke-v1-002 / -003 | native Pi smoke / sol | Failed | Discovery/loadout fixed; authoritative .env auth failed. Gate correctly failed false/skipped verdicts. |
| atlassian-env-probe-v1-001 through -008 | safe one-read diagnostics | Failed | Presence/shape only; no credential values. Private ephemeral HMAC comparison proved token mismatch, then was deleted. Experiments with parent-env capture distinguished isolation vs credentials. |
| atlassian-env-probe-v1-009 | explicitly captured inherited config | Succeeded | Proven working inherited credentials, NOT new-token validation. Removed this fallback from final diagnostic workflow. |
| direct service E2E (default dotenvx precedence) | supervisor read-only |5 passed, no skips | Used already-defined inherited token. Do not attribute to new encrypted .env token. |
| direct native Pi smoke003 | supervisor / sol |5 checks PASS, no skips | Actual index.ts + builtin codemode, only two active declarations, no writes; inherited credentials. Private alternate TMPDIR and deterministic JSON gate. |
| atlassian-write-controls-v1-001 | controls / sol | Implementation succeeded; workflow failed | CLI/TUI/revocation +12 regressions;117 tests passed in alternate temp. Follow-on workflow tests failed because shared /tmp was full (ENOSPC), not code. |
| atlassian-write-controls-review-v1-002 | isolated controls review / luna | Succeeded; one blocker |117/117 tests; one incorrect session-replacement scope claim/fake test. |
| atlassian-write-scope-v1-001 | scope correction / sol | Succeeded | Corrected only docs/test lifecycle simulation; strict TypeScript and117 tests passed. New/resume/fork creates fresh runtime; tree alone retains toggle. |
| final direct .env-authoritative E2E (--overload) | supervisor read-only | Failed | HTTP401 with supplied decrypted token. Existing inherited token is present and default dotenvx preserves it. Credentials/auth routing remain an external blocker. No live mutations. |

## Orchestration decisions

- Stable public service boundary and exclusive file ownership allow research/build/test concurrency without shared-file races. No recursive delegation or live tenant access by code/review agents.
- Discovery/schema and exact source reading are composable; startup does not dump schemas/bodies. API catalog is generated from official public specs, not research guesses.
- Dagu flags/step references are verified by schema/validate. Use filename-derived names; validate is a launch precondition.
- Live tests force authoritative dotenvx injection, preserve real failures and never mutate. Default inherited-env precedence must be disclosed.
- Native Pi smoke must actually exercise callable tools, await async discovery and validate semantic verdicts—not rely on model exit0.
- Write opt-in is separate from exact plan confirmation and interactive approval. OFF revokes pending work; source context survives toggling. Fresh extension runtimes initialize from env/CLI.
- Workflows explicitly set private .atlassian/tmp; do not delete unrelated full-/tmp data. The parent shell's TMPDIR is not implicitly inherited by Dagu.

For incompatible contract/ownership changes, create a new major workflow directory and retain prior source. Compatible iterations retain prompts, notes and hashes here; use fresh run IDs and inspect the working tree before launching writers.
