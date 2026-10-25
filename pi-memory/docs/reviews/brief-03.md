# Review checkpoint 3: fixes and final acceptance gates

Continue the interactive Fable/high review. Keep the review bounded to the new changes and evidence below; do not restart a repository-wide audit. Report concrete blockers and source-backed claim corrections. Do not edit files.

## Prior findings addressed

- `src/scheduler.ts`: reserves scheduling before asynchronous reads, prevents duplicate running tasks, disposes old sessions, persists retry backoff before inference, and re-arms at eligibility rather than dropping a pending retry. `test/scheduler.test.ts` exercises these paths.
- `index.ts`: fingerprints previously recalled/digest evidence, appends invalidations after same-ID edits and provenance changes, permits relevant replacement recall, persists fingerprints for branch restoration. Applied hooks/resources refresh evidence and require versioned full fingerprints. `test/extension.test.ts` covers repeated edits and same-turn proposal invalidation.
- `src/capture.ts`: candidate-local validation diagnostics, normalized grounded excerpts, adjacent temporal qualifiers, durable statements mentioning temporary overrides, and preserving unchanged bundled policy facts when a correction replaces only part of a record. Review the focused capture tests and inspect the exact replacement safeguards; these changes came from real failed history runs, not ideal seeded repairs.
- `src/maintenance.ts`: proposals use the complete versioned evidence fingerprint; old or changed fingerprints require a new review.

## Evidence ready now

- `docs/BACKGROUND-EVALUATION.md` and `eval/results/background-live-final/summary.json`: actual installed-Pi RPC idle dreaming, one real model call, retained originals, follow-up response, and session-switch cancellation. Initial failed parent assertion preserved separately. Note generic-word false-positive recall on the follow-up.
- `docs/reviews/review-02.md`: oracle correction verdict; dream original scores remain preserved. Repeated representation results and real-clock expiry are being finalized separately.
- `docs/CACHE-EVALUATION.md`: actual provider cache usage, including misses and non-invoice cost estimates.
- `docs/STORAGE-EVALUATION.md`: hard-cap loss of rare facts and 100k-item latency/space limits.

## Action evaluation acceptance

The final long matrix must use freshly captured actual history after fixes, with no ideal-memory substitution. Hidden policy tests, real CLI stdout/file binding, empty-store guidance control, wrong-project negatives and request/time caps must remain in place. Earlier failures stay documented. It is not acceptable to claim generalization improvement from the previous one-cell budget-packing win or broad efficacy from small synthetic tasks.

Please answer: (1) any remaining concrete implementation blocker in the changed paths, (2) whether the new capture regressions match the observed failures, (3) any unsupported claim in the completed reports, and (4) the minimum final results checks needed before handoff. Stay available for a short final results check.
