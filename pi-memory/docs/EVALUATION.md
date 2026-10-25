# Memory evaluation

The benchmark evaluates whether recalled information changes the resulting task output. It uses invented projects and facts, never the user's sessions or credentials. This is a small engineering regression suite, not a result on a public benchmark and not evidence of general superiority.

## Frozen protocol

`eval/cases.json` was frozen before retrieval tuning at SHA-256 `3d188867e7a3634fdf373c7ac3c2e0139f63229e9f9dd7922aeb1ab18246f3fe`. Eight development cases and four held-out cases cover project conventions unavailable in the repository, temporal corrections, response preferences, verified failure recovery, and combining independent constraints. Five controls cover unrelated memory, injected instructions, foreign project facts, missing approval, and a current instruction overriding remembered defaults.

Each case is run twice per arm: memory off, simple lexical baseline, and improved retrieval. All arms use the same prompt, model (`openai/gpt-6.1-sol`), thinking level (`low`), empty temporary project directory, no tools, and a provider-enforced 2,048 output-token cap. Capture is disabled. The memory cap is 1,200; the implementation conservatively bounds injected content by UTF-8 byte count, reported as a token upper bound. Actual provider input, output, reasoning, and cached token usage is recorded separately. Arm order rotates between repetitions; at most two Pi processes run concurrently. No-memory runs load only the output-budget instrumentation, while memory runs additionally load the real extension.

The suite tests recall and use of pre-seeded memories, not end-to-end automatic extraction from past sessions. Memory source records and synthetic provenance are seeded through the production store API. A synthetic foreign-project item tests scope isolation. Expected answers and validation cases are never sent to the model. Held-out outputs must not be used to tune retrieval.

## Scoring and records

Every task score is its proportion of passed checks, and the aggregate gives every task equal weight. Coding tasks execute returned JavaScript against multiple inputs, including edge cases; comments or mere inclusion of a desired phrase cannot satisfy them. Configuration tasks require the correct typed values in their operational JSON fields. The release-note task checks ordered sections and whether supplied facts appear in the appropriate section. This narrow deterministic rubric avoids an additional model judge but is not a general semantic evaluator.

The code checker supplies no host objects, imports, `require`, or `process`, disables dynamic code generation, and imposes a 100 ms timeout. It is for synthetic model outputs and must not be treated as a security sandbox for hostile arbitrary programs.

Each result directory contains a run manifest, full Pi JSON event streams, raw final responses, actual recall traces and selected IDs, source-to-ID mapping, usage, latency, checks, and errors. Latency is whole-CLI wall time, including startup and the model provider, rather than an isolated retrieval benchmark. Failures, missing traces, and missing budget instrumentation score zero rather than disappearing from the denominator. Provider errors should be reported separately from quality failures. Scope leaks mean foreign IDs selected into actual recall, independently of whether the final answer repeats them.

Acceptance targets are at least 20 percentage points of task-score gain over memory off, no control-score regression, zero scoped leakage, and p95 injected size at most 1,200 tokens. These targets are not claims until measured. Repetitions estimate run variability on this fixture set; they do not establish population-level significance.

```sh
node --test pi-memory/eval/score.test.mjs
node --import tsx pi-memory/eval/run.mjs --split=dev --repeats=2
# Freeze the candidate before this held-out run:
node --import tsx pi-memory/eval/run.mjs --split=heldout --repeats=2
node pi-memory/eval/summarize.mjs path/to/dev-results path/to/heldout-results
```

Use `--arms=off`, `--arms=baseline,improved`, or `--out=...` to split work without changing fixtures. Results must share a fixture hash before aggregation. Keep the identical model across all compared arms. The alternative authorized model is `xai/grok-4.7`; changing model requires a fresh paired run.

The spawned memory-arm command is `pi --no-extensions -e /absolute/pi-memory/eval/budget.ts --no-skills --no-prompt-templates --no-context-files --no-mcp --no-session --model openai/gpt-6.1-sol --thinking low --no-tools --mode json -e /absolute/pi-memory/index.ts --memory-dir /temporary/memory --memory-mode inject -p <frozen-prompt>`. Its environment sets `PI_MEMORY_CAPTURE=0`, `PI_MEMORY_STRATEGY=baseline` or `improved`, and a per-run `PI_MEMORY_TRACE` file. The off arm omits the memory extension and its flags, and sets `PI_MEMORY_DISABLED=1`. Credentials are handled by existing Pi authentication; the harness never reads or prints them.

## Research informing the protocol

[LongMemEval's primary paper](https://arxiv.org/abs/2410.10813) separates information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. Its [official repository](https://github.com/xiaowu0162/LongMemEval) separately annotates evidence for retrieval evaluation and excludes unanswerable cases from recall scoring because there is no correct evidence location. This motivates separate task, retrieval, and abstention checks rather than treating a high hit rate as sufficient.

[LoCoMo's official data and evaluation code](https://github.com/snap-research/locomo) includes timestamped sessions, evidence-linked questions, event summaries, and dialogue-generation tasks. Its ten-conversation release is a reminder that many questions can be correlated within a small number of histories. Accordingly this suite states its small synthetic scope and does not translate repeated calls into claims of broad statistical confidence.

[LoCoMo-Conv](https://github.com/MiuLab/LoCoMo-Conv) evaluates using past context inside ongoing conversation, including implicit and composed requests. That motivates implementation and configuration tasks where the remembered fact must influence the answer, rather than only direct memory trivia. Our fixture test is inspired by these evaluation dimensions; it does not reproduce their datasets or scoring methods.

[LongMemEval-V2's official harness](https://github.com/xiaowu0162/LongMemEval-V2) extends evaluation to workflow knowledge, environment gotchas, dynamic state, and premise awareness. Its retrieval interface withholds gold answers and question metadata, caps memory context, and reports accuracy alongside latency. Our task prompts likewise exclude validation metadata and keep output and injection caps fixed.

## Separate stress development set

`eval/stress-cases.json` was frozen before ranking tuning or memory-model runs at SHA-256 `abd9fbbcbd1e81f72fdf4a7e4466b0630cae6b4875386a8f22198ea975f6d39f`. The deterministic `build-stress.mjs` reproduces it. Four additional development cases each contain 24 overlapping, explicitly unapproved, low-confidence vendor notes. The tasks require selecting signed evidence, composing four contract facts, recognizing a paraphrased failure, and obeying a current override. This set is for tuning and must never be represented as held-out evidence. Use `--fixtures=pi-memory/eval/stress-cases.json` and summarize it separately, because fixture hashes deliberately differ.

## Measured results

Completed with `openai/gpt-6.1-sol` and two repetitions per case/arm. The recall benchmark snapshot has source hash `1defd0429289cfa36bcadea80b1ad4577696841578f63e7c2a6556bc2738631c`; the same source snapshot was used for its development, stress, and held-out runs. Subsequent expanded work changed retention, capture, and scheduling. These scores characterize that recorded recall snapshot, not an exact-source verification of every later implementation change.

| Split | Calls per arm | Memory off | Lexical baseline | Improved | Improved gain over off |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development, 8 cases | 16 | 41.67% | 100% | 100% | +58.33 pp |
| Held out, 4 cases | 8 | 50% | 100% | 100% | +50 pp |
| Combined core, 12 cases | 24 | 44.44% | 100% | 100% | +55.56 pp |

All five core control tasks scored 100% in every final arm. No final run had an execution error or scoped leakage. The improved arm's p95 injected upper bound was 627 on development and 607 on held out, below 1,200. The held-out acceptance target therefore passed on this small synthetic suite. It does not establish general task quality, real-world capture quality, or long-running action utility.

Final evidence:

- [Combined core summary](../eval/results/heldout-clean-final/summary.json), aggregating `off-dev`, `memory-dev-reading`, and `heldout-clean-final`.
- [Stress summary](../eval/results/stress-memory-reading/summary.json), aggregating `stress-off` and `stress-memory-reading`.
- The same directories contain individual `.result.json`, raw `.events.jsonl`, recall `.trace.jsonl`, budget verification, and source snapshots. Check failures and actual selected IDs can be inspected per run.

Exact final invocations, with unique empty output directories:

```sh
node --import tsx pi-memory/eval/run.mjs --arms=off --split=dev --repeats=2 --out=pi-memory/eval/results/off-dev
node --import tsx pi-memory/eval/run.mjs --arms=baseline,improved --split=dev --repeats=2 --out=pi-memory/eval/results/memory-dev-reading
node --import tsx pi-memory/eval/run.mjs --arms=off,baseline,improved --split=heldout --repeats=2 --out=pi-memory/eval/results/heldout-clean-final
node --import tsx pi-memory/eval/run.mjs --fixtures=pi-memory/eval/stress-cases.json --arms=off --split=dev --repeats=2 --out=pi-memory/eval/results/stress-off
node --import tsx pi-memory/eval/run.mjs --fixtures=pi-memory/eval/stress-cases.json --arms=baseline,improved --split=dev --repeats=2 --out=pi-memory/eval/results/stress-memory-reading
```

These commands are a record of the completed runs; choose new output directory names to repeat them. The harness rejects nonempty output directories, invalid arguments, and incompatible summary protocols. `--help` makes no model requests.

The separately frozen stress development set produced this measured hill climb (eight calls per arm per iteration):

| Iteration | Lexical baseline | Improved candidate | Finding |
| --- | ---: | ---: | --- |
| Initial ranking | 93.75% | 68.75% | Weighted term overlap displaced verified recovery; four-fact answer had only three facts in context. |
| Preserve BM25, gate weak automatic evidence, compact provenance | 100% | 75% | Retrieval selected all required evidence, but the reader abstained on the signed-decision task twice. |
| Clarify that recalled user-confirmed facts are usable evidence | 100% | 100% | Both repeated signed-decision answers now use the provided facts. |

The final stress candidate averaged 801.125 provider input tokens versus 882.875 for the lexical arm, a measured 9.26% reduction on this set at equal task score. Mean injected draft count fell from 0.75 to zero. The p95 injected upper bound was 1,121 for both arms. No control regressed. The improved arm's p95 whole-run latency was 26.217 seconds versus 10.368 seconds for lexical; this small run does **not** demonstrate a latency improvement.

These results support improving the complete retrieval-and-reading pipeline. They do not establish a task-accuracy advantage over the final lexical baseline, which also reached 100%. The stress set was used for tuning and provides no held-out generalization evidence.

Two preliminary directories are diagnostic evidence and excluded from final comparisons: `baseline-dev` exposed an underspecified code language (one answer returned Python), after which the shared prompt was corrected to require JavaScript; `memory-dev-initial` contains extension startup failures because the installed Pi runtime could not load `node:sqlite`. The fixture facts and expected answers were unchanged. The final protocol hash includes the common prompt, fixture hash, model, and budgets so these runs cannot silently be combined.

An early held-out launch was stopped after the stress reading regression was noticed, before any held-out answers were inspected. Its unfinished artifacts are quarantined in `heldout-quarantined-unopened` and excluded from all summaries. The final candidate was frozen before the fresh `heldout-clean-final` run, whose answers were inspected only after completion.

## Expanded evaluation work

Actual prompt-cache behavior, harder multi-step coding actions, disjoint project workloads, background generalization, persistent size ceilings, and short-term versus long-term action effects are separate requested measurements. They are not established by the scores above. The proposed protocol and workstream boundaries are in [LONGITUDINAL_PLAN.md](../eval/LONGITUDINAL_PLAN.md).
