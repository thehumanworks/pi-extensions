# Canary: measured changes and retention decisions

## Method

Only changes with a demonstrated correctness or compatibility benefit were retained. These are not general speed optimisations.

The baseline is the original `canary.ts`, SHA-256 `f40a3ae67f8d4fa85d391898c5c6286ef88ffd5f92e35243ba7364433ebc0bfa`. The same final test file can target either implementation using `PI_CANARY_EXTENSION`. All 55 original tests and their assertions/handovers remain intact; 16 tests were added, including compatibility controls. The shared real-session helper gained an optional earlier extension fixture.

Tests use Bun 1.4.2 and the installed Pi 1.2.0 SDK. Provider responses are scripted and offline, but lifecycle tests use Pi's actual extension loader, event runner, session history, compaction projection, and continuation machinery. Settings tests use temporary directories, not user settings.

## Retained changes

| Change | Baseline observation | Delivered observation | Value demonstrated |
|---|---|---|---|
| Bound recovery across deferred responses and earlier-extension continuations | Deferred scenario made 7 model requests and compacted; invalid or valid handovers could outlive the budget when another extension continued | Deferred scenario stops after 2 requests, records a recovery pause, makes no compaction, and becomes idle; invalid and valid competing continuations stop at the two-attempt limit | Stops duplicate recovery requests and enforces the existing recovery budget |
| Preserve earlier boundary drafts | Four handler paths dropped the preceding draft; the full real lifecycle kept audit sequence `[1,4,5]` | All four paths preserve the draft; the real lifecycle keeps `[1,2,3,4,5]` | Prevents loss of other extensions' pending state/audit entries |
| Reject Unicode separators/control characters | U+0085, U+2028, and U+2029 were accepted both from settings and commands: 6 invalid inputs accepted | All 6 inputs are rejected before enabling/saving | Makes the single-line/no-control-character contract true for these Unicode cases |
| Accept a leading settings BOM | Both user and trusted-project settings updates failed: 0/2 succeeded | Both updates succeed, preserve unrelated fields, and reload once: 2/2 succeeded | Matches Pi's settings parser without weakening malformed-JSON protection |

The deferred comparison is **7 requests versus 2 for this particular script**, not a claim of typical production savings. The delivered behaviour intentionally pauses for user intervention rather than automatically finishing that script. It does not explicitly cancel or retrieve an already-deferred provider job.

Compatibility controls verify that ordinary deferred responses outside recovery remain ignored, queued user input retains priority over an exhausted budget, and a valid handover on the final allowed attempt is still accepted when no competing continuation prevents compaction. Existing cancellation, headless, lock, malformed-settings, symlink, and successful-recovery tests still pass.

## Proposals not retained

### Exact-heading handover validation: benefit not established

A small evaluation gate requiring all five requested headings:

- rejects `chirp: # Canary handover\nx`;
- also rejects the existing shorter handover fixture;
- still accepts a handover with all five headings and only `x` under every heading.

That demonstrates a formatting distinction, not improved factual completeness or safer continuation. No live/model-quality evaluation established a net benefit, so this structural gate was not added. This does not rule out better handover validation in future.

### Independent failed-summary usage accounting: blocked by the supported API

An offline lifecycle probe made 3 requests with 30 scripted tokens each. Pi reported 60 tokens rather than the expected 90 after rejecting a truncated summary. The gap remains with the delivered code: **30/90 scripted tokens unreported in that scenario**.

`SessionManager.appendUsage()` exists internally, but `ExtensionContext.sessionManager` is a `ReadonlySessionManager` which does not expose it. The public extension API has no independent usage-recording operation. No cast, synthetic assistant message, dummy compaction, or SDK-file modification was retained to bypass that boundary. Successful compaction usage continues to be recorded normally. The limitation is documented in `canary.md`; a supported SDK API is the appropriate follow-up.

### Immediate tool blocking on first detected violation: unchanged

This was an optional product-behaviour change, not a demonstrated optimisation. The documented detector still begins recovery at the end of the user-message span; it is not silently converted into an immediate tool-execution circuit breaker.

## Verification results

| Check | Exact result |
|---|---|
| Original 55-test suite on the saved original implementation | 55 pass, 0 fail, 232 expect() calls |
| Final shared suite on the saved original implementation | 58 pass, 13 fail, 257 expect() calls; the 13 failures are the reproduced defects |
| Final shared suite on delivered implementation | 71 pass, 0 fail, 272 expect() calls |
| Strict TypeScript 5.9.3 check of `canary.ts` and `canary.test.ts` against installed Pi/Bun declarations | Exit 0; no diagnostics |
| Evaluation probes for the two unretained proposals | 2 pass, 0 fail, 4 expect() calls, on both baseline and candidate |

Ablations independently removed one retained change while leaving the other changes enabled. The relevant tests failed again:

| Removed change | Relevant test results |
|---|---|
| Recovery bounds | 0 pass, 3 fail |
| Boundary-draft preservation | 0 pass, 5 fail |
| Unicode rejection | 0 pass, 3 fail |
| BOM handling | 0 pass, 2 fail |

Thus all 13 newly failing baseline cases are attributable to retained changes rather than unrelated test edits. The other 3 added tests are compatibility controls. An initial prototype also changed the shape of all pause results; an original regression test caught that, and the explicit `continue: false` override was narrowed to budget/deferred termination before delivery.

## Reproduction and raw evidence

From `/home/nixos/pi-extensions`:

```bash
export PI_CANARY_SDK=/nix/store/wxhdhlgzfl4iabzxl1kxhwiyykn40ckx-pi-coding-agent-1.2.0/lib/node_modules/pi-monorepo/dist/index.js
bun test ./canary.test.ts

# While the temporary baseline snapshot is available; expected exit code 1:
PI_CANARY_EXTENSION=/tmp/pi-canary-value-0uNHXu/baseline/canary.ts bun test ./canary.test.ts

# Uses existing local TypeScript, without installing dependencies:
./pi-remote/node_modules/.bin/tsc --project /tmp/pi-canary-value-0uNHXu/tsconfig.json
```

Raw command output, baseline/candidate copies, evaluation probes, the strict type-check configuration, and ablations are under `/tmp/pi-canary-value-0uNHXu/`. In particular: `same-tests-baseline.log`, `final-tests.log`, `final-typecheck.log`, `baseline-evaluation.log`, `candidate-evaluation.log`, and `ablation-{bounds,drafts,unicode,bom}.log`. These temporary artifacts may be removed by system cleanup; this report and the regression tests are the durable record. `PI_CANARY_EXTENSION` also accepts another saved implementation's absolute path for future comparisons.

No live provider requests, production cost benchmark, or statistical speed benchmark was run. Scripted request/token counts establish the specific behaviour above, not a production incident frequency or dollar saving. No standalone linter is configured for these files; strict type checking and the component's complete test suite are the applicable checks. The running TUI was not reloaded during this task; use `/reload` to activate the delivered extension.
