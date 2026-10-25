# pi-memory: measured results and decisions

The implementation improves use of remembered project decisions on the tested tasks. It does not establish better generic coding ability, universal memory quality, or reliable cost savings. All live Pi evaluations used `openai/gpt-6.1-sol`; independent reviews used interactive Claude Code with `fable` and high effort.

## Harder coding and action tasks

Two synthetic repositories required multi-file implementation, actual CLI execution, temporary override/revocation, and fresh-session recovery. Memories came from real prior Pi sessions, including verified repairs and corrections. Every arm received the same task and tool budgets.

| Context | Complete jobs | Historical-policy correctness |
| --- | ---: | ---: |
| No memory | 0/4 | 15% |
| Recent history only | 0/4 | 35% |
| Empty extension + recent history | 0/2 | 40% |
| Captured long memory + recent history | 4/4 | 100% |
| Same store after dreaming | 4/4 | 100% |

All arms passed the measured generic coding, CLI-action, and wrong-project artifact checks. All 54 required CLI invocations used the expected arguments and returned successful JSON; 36 reports matched stdout and 18 repair artifacts passed their checks. No selected memory ID crossed project boundaries or lacked provenance. One no-memory invocation exhausted its request budget and remains included. These are two tasks with repetitions, not eighteen independent real-world projects. [Full protocol, per-project scores, artifacts and integrity audit](LONG-RUN-EVALUATION.md).

## Costs and caching

Long memory averaged 28.25 model requests per job versus 30.75 without memory. It used more total input (130,293 versus 119,452.5 tokens) and slightly less uncached input (16,309 versus 16,796.5); cache-hit variance reversed the early comparison. History capture and dream generation incur additional costs. These measurements do not support a reliable cost- or latency-saving claim.

Timestamped recall preserves the request prefix in live two-turn checks. A separate 36-request cache experiment reported 73.0% cached input for memory, 64.5% without memory, and 8.2% for a deliberately broken-prefix diagnostic. This small experiment demonstrates prefix preservation and sensitivity, not a general cache-hit improvement. [Caching measurements](CACHE-EVALUATION.md) · [prefix checks](CACHE.md).

## Retention, dreaming, and size

- **Actual expiry changes actions correctly.** Fresh sessions wrote one worker before the override expired and restored the remembered four-worker default afterward. Short-only memory abstained after expiry. The harness checked real write calls and files, with no fake clock or expiry reminder in the task prompt. [Retention experiment and failed iterations](RETENTION-EVALUATION.md).
- **Retain original evidence.** In two final representation repetitions, sources plus lossless parents passed 16/16 plans versus 14/16 for sources alone. Isolated summaries lost durable fallback knowledge when a mixed temporary summary expired. Parent/source redundancy occurred in 62.5% of combined recalls, and generation cost outweighed the small measured input saving. [Dreaming experiment](DREAMING.md).
- **Generalization remains experimental.** Model-written hypotheses stay outside automatic recall. The harder coding trials produced no usable parents, so their equal long/dream results show no additional dream benefit. Automatic idle execution and cancellation were separately verified through actual Pi RPC. [Background integration](BACKGROUND-EVALUATION.md).
- **Use soft pressure and bounded recall, not destructive count eviction.** Hard recent-item caps reduced rare-fact recall from 1.0 to 0.333 in the storage fixture. Adding 1,000 same-project distractors changed ranking without selecting a distractor in the exploratory action tests; it also exposed omitted useful policies on focused repair queries. This is not universal noise robustness. At 100,000 records, the measured storage portion of recall was about 1.1 seconds and total store size was 321 MB. [Storage and limits](STORAGE-EVALUATION.md).

The initial smaller recall benchmark and its hillclimb remain documented separately: 44.44% without memory versus 100% with either final lexical retrieval or the improved candidate, with better filtering/input use in a tuned stress set. That earlier benchmark used seeded memories and an earlier source snapshot. [Baseline, iterations and limitations](EVALUATION.md).

## Implementation boundary

The package includes scoped Markdown evidence, a rebuildable SQLite index, capture and supersession, lifetime-aware recall, fixed-prefix context, six tools, reviewed codification, and bounded idle dreaming. Embeddings, repo-local team stores, automatic cross-project promotion and automatic adoption of semantic hypotheses are not implemented. [Setup and controls](../README.md) · [Research decisions](IMPLEMENTATION-NOTES.md).

Each experiment preserves its exact source hashes and unsuccessful runs. Subsequent capture-only reliability fixes are recorded separately rather than represented as having been exercised by an older frozen action run. The [final integration report](FINAL-HARDENING.md) records 131 passing package/evaluator tests, workspace checks, package checks and live capture verification against the applied runtime.
