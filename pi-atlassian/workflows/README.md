# Reusable Atlassian development workflows

> **Historical v1 workflows:** these retained prompts/contracts describe the original build, including its former per-write UI approval gate. They are not the current runtime contract and must not be replayed to restore that gate. Current field discovery and write authorization are documented in [README.md](../README.md) and [docs/journeys.md](../docs/journeys.md); version incompatible workflow changes separately as described below.

## v1.0.0

Definitions and prompts live in `v1/` and are ordinary version-controlled source files. Do not modify orchestration from a subagent. Each parallel step has exclusive file ownership; the supervisor integrates changes and runs the checks.

Dagu 2.18.2 and Pi 1.0.4 were used for the initial build. `harness.run` invokes Pi, not the Codex CLI. This Pi version exposes the Codex **OAuth** backend as provider `openai` (verified with `pi auth check --provider openai --json`: `authType: oauth`). Models are `gpt-6-luna` for research/review and `gpt-6.1-sol` for implementation. No API key provider fallback or different model is configured.

```sh
pi auth check --provider openai --model gpt-6-luna --json
pi auth check --provider openai --model gpt-6.1-sol --json
dagu validate workflows/v1/atlassian-research-v1.yaml
dagu start workflows/v1/atlassian-research-v1.yaml --run-id <unique-id> -- WORKSPACE="$(pwd)"
dagu status atlassian-research-v1 --run-id <unique-id>
```

DAG names come from filenames; do not add a top-level `name` to an entrypoint definition. Always require successful `dagu validate` before `dagu start`.

Available stages:

| Definition | Purpose |
| --- | --- |
| `v1/atlassian-research-v1.yaml` | Parallel API and Pi/journey research (`gpt-6-luna`) |
| `v1/atlassian-build-v1.yaml` | Parallel implementation and independent tests (`gpt-6.1-sol`), then offline checks |
| `v1/atlassian-verify-v1.yaml` | Offline checks, read-only live tests under `dotenvx run --`, independent review (`gpt-6-luna`) |
| `v1/atlassian-repair-v1.yaml` | One integration writer (`gpt-6.1-sol`) then typecheck/tests |
| `v1/atlassian-agent-smoke-v1.yaml` | Actual Pi read-only codemode journeys (`gpt-6.1-sol`) plus deterministic JSON verdict gate |
| `v1/atlassian-write-controls-v1.yaml` | CLI/TUI write controls (`gpt-6.1-sol`), checks, independent review (`gpt-6-luna`) |
| `v1/atlassian-write-scope-v1.yaml` | Targeted lifecycle documentation/test correction (`gpt-6.1-sol`) and checks |
| `v1/atlassian-env-probe-v1.yaml` | One authenticated read with only presence/category assertions; no values |

Research/build/verify are separate launch points so the supervisor can inspect evidence between stages. Only run repair after all code/test writers have stopped. Use `dagu start ... --only independent_review` for an isolated review, or `--only live_readonly_e2e` for an explicitly authorised live smoke without regenerating code. Repeat a stage with a new run ID; `dagu retry ... --run-id <id> --step <step>` retries a failed step, not successful independent siblings.

Run from the package root, or pass its absolute path as WORKSPACE. Prompts use @files relative to that working directory. Agent outputs/logs are Dagu-run artifacts; findings and implementation remain local files. Credential values must never be placed in a prompt, workflow, or log. Subagents disable discovered extensions, MCP, project configuration, and recursive delegation for reproducible runs; this is not an OS sandbox.

### Runtime and credential isolation

Create the private ignored temp location before launching workflows (the host `/tmp` filled during this build; no unrelated files were deleted):

```sh
mkdir -p .atlassian/tmp
chmod 700 .atlassian .atlassian/tmp
```

DAGs explicitly set `TMPDIR` because Dagu does not inherit arbitrary parent variables into subprocesses. `dotenv: []` prevents automatic credential-file loading by Dagu. Only the dedicated live steps invoke dotenvx; code/review agents never receive tenant credentials. To validate the provided encrypted file rather than a pre-existing token, use `dotenvx run --strict --overload -- npm run test:e2e`. Dotenvx without overload preserves existing environment values. Final isolated tests of this `.env` receive HTTP401; inherited older credentials passed, but that is **not** validation of the new token. See integration findings. Never convert genuine auth/network failures into successful skips or silently use another token.

The smoke loadout activates only discovery and codemode after session startup. A narrow CLI `--tools` allowlist can remove namespace tools from the callable registry; do not use it as a thin-declaration mechanism. Await codemode discovery helpers. `check-smoke.mjs` validates the final JSON, since a successful model exit does not mean its assertions passed.

Keep stable v1 prompts together with the DAG contract. For incompatible ownership/contract/tool changes, copy to v2/ and retain v1 for replay. Record each run ID, prompt digest, outcomes, checks, and prompt changes in RUNS.md. Use Git to track edits within a version; artifacts and node_modules are not source. Future runs require checking working-tree changes first because agents write to this shared workspace. Avoid launching two code-generating runs against the same paths.
