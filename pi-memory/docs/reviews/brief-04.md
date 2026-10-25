# Checkpoint 4: review only the prepared capture patch

Production is still frozen while the remaining longitudinal jobs run. Do not reread the whole repository or wait for those jobs. Review only:

- `docs/reviews/capture-hardening.patch`
- `docs/reviews/capture-hardening-results.json`
- Any small source/test slice needed to understand that patch.

The patch is prepared in an isolated copy, not applied. It addresses your two checkpoint-3 capture defects: candidate-local curator rejection and completed malformed-output checkpointing to stop paid retry loops; strict attachment of bare temporal qualifiers rather than adjacent independent facts. It also replaces numeric substring matching with token matching. Transport/provider failures and cancellation remain retryable. Original transcript evidence is retained. Rejected model output is not automatically retried; diagnostics record the rejection.

Please give a short verdict on whether the patch closes those concrete defects without breaking source/scope/expiry validation. Identify only remaining blockers in this patch, with a reproducible example; avoid expanding into unrelated new work. Note any important tradeoff in checkpointing completed invalid output. Existing tests: 111 deterministic tests, 49 focused capture tests, TypeScript and patch applicability pass.

For context only, completed final-build evidence now includes actual-clock actions (`docs/RETENTION-EVALUATION.md`), two same-build dream repetitions (`docs/DREAMING.md`), timestamped prefix checks (`docs/CACHE.md`), and rerun background RPC (`docs/BACKGROUND-EVALUATION.md`). The first completed longitudinal project/repeat independently reproduced policy scores 20/60/60/100/100 for off/short/empty/long/dream; all intrinsic/action/control checks passed. Off stage 1 exhausted its request budget and remains included. Dream produced no usable parent in that task, so equal long/dream results do not establish dream benefit.

We will apply the reviewed patch after all frozen action/size runs, then verify fresh capture on the final source. The action benchmark will retain its exact snapshot and state the capture-only follow-up difference. A source-hash change will not be disguised as the same build.
