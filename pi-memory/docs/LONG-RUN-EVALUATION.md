# Coding and action evaluation

This extends the recall-only evaluation in [EVALUATION.md](EVALUATION.md) with real file edits, test execution, CLI actions, and fresh-session repair. The tasks are synthetic repositories, not historical production incidents. The frozen fixture/checker hash is `7ee568b08cbbe6349a9810f88a7784eb9e8e23bfbf1ccf527be42aee01201916`.

## Protocol

Two independent repositories share one memory store but have deliberately conflicting project conventions:

- **Ingestion:** implement streaming NDJSON processing, resumable checkpoints, deduplication, and malformed-line quarantine. Historical decisions specify identity as `(tenant, seq)`, a default batch later corrected from 2 to 4, and checkpoint recovery that preserves existing output.
- **Migration:** implement versioned JSON migration with atomic output, customer-field preservation, exact source backups, and invocation-only overrides. Historical decisions specify an unusual region and retry values; a later correction changes retries from 3 to 5 while preserving the other decisions.

Each project has three actual Pi history sessions: a user decision, an observed failing probe followed by a successful repair, and a user correction. The successful probe performs filesystem recovery and asserts preserved bytes. The memory extension captures these sessions itself; the evaluator does not install ideal policy records or repair captured records. Source transcripts, capture traces, canonical metadata, and scope audits are retained under `eval/long/state-v3/history/`.

Each action run starts with an identical stub repository and has three stages:

1. Implement the modules and CLI, run visible tests, and demonstrate the CLI.
2. Apply a temporary override, then revoke it in the same persisted Pi session. Both invocations must actually run; stored reports must match captured successful CLI stdout.
3. Open a fresh Pi session, repair deliberately corrupted state, and run the repaired CLI and tests while preserving earlier data and corruption evidence.

The arms are memory off, a short recent-history window, an empty memory store plus that window, captured long-term memory plus that window, and the same captured store after explicit dreaming. The recent window contains only the actual last correction and acknowledgement, capped at 600 UTF-8 bytes. Retrieval uses the production improved strategy, a conservative 1,200-token upper bound measured as UTF-8 bytes, and no digest. Automatic dreaming and action-session capture are disabled so every arm receives a fixed history. The dream arm invokes production dreaming explicitly before actions.

There are two repeats per project and arm, except the empty-store control has one repeat per project. All use `openai/gpt-6.1-sol`, low reasoning, a 3,072-token response cap, and the same guarded read/write/edit/bash tools. Each stage has at most 16 model requests; the two temporary/revocation turns share one cap. Stage time limits are 240/120/240 seconds with a 600-second total limit. At most two jobs run concurrently. Budget and timeout failures remain in the results.

The external checker tests intrinsic coding behavior separately from historical policy compliance, successful actions, and wrong-project controls. Ingestion includes a 48 MiB streaming input with an RSS guard. Bash runs restricted Node commands with filesystem permissions scoped to the synthetic project and no child processes or network. Exact CLI arguments and successful stdout are checked against the claimed artifacts. The prompts and external checker are frozen before accepted runs.

## History audit

The accepted history audit passes all 16 checks: both probes fail before the invocation-only environment fix and then pass actual filesystem assertions; probe scripts remain unchanged; corrected facts and unrelated clauses remain active; superseded evidence remains available; all sources are real sessions; and neither project promotes a global record. There are three active records per project and no pending capture work. See [audit.json](../eval/long/state-v3/audit.json).

One migration repair capture logged an incomplete background model response after committing its verified procedure. The subsequent correction completed, the procedure remained active, and no pending ledger remained. This error is retained in the audit and was not hidden by substituting a manual record.

## Recorded evidence

Every run saves source and protocol hashes, model events, action traces, stage checks, repository snapshots, retrieval selections, token/cache usage, request/tool counts, elapsed time, byte counts, wrong-project recall IDs, unknown IDs, and dream parent/source co-injection counts. Source snapshots are stored alongside memory-enabled runs. Provider usage is reported as observed for the action calls; history creation/capture cost is outside these action totals, and dreaming preprocessing is reported separately. Injected-context counts are conservative UTF-8 upper bounds, not provider tokenizer measurements. Elapsed time includes local checks and process overhead under concurrent experimental load and is observational, not a causal latency-saving result.

A separate exploratory repair-only size comparison starts both memory arms from the short-history arm's stage-2 repository snapshot and the actual captured store. There is one paired repeat per project (four jobs). It compares fresh-session repair with and without 1,000 deterministic same-project synthetic distractor records. Two arm-specific template copies have identical file hashes and retain manifests identifying their short-history origins. This tests repair from the same incomplete historical conventions; it does not erase policies already encoded in the inherited implementation. These added records are explicitly synthetic stress input, not claimed to have arisen from real sessions. The total injected token budget stays fixed.

## Completed coding/action results

The 18 accepted jobs show a clear improvement in applying historical project decisions. Captured long memory and the dream arm passed every acceptance check in all four runs each. All arms passed the measured intrinsic coding, CLI-action, and wrong-project artifact checks; the differences below concern historical policies and complete-task acceptance.

| Arm | Jobs | Complete jobs | Final historical-policy checks | Mean model requests |
| --- | ---: | ---: | ---: | ---: |
| Off | 4 | 0/4 | 15% | 30.75 |
| Short recent history | 4 | 0/4 | 35% | 29.25 |
| Empty memory + short history | 2 | 0/2 | 40% | 33.00 |
| Captured long memory + short history | 4 | 4/4 | 100% | 28.25 |
| Same store after dreaming + short history | 4 | 4/4 | 100% | 29.25 |

The project/repeat results matter: ingestion final policy scores were off 20%/20%, short 60%/60%, empty 60%, long 100%/100%, and dream 100%/100%. Migration scores were off 0%/20%, short 20%/0%, empty 20%, long 100%/100%, and dream 100%/100%. The long and dream arms retained corrected defaults through temporary override revocation and fresh-session repair in every repeat. The short arm's last correction supplied the new numeric value but did not recover the older region, backoff, quarantine, or recovery-location decisions.

There were 72 action-session invocations: 71 exited successfully and one ingestion-off implementation invocation reached its 16-request cap (exit 86). Later stages continued and were scored. That exhausted run remains in all aggregates; there were no timeouts. All 54 required CLI invocations used the expected arguments and returned parseable JSON with a successful exit. The 36 temporary/normal reports matched captured stdout exactly; the 18 fresh repair output artifacts passed their separate acceptance checks. The audit found zero unresolved selected memory IDs, wrong-project selected/source IDs, invalid derivation hashes, or parent/source co-injections.

### Resources

These are means per three-stage job. Total input includes cache-read tokens. Output and costs cover action calls; dream preprocessing is separate.

| Arm | Total input tokens | Uncached input | Cache-read input | Output tokens | Observed wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Off | 119,452.50 | 16,796.50 | 102,656 | 3,729.50 | 195.4 s |
| Short | 117,320.75 | 18,760.75 | 98,560 | 3,851.75 | 191.0 s |
| Empty + short | 142,895.50 | 16,239.50 | 126,656 | 4,264.50 | 191.2 s |
| Long + short | 130,293.00 | 16,309.00 | 113,984 | 4,235.75 | 205.7 s |
| Dream + short | 137,207.25 | 22,199.25 | 115,008 | 4,353.75 | 207.3 s |

Long memory used fewer model requests on average, more total input, and slightly less uncached input than off/short in this aggregate. The first repeats had higher uncached input with memory; later cache-hit variation reversed that aggregate comparison. These small trials establish useful historical behavior on the two tasks, not reliable token-cost or latency savings. SDK-estimated action costs averaged $0.08115/off, $0.08590/short, $0.08779/empty, $0.08637/long, and $0.09944/dream, excluding history/capture and dream preprocessing. These are recorded SDK estimates, not invoices.

The largest retrieval was 1,198 UTF-8 bytes, within the conservative 1,200-token upper bound. Long/dream stores held six active canonical records across both projects, averaging 10,822 active canonical bytes after action use. The corresponding whole-directory sizes averaged 140,958 and 143,675.5 bytes; SQLite/checkpoint files contribute to these totals.

### Dreaming outcome

Dreaming added **zero active parent records** in these four trials. Two ingestion runs generated unreviewed hypotheses but had no smaller permitted lossless parent representation; two migration runs skipped synthesis. All four action stores therefore retained the same active evidence. The dream arm's 100% result is not evidence that automatic generalization improved coding.

Across the four jobs, dream preprocessing averaged 1,427.5 input tokens, 136.75 output tokens, and 5.15 seconds, including the two skipped runs. Active canonical bytes changed by zero. Whole-directory byte deltas include SQLite/WAL checkpointing and must not be interpreted as semantic compression. The hypotheses are retained as unreviewed evidence and are not silently injected as validated facts.

### Evidence and source boundary

The [summary](../eval/long/results/final-v3/summary.json) combines [the separately started off baseline](../eval/long/results/off-v3-first/ingestion-off-0/result.json) with the other 17 runs. The [integrity audit](../eval/long/results/final-v3/audit.json) verifies all 18 unique expected cells, every recorded stage score, source snapshots, selected/source ID scopes and hashes, and per-project paired results including stage exits and corrected-default checks. Each run also retains selected canonical evidence for inspection.

All memory-enabled action runs use source hash `684514f94f06071f70ebd31fb357b61cd6a406cb2606505d890bcb9fdd88f2ae` and all action runs use protocol hash `faa7e3c12114bdf9e800de4606a05e416dddcf2bb1cef8f46b1f2c57dea42b1b`. The off baseline started before the final retrieval timestamp wording was frozen; the extension was disabled in that arm, and its identical fixture/protocol hashes are audited. Capture was disabled during action calls. Later capture-only hardening is outside this source snapshot and cannot retrospectively change these scores.

Earlier `state-final`, `state-v2`, smoke, and diagnostic directories are excluded; they exposed capture and harness defects corrected before `state-v3`.

## Exploratory size comparison

All four exploratory jobs completed within budget. The [template manifest](../eval/long/repair-templates-v3/manifest.json) records the short-history stage-2 origins and verifies byte-identical clean/noisy input copies. The [separate summary](../eval/long/results/repair-polluted-v3/summary.json) and [integrity audit](../eval/long/results/repair-polluted-v3/audit.json) retain the same fixture, protocol, and source hashes as the full matrix. All four actual repair CLI invocations used the expected arguments and returned parseable JSON with a successful exit; their repair artifacts and all intrinsic/action/control checks passed.

| Project | Clean full-snapshot policy | +1,000 distractors full-snapshot policy | Clean requests | Noisy requests |
| --- | ---: | ---: | ---: | ---: |
| Ingestion | 80% | 100% | 9 | 10 |
| Migration | 20% | 80% | 11 | 13 |

Strict complete-job counts remain 0/2 clean and 1/2 noisy. The migration checker includes the inherited stage-2 `normal-report.json`, whose region was already wrong in the short-history origin. The noisy repair corrected the implementation's current region/retry, legacy, backup, and recovery checks but did not rewrite that old report. For diagnosis only, excluding the one inherited stage-2 report check gives current policy scores of clean 75%/25% and noisy 100%/100% for ingestion/migration. This supplementary breakdown does not replace the frozen checker or completion verdicts.

No synthetic distractor record was selected. The added corpus changed the ranking of the real captured records: clean repair selected recovery plus auxiliary project conventions; noisy repair selected recovery plus the full current project policy. The clean ingestion repair consequently left the missing quarantine behavior unchanged, and clean migration repaired recovery while leaving several earlier conventions wrong. This exposes a boundary that the full implementation runs did not: a focused repair query can omit useful historical policy when the starting code is incomplete. It also shows that more stored records did not cause monotonically worse recall on this particular corpus.

| Resource per repair job | Clean | +1,000 distractors |
| --- | ---: | ---: |
| Active records across both projects | 6 | 1,006 |
| Active canonical bytes | 10,822 | 1,203,522 |
| Whole store bytes after actions | 140,641 | 3,340,381 |
| Largest injected UTF-8 upper bound | 1,024 | 1,198 |
| Mean total input tokens | 42,902.5 | 47,970 |
| Mean uncached input tokens | 9,366.5 | 14,050 |
| Mean cache-read input tokens | 33,536 | 33,920 |
| Mean output tokens | 1,915.5 | 1,851 |
| Mean observed wall time | 123.2 s | 90.4 s |

The retrieval budget stayed fixed while the canonical store grew above 1 MB. Automatic compaction was disabled for this fixed-history comparison. The noisy arm used more input and model requests; the shorter observed wall time under concurrent experimental load is not a demonstrated latency benefit. With one paired repeat per project and one deterministic noise distribution, these results establish neither a general size ceiling nor universal noise robustness. Broader store-size measurements are in [STORAGE-EVALUATION.md](STORAGE-EVALUATION.md).

## Reproduction

The recorded runs used Node 26.11.1 and Pi 1.4.0 on this machine, with the configured OpenAI credentials. The guarded Node execution uses permission flags and is separate from the extension package's minimum supported Node version. From the repository root:

```sh
node --import tsx pi-memory/eval/long/run.mjs --mode=init --state=pi-memory/eval/long/state-v3
node --import tsx pi-memory/eval/long/run.mjs --mode=history --state=pi-memory/eval/long/state-v3
node pi-memory/eval/long/audit-history.mjs pi-memory/eval/long/state-v3
node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --out=pi-memory/eval/long/results/final-v3 --arms=off,short,empty,long,dream --repeats=2 --empty-repeats=1 --concurrency=2
node pi-memory/eval/long/summarize.mjs pi-memory/eval/long/results/final-v3
node --import tsx pi-memory/eval/long/audit-results.mjs pi-memory/eval/long/results/final-v3
```

Use fresh state/output paths for a new run. The state manifest rejects fixture/checker drift, and output directories must be empty. Accepted results may combine disjoint output directories when a baseline was started separately; the summarizer rejects duplicate job IDs and different fixture hashes.

The exploratory size comparison can be reproduced after the short-arm runs exist:

```sh
node pi-memory/eval/long/prepare-repair-templates.mjs pi-memory/eval/long/results/final-v3 pi-memory/eval/long/repair-templates-v3
node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --out=pi-memory/eval/long/results/repair-clean-v3 --arms=long --repeats=1 --concurrency=1 --repair-only-from=pi-memory/eval/long/repair-templates-v3/long
node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --out=pi-memory/eval/long/results/repair-polluted-v3 --arms=polluted --repeats=1 --concurrency=1 --repair-only-from=pi-memory/eval/long/repair-templates-v3/polluted
node pi-memory/eval/long/summarize.mjs pi-memory/eval/long/results/repair-clean-v3 pi-memory/eval/long/results/repair-polluted-v3
node --import tsx pi-memory/eval/long/audit-results.mjs --repair-only pi-memory/eval/long/results/repair-clean-v3 pi-memory/eval/long/results/repair-polluted-v3
```

These are small, controlled coding trials. They can demonstrate success or failure on these tasks and reveal mechanisms, but cannot establish general production coding quality, broad latency benefits, or long-term retention quality by themselves. Real TTL expiry, cache behavior, sustained store growth, and observed representation capture are evaluated separately.
