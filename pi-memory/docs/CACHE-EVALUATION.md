# Measured prompt caching impact

The initial caching experiment used the installed Pi 1.4.0 binary and `openai/gpt-6.1-sol`, with two six-turn sessions per arm. It measured **actual provider-reported usage**, not just equal prompt strings. Each session had the same synthetic project reference, acknowledgment prompts, output cap, and a unique stable partition marker to avoid intentionally warming another session. Arm order reversed for the second repetition.

The production arm loaded pi-memory with capture disabled and normal persisted recall. The diagnostic control used the same extension and facts but changed a leading marker on every request, deliberately breaking the reusable prefix. It is a sensitivity control, not a competing memory implementation. The no-memory arm omitted the extension.

| Arm | Requests | Total input tokens | Cached input tokens | Cached share | Warm-turn cached share | Mean response ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No memory | 12 | 75,400 | 48,640 | 64.5% | 77.2% | 2,668 |
| Persisted memory recall | 12 | 80,838 | 59,008 | 73.0% | 87.4% | 2,947 |
| Prefix-breaking diagnostic | 12 | 80,832 | 6,656 | 8.2% | 9.9% | 5,943 |

All ten production memory follow-up requests preserved the previous provider-visible input prefix exactly. Actual caching still missed on some unchanged prefixes; the diagnostic control also had one reported cache hit. Prefix stability therefore preserves eligibility, but it does not guarantee a cache hit. The small sample cannot establish that memory improves cache-hit probability versus no memory, nor attribute noisy latency differences entirely to caching.

Memory added 7.2% total input tokens in this particular experiment. Its cache preservation avoided the much larger uncached-input volume observed in the diagnostic control. Pi's SDK estimated total request costs of $0.0590, $0.0502, and $0.1496 respectively; these are recorded SDK estimates, not billing statements or a forecast. The provider reported zero cache-write tokens in these runs; the report does not invent unreported write charges.

The first harness treated exact `ACK` formatting as an assertion. Five no-memory responses used `ACK.` instead. Their usage is included in every aggregate; the original failed assertion and raw results are retained. The corrected summarizer separates output-format deviations from transport/completion failures. This experiment measures caching, not acknowledgment quality or hard-task performance.

Raw requests, provider usage, first-text timing, Pi events, source hashes and per-run records are in [cache-v1](../bench/results/cache-v1/). [measurement-summary.json](../bench/results/cache-v1/measurement-summary.json) preserves original errors while recomputing the complete measurement denominator.

```sh
node --import tsx pi-memory/bench/cache-impact.mjs --repeats=2 --out=/tmp/cache-results
node pi-memory/bench/summarize-cache.mjs /tmp/cache-results
```

OpenAI documents that cache reuse depends on compatible request settings and an exact reusable prefix; GPT-5.6 and later require at least 1,024 eligible visible tokens. Usage distinguishes cached reads, cache writes and ordinary input, so all three should be measured rather than inferring savings from request length. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

Separate [live prefix checks](CACHE.md) exercise injection mode and combined mode; combined mode declares all six memory tools. The longitudinal task suite measures caching during real code-editing work; acknowledgment-only measurements are not a substitute for those action-level results.
