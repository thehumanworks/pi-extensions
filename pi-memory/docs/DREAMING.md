# Background dreaming, retention, and memory pressure

`/memory dream --force` performs one bounded, tool-free model pass over related memories in the current project. The idle scheduler can run the same pass after enough new captures, a maintenance interval, or a configured soft size threshold. A project-scoped process lock prevents concurrent model passes. Abort and timeout stop inference before commits; validated commits finish together, and their source hashes are checked again before saving.

The pass produces two different representations:

- **Compressed parents are automatic.** The model selects related evidence groups, while code constructs the parent by factoring exact repeated statements into local references. The parent retains every source title, statement, number, command, condition, and statement order. Expansion must reproduce each source body, ignoring only inter-sentence whitespace. Multiline content and sentences with dependent pronouns remain intact. A parent is saved only when its rendered representation is smaller than its sources and fits the configured recall budget.
- **Semantic abstractions are hypotheses.** The model writes a concise generalization with limitations. That prose is saved under `dream/hypotheses/` for inspection. It does not replace sources, enter automatic recall, become a skill, or gain authority merely because the model generated it. A passing wording check is not proof of semantic equivalence.

Original memories remain active and editable. The model receives neither tools nor permission to choose output paths. Groups stay within their original project scope, require topical overlap, and do not combine disjoint path scopes. Singletons do not consume the model batch budget. A source-hash checkpoint lets later passes move on to previously unprocessed groups instead of repeatedly summarizing the first group.

## Wake and sleep

With a classifier as `capture.model`, memory follows a wake and sleep cycle modelled loosely on Google's [SLEEP framework](https://research.google/blog/the-sleep-framework-a-new-way-for-llms-to-retain-knowledge-in-continual-learning/), which separates a fast, temporary learning phase from a later phase that consolidates it into stable knowledge.

| SLEEP | Here | Where |
| --- | --- | --- |
| Active phase with fast, temporary memory | A classifier scores each turn's arrivals, and what clears the bar is stored verbatim and recalled at once | `src/triage.ts`, `storeRaw` in `src/capture.ts` |
| Consolidation into stable knowledge | Reflection and curation distil raw entries and reconcile them with long-term memory | `assimilate` in `src/capture.ts` |
| Synaptic pruning | Every raw entry settles: it is archived, linked to what now holds it, or pruned when nothing cited it | `settleRaw` in `src/store.ts` |
| Dreaming | Compression and hypotheses over long-term memory, as described above | `src/dream.ts` |

Two things differ. SLEEP trains weights, and its dreaming generates practice data to reinforce them. Nothing here generates practice. Pruning is also reversible, since the archive and session files keep the evidence, which is what [the storage evaluation](STORAGE-EVALUATION.md) asks for.

The bar is deliberately low. A needless entry costs one line in a sleep pass, while a dropped one is gone. For the same reason the classifier sees only the entry and the codebase, not the system prompt: telling a new fact from a documented one is left to reflection, which needs the text in front of it anyway. An exact copy of the system prompt is still filtered without a model call.

A classifier cannot write text, so "raw" means code chose the pieces and the classifier only judged them. That also means a raw entry can hold more than one fact, or part of a task request. The sleep pass separates them.

Before an entry reaches reflection, nothing has checked it against existing memory. Raw entries are therefore never curation neighbors, because settling one against another could drop the fact from both, and a long-term memory is never merged into a raw copy of itself.

## Provenance and corrections

Each automatic parent records `derivedFrom: [{id, hash}]` and links to its sources. The hash includes the evidence text, scope, lifetime, confidence, and primary provenance. A parent becomes ineligible for recall immediately if a source is changed, superseded, archived, expired, or otherwise invalid. This prevents an old compressed parent from bringing back a corrected fact. Explicit inspection still exposes historical evidence; maintenance can archive stale parents.

Dream reports retain IDs, hashes, and measurements rather than duplicate source bodies. Hypothesis files necessarily contain proposed prose and cite original evidence. Scoped clearing removes matching reports, hypotheses, and processing checkpoints as well as canonical memory, and checkpoints the current session so cleared facts are not immediately learned again at shutdown.

## Short and long retention

Long retention is the default for durable facts. Long-lived memories do not disappear merely because they have not been used recently; relevance can decline without deleting the evidence.

Short retention requires an explicit `expiresAt` timestamp. Expired items are excluded from normal recall immediately and are archived during maintenance. A temporary exception cannot supersede a long-lived default. Capture accepts an expiration grounded in the original user evidence, such as `until 2026-11-01T12:00:00Z` or a numeric duration anchored to that entry's timestamp. Vague restrictions such as “for now” are skipped rather than converted into permanent preferences.

If any source of a parent is short-lived, both the parent and its hypothesis inherit the earliest source expiry. They cannot turn a temporary constraint into a lasting rule. Original long-lived sources remain available after the temporary parent expires. Short-lived evidence cannot be codified into persistent prompts, skills, agents, instructions, or hooks; that requires separate durable evidence.

## Size limits

The default soft byte threshold is 1,000,000; `memory.dream.softActiveBytes` is configurable. The scheduler and dream result both measure canonical active memory size in the current project, including metadata. The lower-level pipeline accepts an optional count threshold, but there is no default hard item count and no automatic destructive size ceiling.

This distinction matters: keeping originals and adding a compact parent **increases persisted storage**. The potential saving is a smaller representation at recall time. Source-plus-parent retrieval can still use more context or select redundant evidence, so raw compression ratios alone do not establish an improvement. A hard cap would need an explicit overflow/archive policy and measured retention of rare but important facts; arbitrary oldest-item eviction is not implemented.

The default parent recall budget is the configured retrieval budget, currently 1,200 conservative UTF-8-byte token bounds. These bounds are not measured provider token counts. A larger parent is skipped rather than truncated through a condition or command.

## Evaluation

Run the deterministic checks:

```sh
node_modules/.bin/tsx --test pi-memory/test/dream.test.ts pi-memory/test/capture.test.ts pi-memory/test/maintenance.test.ts
```

Run the reproducible live representation benchmark:

```sh
node --import tsx pi-memory/test/dream-live.mjs --out=pi-memory/eval/results/dream-live
```

The benchmark invokes the installed Pi CLI and `openai/gpt-6.1-sol`. It first generates parents and genuine semantic hypotheses with `/memory dream --force`. It then compares four isolated stores through Pi's actual recall path: original sources, compressed parents alone, model-written hypotheses alone, and sources plus compressed parents. Candidate-only arms are experiments, not production policies.

Held-out downstream tasks test exact commands, numeric limits, preconditions, staging/production/local boundaries, an invoice-only temporary restriction, and behavior after expiry. An explicit mock executor accepts only the complete context-correct operation plan. This is stronger than asking a model to rate its own summaries, but it is not evidence of deployed infrastructure execution or broad real-world efficacy.

Artifacts preserve the generated prose, canonical store snapshots, selected memory IDs, raw Pi events, byte counts, provider input/output/cache usage, and exact per-field/action failures. Provider token measurements are kept separate from conservative text-size estimates. One synthetic corpus and the small number of samples per task/arm do not justify a universal claim about generalization quality. The separate longitudinal evaluator uses actual captured conversation history and coding tasks to examine behavior over time.

### Wake and sleep results

`eval/triage-live.mjs` runs 65 hand-labelled turn-end arrivals through the real gate. 24 of them should be stored. These are two runs on `vercel-ai-gateway/openai/gpt-6-luna-decisions`:

| Threshold | Precision | Recall | Stored of 65 |
| --- | --- | --- | --- |
| 1 (shipped) | 0.96, 1.00 | 0.96, 0.92 | 24, 22 |
| 1.5 | 1.00, 1.00 | 0.71, 0.67 | 17, 16 |
| 2 | 1.00, 1.00 | 0.25, 0.29 | 6, 7 |

A run cost $0.0019 to $0.0031. Of 33 real arrivals from Pi sessions in this repository, 7 cleared the bar. The threshold was chosen on these same cases, so these figures are optimistic. Every run missed one wanted arrival, the recovery command `bun run deploy --audience pi-deploy`, which scored 0.68 to 0.81.

`eval/long/run.mjs` ran the ingestion and migration projects twice each, with `openai/gpt-6.1-sol` as the agent and the gateway classifier for recall. Figures are means per run.

| Arm | Runs | Memory score | Requests | Uncached input | Cached input | Output | Recalled tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Raw entries only | 4 | 1.0 | 29.75 | 23,040 | 119,168 | 4,287 | 1,729 |
| After a sleep pass | 4 | 1.0 | 29.25 | 26,935 | 112,032 | 4,057 | 1,318 |

Each sleep pass turned 3 raw entries into 4 long-term candidates in 36 to 54 seconds on `openai/gpt-6.1-sol`. One run in the second arm is marked incomplete because the agent spent its 16 requests on stage 1, before any sleep pass; it still scored 1.0 at every stage. The arms cannot be told apart on memory score, since both reached the ceiling, and neither was compared with the older capture path.

The first attempt at the second arm found two faults. `xai/grok-4.7` took 230 to 366 seconds for the same pass, past the eval's 120-second limit, which is why a sleep pass has its own `dream.sleepTimeoutMs` and `dream.model` should be a fast chat model. The run that did finish lost a region name: one rejected fact archived its whole raw entry. An entry with a rejected fact now stays raw and is retried for up to seven days, and a correction quotes one entry.

### Historical representation experiments

The first recorded run used Pi 1.4.0 and `openai/gpt-6.1-sol` for one dream pass and 32 downstream calls, with production source hashes unchanged during the run. The model produced three compressed parents and three genuine semantic hypotheses. See [raw summary](../eval/results/dream-live/summary.json), [raw results](../eval/results/dream-live/results.json), and [generated hypotheses](../eval/results/dream-live/generated-hypotheses.json).

| Representation | Raw accepted plans / 8 | Provisional rescored plans / 8 | Mean injected byte bound | Active evidence text bytes |
| --- | ---: | ---: | ---: | ---: |
| Original sources | 5 | 7 | 1,135 | 4,169 |
| Compressed parents only | 5 | 7 | 825 | 2,064 |
| Semantic hypotheses only | 5 | 7 | 1,036 | 1,411 |
| Sources plus compressed parents | 6 | 8 | 1,098 | 6,233 |

**The rescored column was accepted after independent review.** Original scores and raw model outputs remain unchanged; the historical rescore artifact names retain “provisional” so their provenance is not rewritten. Two proposed oracle corrections affect every arm equally: the Beacon source requires successful migrations but does not name a separate preflight; the Zephyr source expressly requires preflight for deployments even when a local command is unknown. The reviewed oracle interprets Beacon migrations separately from an explicitly named preflight. For Zephyr local deployment, the general preflight requirement remains supported even though its command is unknown; whether a refused operation should instead return all null fields remains an explicit field-definition ambiguity. Exact frozen evidence and artifact checksums are in [provisional gold corrections](../eval/results/dream-live/provisional-gold-corrections.json). [Provisional rescored results](../eval/results/dream-live/results.provisional-rescore.json) are separate artifacts. Reproduce that rescore without model calls using:

```sh
node --import tsx pi-memory/test/dream-live.mjs --rescore=pi-memory/eval/results/dream-live
```

Findings unaffected by those two oracle fields:

- Both automatic compression and model-written abstraction retained all four command literals. Neither issued a command for the two unknown-environment negative cases.
- Parents-only and hypotheses-only lost the long-lived Mercator fallback after a mixed temporary parent expired. Keeping original sources preserved that fallback. This supports retaining originals rather than enforcing representation replacement.
- Sources-only missed the standard worker count in a non-invoice context under the recall budget; grouped representations retained it. This is one observed task improvement, not a general estimate.
- Semantic abstraction reduced stored candidate text the most, but did not outperform exact compression on these action checks. Its mean injected text was larger than the compressed-parent arm because retrieval selected different combinations of candidates.
- The combined representation increased active evidence text from 4,169 to 6,233 bytes. Compaction did not reduce total persisted storage when originals were retained.
- Dream generation consumed 3,489 provider input tokens and 665 output tokens. Downstream mean provider input (including cache-read tokens) was 942 for sources, 867 for compressed parents, 918 for semantic hypotheses, and 936 for the combined representation. Generation cost must be counted when evaluating any savings.

These results do not justify automatically replacing evidence with model abstractions or imposing a destructive hard size ceiling. The safe implemented default is bounded compressed parents plus retained originals, with semantic prose held as an inspectable hypothesis. The expiry variant here moved the recorded timestamp consistently into the past. Actual before/after-clock behavior is verified separately in the [retention evaluation](RETENTION-EVALUATION.md): long and short modes applied the active exception before expiry, then long mode restored the durable default while short mode abstained. That separate proof does not turn these synthetic representation cases into real infrastructure execution.

A second historical run used the reviewed explicit per-case oracle and scored **7/8 sources, 6/8 compressed, 7/8 semantic, and 8/8 combined**. Its additional compressed-arm failure was the Zephyr local-preflight ambiguity. Both historical runs were internally source-stable, but five production files changed between them, so they are not repetitions of one build. The combined arm co-injected a parent and at least one source on **5/8 calls in each run**; the isolated arms did so on 0/8. The first-run artifacts remain unchanged. See the [second summary](../eval/results/dream-live-repeat2/summary.json) and [separate historical comparison](../eval/results/dream-comparison/historical.json).

### Final build: two independent repeats per case and representation

After the final retrieval change, two additional runs each generated new parents and semantic hypotheses, then executed all 32 downstream cases. Both used Pi **1.4.0**, `openai/gpt-6.1-sol`, the same explicit reviewed oracle, and **identical production source hashes**. Each run was internally source-stable and completed without execution errors. The source corpus was identical apart from its newly anchored expiration timestamp. These are two samples per case/representation, not 16 independent tasks.

| Representation | Repeat 1 / 8 | Repeat 2 / 8 | Total / 16 | Calls co-injecting parent + source | Mean injected byte bound | Mean provider input including cache |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original sources | 7 | 7 | 14 | 0/16 | 1,146.75 | 957.50 |
| Compressed parents only | 6 | 6 | 12 | 0/16 | 836.50 | 881.69 |
| Semantic hypotheses only | 7 | 7 | 14 | 0/16 | 952.00 | 907.88 |
| Sources plus compressed parents | 8 | 8 | 16 | 10/16 (62.5%) | 1,109.75 | 950.50 |

Co-injection means the same recall selected a parent and at least one of that parent's original `derivedFrom` source IDs. Its absence in isolated arms is expected by construction. The combined arm repeatedly selected redundant source/parent evidence; compressed representation size alone therefore overstates the production context saving.

The failure pattern repeated across both runs:

- Sources-only omitted the standard worker count for a non-invoice export while an invoice-only restriction was active. Grouped representations returned it correctly.
- Parents-only and hypotheses-only lost the durable fallback after the mixed temporary representation expired. The production combined arm retained the original durable evidence and passed this case.
- Compressed-only returned all-null fields for an unknown local Zephyr operation, failing the reviewed general-preflight field. It did **not** invent a command. This refusal-semantics ambiguity accounts for its two-point gap from the semantic arm; it is not evidence that semantic generalization retained more operational knowledge.
- Every generated representation retained all four source command literals. Neither repeat invented commands for unknown-environment cases or used the expired temporary limits.

Active evidence text remained **4,169 bytes** for sources, **2,064** for parents-only, and **6,233** for combined. Independently generated semantic text was **1,434** and **1,397 bytes**. Retaining originals increased stored evidence; no destructive ceiling or source replacement is supported by these results.

| Measured provider tokens | Repeat 1 | Repeat 2 |
| --- | ---: | ---: |
| Dream generation input, including cache reads | 3,487 | 3,499 |
| Dream generation output | 637 | 651 |
| All 32 downstream calls: input, including cache reads | 29,595 | 29,566 |
| All 32 downstream calls: output | 1,111 | 1,106 |

Generation costs are additional to downstream usage. The combined arm averaged only **7 fewer provider input tokens per call** than sources-only; generation cost dominates that difference in this small workload. These measurements do not establish net token savings or broad generalization gains. The evidence supports retaining originals, exposing semantic prose as hypotheses, and treating lossless parents as an optional recall representation whose redundancy still needs measurement.

Artifacts: [repeat 1 summary](../eval/results/dream-live-final1/summary.json), [repeat 2 summary](../eval/results/dream-live-final2/summary.json), and [final comparison with input checksums, source hashes, costs, and exact failures](../eval/results/dream-comparison/final.json). Raw model responses, selected IDs, and canonical store snapshots remain beside each summary. Recompute the comparison without model calls:

```sh
python3 pi-memory/eval/results/dream-comparison/compare.py \
  --out pi-memory/eval/results/dream-comparison/final.json \
  pi-memory/eval/results/dream-live-final1 \
  pi-memory/eval/results/dream-live-final2
```
