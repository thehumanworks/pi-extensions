# Automatic idle dreaming in installed Pi

The [final RPC integration run](../eval/results/background-live-release/summary.json) passed with installed Pi and `openai/gpt-6.1-sol`. The tested scheduler, extension integration, retrieval and storage source hashes stayed unchanged and match the final action-matrix snapshot. The harness uses ordinary RPC prompts; it never invokes `/memory dream` or calls `DreamPipeline` directly.

| Case | Observed behavior |
| --- | --- |
| Completion after idle | The foreground response settled, then the configured one-second idle delay allowed a real dream call. A parent appeared 9.55 seconds after settlement; all three source items remained active. |
| Ordinary follow-up | The next response completed successfully and did not repeat the completed dream pass. |
| Session switch before idle deadline | A new session disposed the scheduled five-second timer. No dream-attempt checkpoint or model call appeared after waiting beyond the deadline. |

The dream call reported 670 uncached input tokens, 2,048 cache-read tokens, 238 output tokens and zero cache-write tokens. The lossless rendered representation decreased from a conservative byte bound of 1,502 to 901. These are different measurements: the latter is not a provider token count or a billing reduction.

The initial [diagnostic run](../eval/results/background-live/summary.json) successfully scheduled inference and saved an unreviewed hypothesis, but deliberately conservative sentence handling refused a parent because its source text contained dependent-word markers. The harness originally required a parent, so that run failed the assertion. Its artifacts remain intact. The next fixture used standalone sentences without those markers; no production behavior was changed to make the test pass.

An [earlier passing run](../eval/results/background-live-final/summary.json) preceded the final short-term timestamp/guidance change. The integration was rerun above after that change; the earlier result is retained separately.

The follow-up acknowledgment also recalled the parent on a generic word overlap. The reply stayed correct, but this is an observed relevance limitation and needless context cost. The scheduler test does not establish perfect retrieval precision or a general compression rate.

This test seeds synthetic canonical source records and a persisted pending-maintenance trigger. It isolates actual idle scheduling and cancellation; it does not prove automatic capture or threshold detection. Unit tests separately cover overlapping schedules, cancellation during an in-flight task, durable backoff across restarts, retry after backoff without another user turn, and late callbacks from disposed sessions. Provider cancellation latency under load remains unmeasured.

```sh
node --import tsx pi-memory/test/background-live.mjs /tmp/pi-memory-background-results
```

The output directory must be empty. Raw RPC events, timed event records, traces, selected sources, generated parent, provider usage and source hashes accompany the summary.
