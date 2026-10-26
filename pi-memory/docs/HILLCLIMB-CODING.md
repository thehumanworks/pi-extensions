# Coding hillclimb on cheap models

This extends [LONG-RUN-EVALUATION.md](LONG-RUN-EVALUATION.md). It asks where memory still fails on real coding actions, tries bounded candidates, and measures them on two cheap models: `openai/gpt-6.1-sol` and `claude-bridge/claude-haiku-5-5`. The Haiku runs go through the Claude Code bridge on a Max plan, so their provider cost is reported as zero and their usage is almost entirely cache reads. Raw artifacts, summaries and the exact scripts are under [`eval/long/results/hillclimb-v1/`](../eval/long/results/hillclimb-v1/).

## Starting point

The accepted long-run matrix already scored 100% on remembered policy for captured memory on both synthetic projects. The one documented failure was the exploratory repair-only comparison: a fresh session asked to repair a corrupt checkpoint recalled two of the three project records and left the policy record behind, scoring 80% on ingestion and 20% on migration. Inspection of those recall traces showed why. The focused repair prompt ranked the "auxiliary config must not leak" control record above the main policy record, and the two selected records consumed the 1,200-token recall budget, so the third never fit.

That is a retrieval-shape problem, not a model problem: the knowledge the task needed was durable, user-stated and high importance, but it only reached the model if the current prompt happened to mention it.

## Candidates

Both candidates are switchable through `--memory-env` in the harness so arms compare under one source snapshot.

- **Wake block** (`PI_MEMORY_DIGEST_SCOPE=decisions`, `PI_MEMORY_DIGEST_BUDGET=2400`). The existing always-on system prompt digest held only compiled feedback and preference rules, and the evaluation ran with that budget at zero. The candidate widens the standing selection to durable user-stated project decisions with importance 8 or higher and confidence 0.9 or higher, selected live from canonical sources at session start. It is a fixed per-session reading budget in the spirit of [OptMem's `wake`](https://github.com/VictorTaelin/OptMem), rendered once, byte-stable for the session, and excluded from per-turn recall so recall spends its budget elsewhere. Tool-observed procedures with confidence 0.6 do not qualify and still arrive through recall.
- **Session ceiling** (`PI_MEMORY_SESSION_BUDGET=1200`). A cumulative cap on recall tokens injected into one session branch, restored from persisted recall messages after a restart and reset by compaction. Invalidation notices are exempt. This is the OptMem-style hard stop on memory spend. It was tested stacked on the wake block.

The harness gained `--model=` for the action sessions, automatic loading of the bridge extension when a `claude-bridge/` model is selected, `--memory-env=` passthrough, and reuse of the repeat-0 repair template when a later repeat has none. Captured history and the frozen fixture hash are unchanged; the protocol hash changes with the harness.

## Phase 1: fresh-session repair only

Two repeats per project and arm from the identical short-history stage-2 snapshot. "Memory" is the final historical-policy score; "complete" requires every check and successful CLI binding.

| Model | Arm | Memory | Complete | Requests | Uncached input | Cached input | Recall tokens per job | Wake block per request |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-6.1-sol | off | 0.35 | 0/4 | 10.25 | 7,138 | 30,592 | 0 | 0 |
| gpt-6.1-sol | long, baseline | 0.50 | 0/4 | 10.0 | 8,248 | 34,464 | 982 | 0 |
| gpt-6.1-sol | long, wake | 0.90 | 2/4 | 10.5 | 8,636 | 39,296 | 662 | 922 |
| gpt-6.1-sol | long, wake + ceiling | 0.90 | 2/4 | 10.25 | 8,076 | 36,576 | 662 | 922 |
| haiku-5-5 | off | 0.30 | 0/4 | 10.5 | 21 | 116,851 | 0 | 0 |
| haiku-5-5 | long, baseline | 0.45 | 0/4 | 7.5 | 15 | 79,820 | 982 | 0 |
| haiku-5-5 | long, wake | 0.75 | 0/4 | 7.75 | 16 | 92,529 | 662 | 922 |
| haiku-5-5 | long, wake + ceiling | 0.80 | 0/4 | 8.0 | 16 | 100,493 | 662 | 922 |

With the wake block, ingestion repairs on GPT passed every check in all four runs. Migration repairs on both models stopped at 0.8 with a single remaining failure, "expired region override does not affect later action". That check reads the inherited stage-2 `normal-report.json`, whose region was already wrong in the short-history origin snapshot, so no repair-only run can pass it without rewriting an old report. Haiku ingestion stayed at 0.8 because it did not add malformed-line quarantine while repairing checkpoint recovery, even though the decision was present in its system prompt. That is a reader limitation of the cheaper model on a narrowly worded repair request, not a retrieval miss.

Token upper bounds are UTF-8 bytes. Per-job recall fell from 982 to 662 because the two decision records moved into the wake block, which costs 922 bytes per request and is cache-eligible after the first turn of a session.

## Phase 3: full three-stage matrix

Two repeats per project, baseline arms plus the stacked candidate. This checks that an always-on block of durable defaults does not stop the model applying a temporary override and then revoking it.

| Model | Arm | Memory | Complete | Requests | Uncached input | Cached input | Output | Recall tokens per job |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gpt-6.1-sol | off | 0.15 | 0/4 | 33.25 | 19,665 | 105,632 | 3,595 | 0 |
| gpt-6.1-sol | long, baseline | 1.00 | 3/4 | 28.5 | 16,614 | 105,120 | 3,857 | 2,566 |
| gpt-6.1-sol | long, wake + ceiling | 1.00 | 4/4 | 26.5 | 13,678 | 106,112 | 4,008 | 1,324 |
| haiku-5-5 | off | 0.10 | 0/4 | 27.75 | 56 | 365,575 | 16,319 | 0 |
| haiku-5-5 | long, baseline | 0.90 | 2/4 | 24.75 | 50 | 329,571 | 15,821 | 2,566 |
| haiku-5-5 | long, wake + ceiling | 0.90 | 2/4 | 26.5 | 53 | 350,141 | 17,377 | 1,324 |

No regression on either model. All eight memory-arm runs passed the temporary override and revocation checks, so the always-on defaults did not override a current instruction. The GPT baseline's one incomplete job passed every check but hit the 16-request cap in its repair stage (exit 86); the candidate completed 4 of 4. Haiku's two incomplete migration jobs in both arms failed the same two stage-2 report checks: it ran the CLI with the right arguments but did not write `temporary-report.json` and `normal-report.json` as the task asked, and its "expired region" check then fails on the missing report. That occurs identically with memory off and is not a memory effect.

Mean SDK-estimated action cost per GPT job was $0.0823 for the baseline and $0.0781 for the candidate. These are recorded estimates on four jobs each, not evidence of a cost saving.

The session ceiling never engaged. Each stage is a separate process, stage 1 and 2 share one session, and the stage-1 recall of 618 to 706 bytes left room under 1,200 for stage 2, whose recalls were empty because the only matching record was already in the wake block. The ceiling is therefore shipped as an opt-in safety limit with a deterministic unit test and no measured task effect.

## Decision

`digest.scope` now defaults to `decisions`. The default digest budget of 1,200 holds both decision records of either project in this corpus (898 and 946 bytes). `retrieval.sessionBudgetTokens` defaults to 0, meaning no ceiling.

## Limits

Two synthetic projects, two repeats, two models. The repair-only migration score has a hard floor from the inherited report, so 0.8 there is saturation, not a remaining gap. The results characterise the current source, which differs from the accepted long-run snapshot by the capture-model requirement, the `/memory model` command, and these two candidates. The audit script expects the full five-arm cell matrix, so on these partial matrices it reports missing cells; its hash, scope and binding checks found no other problems. The bridge reports zero cost and no provider cache writes, so Haiku token columns are not comparable with the GPT columns.

## Reproduction

```sh
cd pi-extensions
node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --out=/tmp/hc-c0 --arms=off,long --repeats=2 --concurrency=2 \
  --model=claude-bridge/claude-haiku-5-5 --repair-only-from=pi-memory/eval/long/repair-templates-v3/long
node --import tsx pi-memory/eval/long/run.mjs --state=pi-memory/eval/long/state-v3 --out=/tmp/hc-c2 --arms=long --repeats=2 --concurrency=2 \
  --model=claude-bridge/claude-haiku-5-5 --repair-only-from=pi-memory/eval/long/repair-templates-v3/long \
  --memory-env='PI_MEMORY_DIGEST_SCOPE=decisions;PI_MEMORY_DIGEST_BUDGET=2400;PI_MEMORY_SESSION_BUDGET=1200'
python3 pi-memory/eval/long/results/hillclimb-v1/compare.py /tmp -v
```

Omit `--repair-only-from` for the full matrix. With the new default, reproducing the baseline arm now requires `--memory-env='PI_MEMORY_DIGEST_SCOPE=rules'`. The shell scripts beside the results record the exact phase invocations.
