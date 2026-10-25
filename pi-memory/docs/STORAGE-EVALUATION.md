# Storage growth and memory lifetime evaluation

This benchmark separates scope isolation, retrieval quality, storage cost, and lifetime correctness. It does not run a model or demonstrate that a model took the intended action. The temporal cases record which evidence an action-taking agent would receive.

Run it with:

```sh
node --import tsx pi-memory/bench/store-growth.mjs \
  --sizes 100,1000,10000 --repetitions 10 \
  --output pi-memory/bench/results/store-growth.json
```

The runner writes canonical Markdown in bounded batches, then reindexes once per measured rebuild. It does not call `save()` 10,000 times. Stores and git fixtures live under an owned temporary directory that is removed on completion. No real memories, remote repositories, credentials, or model APIs are used.

## Corpus and measurement

[growth.json](../bench/fixtures/growth.json) contains six independently written facts and queries: verification, recovery, import encoding, release approval, communication preferences, and accessible diagrams. A seventh query should abstain. The generated corpus adds exact conflicting facts from eight unrelated projects and deterministic noise across 50 further project identities. The mixed layout keeps about 5% of generated noise in the current project; the concentrated layout places generated noise in the current project. Both include global preferences.

The benchmark also creates real local git worktrees and repositories with equivalent SSH/HTTPS remotes. Same-repository worktrees and equivalent remotes resolve to the same project key; unrelated remotes resolve differently. This checks identity without contacting a git server.

Each search method receives one warm-up per query, followed by 10 repetitions of all seven queries: 70 latency samples. Results are rendered under the same 1,200 conservative UTF-8-byte token bound used by the extension. Latency excludes model calls. The injected-run measurement reproduces storage work from the live handler: `reindex()`, search/selection, and `markInjected()`. It has three samples per layout, so its reported p95 is effectively the observed maximum and should not be treated as a statistically stable tail estimate.

Precision is relevant selected memories divided by all selected memories, aggregated across queries. Recall is retrieved gold memories divided by all gold memories. The no-hit query has a separate abstention check; it does not artificially increase these aggregate scores. Corpus IDs, fixtures, source hashes, machine details, and per-query selections are included in the JSON artifact. The exact source version matters: this is a development benchmark, not a held-out evaluation.

## Before the lifetime and indexing changes

[store-growth-v2.json](../bench/results/store-growth-v2.json) records the initial production implementation on Apple M3 Ultra / macOS, Node 26.11.1. All measured source hashes remained stable during the run.

| Total items | Layout | Visible active items | Search p50 / p95 ms | Injected-run storage p50 / max ms | Total disk MB |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100 | mixed projects | 9 | 0.127 / 0.249 | 30.051 / 31.848 | 0.40 |
| 100 | concentrated | 68 | 0.373 / 0.760 | 24.866 / 26.294 | 0.40 |
| 1,000 | mixed projects | 54 | 0.580 / 1.784 | 196.571 / 205.866 | 3.84 |
| 1,000 | concentrated | 968 | 3.188 / 8.318 | 199.452 / 200.478 | 3.85 |
| 10,000 | mixed projects | 504 | 8.259 / 21.568 | 1,826.839 / 1,831.500 | 33.52 |
| 10,000 | concentrated | 9,968 | 39.864 / 97.294 | 2,042.769 / 2,111.545 | 33.56 |

The 10,000-item corpus uses approximately 11.7 MB of canonical Markdown and 21.8 MB of SQLite index data. File count and repeated full reindexing dominate the observed interactive cost: a full rebuild takes approximately 0.6 seconds, and the current recall path performs three rebuilds. Disk capacity alone does not justify a destructive hard memory ceiling at this size.

All six gold facts remain retrievable and there are zero foreign-scope selections in every measured method/layout. Aggregate precision falls from 0.667 at 100 mixed-project items to 0.286 at 1,000 and 10,000 items: the system also injects unrelated same-project memories sharing generic terms. Perfect recall and scope isolation therefore do **not** imply precise recall. The no-hit astronomy query correctly returns no memories.

## Bounded retrieval prototype

The benchmark includes a read-only SQL prototype that filters project/global scope and active status before materializing candidates, then reranks only the best 40, 100, or 200 BM25 candidates. It does not archive, delete, or omit canonical memories from the index.

At 10,000 concentrated items, candidate limits 40 / 100 / 200 produce search p95 of 15.603 / 15.901 / 15.577 ms, versus 97.294 ms for the initial implementation. All tested limits retain the same gold recall and aggregate precision in this corpus. The three limits are too close here to claim one has a statistically established speed advantage; 100 provides more candidate headroom than 40 with little measured difference. Candidate limiting does not fix the observed precision problem.

Recommended boundaries from these measurements:

- Keep all canonical evidence. Do not impose a hard item-count ceiling that automatically deletes or archives unrelated useful facts.
- Bound the retrieval candidate pool in SQL, initially around 100 per query after scope filtering, while retaining the existing final item/text budget. Reevaluate recall on broader queries before lowering it.
- Avoid rewriting the whole index when files are unchanged. Update only changed item rows and FTS records, and account for usage without rebuilding unrelated items.
- Treat roughly 1 MB of active canonical text in one scope as a **soft inspection/consolidation trigger**, not a deletion threshold. In this fixture that is near 1,000 items, the lower tested scale before the 10,000-item concentrated latency increase. This is an operational starting point for this implementation and machine, not a universal memory limit.
- Track active bytes, candidate quality, and measured latency. Item count alone misses differences in item length and scope distribution. Compaction must preserve evidence and be separately evaluated for retrieval and action quality.

## Lifetime failures and the proposed contract

[temporal.json](../bench/fixtures/temporal.json) separates a two-year-old emphatic approval rule, a year-old communication preference, a persistent routing default, a current incident override, and an expired incident override. It uses desired-policy `retention`/`expiresAt` annotations; the initial production version ignores these fields.

Before consolidation, the expired override is retrieved alongside the current override and the persistent default. After consolidation, the initial implementation archives the durable preference and routing default solely because they have not been used recently, while leaving the expired override active. The emphatic feedback rule survives its special-case protection. These are observed retrieval-policy failures; the benchmark does not claim a model actually routed traffic incorrectly.

The agreed minimal contract is:

- `retention: "long" | "short"`, defaulting to `long` for existing and unspecified durable memories.
- Short-term memories require an explicit ISO `expiresAt`. Expired memories leave default listing, search, injection, and digests immediately; maintenance may then archive them. Explicit ID lookup and archived search retain provenance and expiry metadata.
- Long-term memories are not archived solely because time elapsed. Relevance can decay without erasing a durable preference.
- A short-term override cannot supersede a long-term source. Both coexist under their conditions; expiry reveals the persistent default again.
- Rendering shows expiry for short-term evidence. A derived memory containing any short-term source must remain short-term and inherit the earliest source expiry, unless a user separately supplies durable evidence.

## Implemented lifetime and indexing changes

[store-growth-v5.json](../bench/results/store-growth-v5.json) reruns the same growth corpus after implementation, with immutable source snapshots and stable source hashes during measurement. The temporal fixture's explanatory text changed to describe the now-supported contract; its fact/query cases did not change.

| Total items | Layout | Search p50 / p95 ms | Unchanged scan p50 ms | Injected-run storage p50 / max ms |
| ---: | --- | ---: | ---: | ---: |
| 100 | mixed projects | 0.070 / 0.182 | 2.741 | 11.065 / 11.234 |
| 100 | concentrated | 0.265 / 0.761 | 1.044 | 8.002 / 8.051 |
| 1,000 | mixed projects | 0.297 / 1.328 | 6.523 | 33.990 / 39.238 |
| 1,000 | concentrated | 1.100 / 2.219 | 4.478 | 31.043 / 33.422 |
| 10,000 | mixed projects | 3.617 / 11.838 | 41.260 | 115.887 / 116.000 |
| 10,000 | concentrated | 5.126 / 15.542 | 41.063 | 117.661 / 118.237 |

The implementation now scopes SQL candidates before applying a 100-candidate bound, caches file metadata signatures, hashes/parses changed files, updates only changed item/FTS rows, and records usage without rewriting searchable text or doing a second filesystem scan. `reindex(true)` deliberately reparses/rebuilds everything for explicit repair. Canonical manual edits, deletion, recovery, cross-process writes, and index reconstruction remain covered by regression tests.

The unchanged scan still visits files, so the cost is not constant with store size. At 10,000 items the measured end-to-end storage portion falls from approximately two seconds to approximately 0.12 seconds. This does not include provider/network latency or establish behavior at 100,000 items. Full initial indexing remains a separate operation; it is not represented by the unchanged-scan column.

The temporal rerun excludes the expired incident override both before and after maintenance. Maintenance archives exactly that expired item and preserves the current override, persistent routing default, year-old communication preference, and older approval rule. Temporary overrides display expiry and cannot supersede lasting defaults. Explicit ID lookup retains expiry and effective archival metadata.

Derived memories now carry source IDs plus evidence hashes. Changing a source's body, title, scope, lifetime, confidence, or primary provenance invalidates the derived claim; usage counters and timestamps do not. Missing, archived, superseded, or expired sources also invalidate it. Default retrieval excludes invalid derived claims, explicit lookup marks them stale, and maintenance archives them. Regression tests cover source correction, manual edits, confidence/provenance downgrade, temporary expiry, and revoking a temporary override back to an already-existing persistent default. These later correctness checks are separate from the v5 timing snapshot.

The speed changes do not improve precision by themselves: recall remains 1.0 and foreign leaks remain zero, while same-scope precision remains 0.286 in the larger generated corpora. That limitation is retained in the report rather than hidden by the latency improvement.

## Relevance thresholds: useful diagnostics, unsafe defaults

[relevance-gaps-v1.json](../bench/results/relevance-gaps-v1.json) records scores for the original growth queries and an [independent new-fact fixture](../bench/fixtures/relevance-heldout.json) written before inspecting the score-gap results. The independent fixture includes single-fact, multi-fact, and abstention queries.

For the 1,000-item growth corpus, the relevant Juniper verification memory scores 25.41 while generic worker notes score 3.86; at 10,000 items the scores are 33.89 and 3.86. Cutting candidates below one quarter of the best score removes this clutter. Across the growth queries, that prototype raises precision from 0.286 to 1.0 without losing gold facts. On the independent fixture, precision improves from 0.414 to 0.667; half-of-best improves it to 0.857, again without loss in that fixture.

Those positive examples are insufficient to adopt the rule. The existing four-fact import-composition stress case has essential candidate score ratios 1.000, 0.385, 0.251, and 0.233. A quarter-of-best threshold drops one required fact; half-of-best drops three. That counterexample rejects a universal top-relative threshold despite its attractive aggregate score on the new corpus.

[relevance-gaps-v2.json](../bench/results/relevance-gaps-v2.json) evaluates an adjacent-score-gap prototype instead. A gap of four improves original growth precision to 1.0 and independent-fixture precision to 0.571–0.632, with no losses in those fixtures. The composition stress case has no adjacent gap that large. This still does not establish a safe production gate: a dominant fact plus a weak but necessary secondary fact can have a large gap. Dedicated [follow-up challenges](../bench/fixtures/relevance-challenges.json) test that case and broad import requests separately from the original held-out fixture. Production ranking remains unchanged while these diagnostics are assessed.

[relevance-counterexample-v1.json](../bench/results/relevance-counterexample-v1.json) confirms the risk. In an isolated recovery request, the command/verification fact scores 65.18 and the explicitly requested approval contact scores 8.74. Their adjacent gap is 7.46. A gap-of-four cutoff drops the contact, reducing recall from 1.0 to 0.5 while making precision appear perfect. A gap of eight retains the required fact but also retains clutter. The broad invoice-conventions query retains all three required conventions. These results reject a universal scalar cutoff; a query-aware selector would need its own action-quality, latency, and model-cost evaluation. No such selector gain is claimed here.

## A hard active-memory ceiling loses rare durable facts

[active-ceiling-v1.json](../bench/results/active-ceiling-v1.json) evaluates a different intervention from the SQL candidate cap. It seeds 10,000 canonical memories, dates six correct durable facts one year in the past, and then applies a most-recent-first active ceiling independently per scope. Every source file remains present; excess memories move to the archive in the isolated copy.

| Per-scope active ceiling | Canonical sources retained | Active items across scopes | Gold recall through default retrieval |
| ---: | ---: | ---: | ---: |
| none | 10,000 | 10,000 | 1.000 |
| 100 | 10,000 | 134 | 0.333 |
| 1,000 | 10,000 | 1,034 | 0.333 |

Both ceilings retire the old verification procedure, recovery ordering, encoding convention, and production-approval rule. The two global preferences survive because their scope is below its independent cap. Archived search could still recover the original evidence, so this is loss of default accessibility rather than destruction of the files. It is nevertheless a material loss for automatic recall. A SQL candidate cap preserves the indexed active knowledge and did not produce this loss in the tested queries.

Reproduce this ablation with:

```sh
node --import tsx pi-memory/bench/store-growth.mjs \
  --sizes 10000 --layouts concentrated --repetitions 1 \
  --production-only --skip-relevance --hard-cap 10000 \
  --output pi-memory/bench/results/active-ceiling.json
```

These measurements support a soft consolidation trigger with source retention, rather than recency-based eviction. They do not prove that a generated abstraction preserves every condition; the dreaming/generalization evaluation must check that separately.

## One larger scale check

[store-growth-100k.json](../bench/results/store-growth-100k.json) adds one concentrated 100,000-item point with only one repetition per query, to bound the next latency increase without turning this into an exhaustive load test. Sources stayed unchanged during the run. It retained all six gold facts, returned no foreign-scope items, and retained the same precision limitation.

- Initial indexing: 5.873 seconds.
- Unchanged filesystem scan: p50 449.864 ms; observed maximum 495.295 ms across three scans.
- Search: p50 47.769 ms; observed maximum 160.881 ms across seven different query samples. The reported p95 equals that maximum and is not a stable tail estimate.
- Injected-run storage work: p50 1.083 seconds; maximum 1.127 seconds across three runs.
- Disk: 321.1 MB total, including 118.3 MB canonical Markdown and 202.9 MB SQLite index data.

This puts the next observable interactive-latency increase between 10,000 and 100,000 concentrated active items on this machine. It supports reporting size and scheduling consolidation before stores become very large, while retaining source evidence. It does not justify a universal hard cap or prove that compaction would reduce filesystem scanning: keeping archived canonical files still requires an indexing strategy that handles them efficiently. Further partitioning or background indexing should be measured before adding complexity.

Reproduction:

```sh
node --import tsx pi-memory/bench/store-growth.mjs \
  --sizes 100000 --layouts concentrated --repetitions 1 \
  --production-only --skip-relevance \
  --output pi-memory/bench/results/store-growth-100k.json
```

## Research basis and limits

[LongMemEval](https://arxiv.org/abs/2410.10813) explicitly separates temporal reasoning, knowledge updates, multi-session reasoning, extraction, and abstention. That motivates testing expiry and temporary overrides separately from ordinary relevance; it does not establish this benchmark's thresholds or prove its synthetic tasks generalize.

[Lost in the Middle](https://arxiv.org/abs/2307.03172) reports that relevant information's position within long contexts can affect model performance. This supports measuring bounded, selective context instead of assuming that retaining or injecting more text always helps. Its models and tasks differ from the current Pi evaluation, so no numerical performance effect is transferred here.

This six-fact synthetic corpus tests mechanics and scaling. It does not establish open-domain accuracy, privacy against every attack, downstream action correctness, or a safe universal memory capacity. The fixed fixtures and before/after source hashes are retained so performance and quality claims can be checked rather than inferred from implementation alone.

The final integration also refreshes the index before executing an applied memory hook, so a same-turn source edit cannot leave a stale guard active. With applied hooks, that scan cost occurs on each tool call; the large-store scan measurements therefore matter beyond recall itself. Installations without applied hooks do not take this extra tool-call scan. Resource discovery similarly refreshes applied skill/prompt evidence.
