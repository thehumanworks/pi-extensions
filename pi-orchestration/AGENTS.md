# Working on pi-orchestration

Lessons from building this package with agents. The full record is in `BRAIN.md`: its decisions, its lessons and a log of every change. The agent-experience evaluations are in `brain/axeval*.md`. This file is not published: `package.json` `files` leaves it out.

## Checking a change

- `npm test` builds, then runs `test/*.test.ts`. Write the output to a file and grep `^ℹ (tests|pass|fail)`, so a flaky failure can still be named afterwards.
- `npm test` does not run `nix/smoke-test.mjs`, the acceptance test of the installed `workflow` command. Run it after any change to CLI output or JSON shapes; it once broke unnoticed when `poll` changed shape. The fast way, from the repository root:
  `nix build --impure --no-link --print-out-paths --expr "(builtins.getFlake \"git+file://$PWD?dir=pi-orchestration\").packages.x86_64-linux.workflow.overrideAttrs (_: { doCheck = false; doInstallCheck = false; })"`, then `node pi-orchestration/nix/smoke-test.mjs <out>/bin/workflow`. The release check is the full `nix build .#workflow`, which runs the tests and the smoke test.
- `bin/workflow.mjs` runs the git-ignored `dist/`, not `src/`. Run `npm run build` before trying a change with the local CLI.
- Use a short `--home` under `/tmp`. The worker socket path must fit the Unix limit (107 bytes on Linux), otherwise commands fail with `home_too_long`.
- Workers are detached and outlive the shell, the agent and the worktree. Stop every worker you start: `node bin/workflow.mjs worker stop --home <home>`.
- In-process workers read `process.env` when called. Test fixtures must isolate every path the environment resolves (`PI_CODING_AGENT_DIR` as well as the home), or the user's `~/.pi/agent/workflows` leaks into catalog results.
- Before trusting a new assertion, check it fails on the old source (`git show HEAD:<path>`).

## Conventions

- Workflow files are project source: commit them, never add them to `.gitignore`.
- No legacy compatibility layers: use the current contract directly.
- The engine and client word errors without naming a surface. `src/cli.ts` adds the next shell command, `src/extension.ts` the next tool call, and neither names the other's commands. Shared rendering lives in `src/presentation.ts` (`runBrief`, `runTree`, `waitingLines`, `toolHints`) and `src/engine/mismatch.ts`.
- Error codes are stable. Exit codes are documented in `workflow --help` (0 success, 1 usage/validation, 2 failed, 3 cancelled, 4 worker unavailable), and each documented code needs a test.
- `examples/workflows` is the lint's regression suite: a new lint rule must pass every example.
- Tool-path tests use the fake client in `harness()` (`test/extension.test.ts`): add one branch per action or error code rather than an engine fixture.
- TypeBox 1.x errors carry `instancePath`, not `path`/`value`; resolve the offending value from the pointer. Use the kind-specific guard (`IsObject`) where the contract needs one shape, not `IsSchema`.
- Measure agent experience instead of guessing: give fresh agents a task through only the CLI or only the Pi tool and count wrong turns. `brain/axeval3.md` has the method and the results, and `brain/eval/` has the scenario files and session scripts to rerun it.

## Releasing

1. Bump `version` in `package.json`; in 0.x, bump the minor version when behaviour that users rely on changes.
2. Refresh the standalone Nix lock with `nix develop --command bash nix/update-lock.sh`, and set the printed hash as `npmDepsHash` in `nix/package.nix`. `test/nix-lock.test.ts` fails when the lock lags the manifest.
3. Update the `pi-orchestration` version in the root `package-lock.json`.
4. Run `npm test` and `nix build .#workflow`, then `npm publish` from this directory.
