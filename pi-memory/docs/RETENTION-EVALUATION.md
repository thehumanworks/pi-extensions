# Short and long memory changed real actions across expiry

The [final real-clock run](../eval/results/retention-live-timestamp/summary.json) passed all eight installed-Pi sessions using `openai/gpt-6.1-sol`, with unchanged production source hashes. Two real prior conversations automatically captured a durable four-worker default and a one-worker override expiring three minutes later. Six fresh action sessions used identical prompts before and after the actual deadline. No fake clock or expiry reminder was added to those prompts.

Each action was verified against both Pi's actual `write` tool call and the resulting `worker-plan.json`, not the model's explanation.

| Available memory | Before expiry | After actual expiry |
| --- | --- | --- |
| Durable default plus temporary override | Wrote `{"workers":1}` | Wrote `{"workers":4}` |
| Temporary record only | Wrote `{"workers":1}` | Abstained; no file or write call |
| Memory disabled | Abstained; no file or write call | Abstained; no file or write call |

The short-only arm clones the real captured store and archives its durable records. It is a retention ablation, not a conversational rolling-window implementation. Capture is disabled during action sessions so the agent cannot learn its own output. The long-task suite separately compares a recent-history window with persistent memory.

## Iterations retained in the evidence

1. [Initial capture failure](../eval/results/retention-live/summary.json): the durable default was skipped because a neighboring standing prohibition mentioned temporary overrides. The temporary record was saved. This exposed a lifetime-classification bug; the exact wording became a regression test.
2. [Capture fixed, reader failed](../eval/results/retention-live-final/summary.json): both source-grounded records were saved and retrieved, but the pre-expiry long arm wrote four workers and the short arm abstained. Both post-expiry behaviors were correct. Correct retrieval alone did not establish correct actions.
3. [Timestamped recall](../eval/results/retention-live-timestamp/summary.json): short records now show the host retrieval time alongside their expiry, and guidance states that active temporary overrides govern current actions while durable defaults remain available afterward. All six action checks passed.

The final expiry was `2026-10-25T14:05:28.164Z`; raw timestamps, prompts, captured items, selected IDs, tool arguments and file results are retained. The retrieval timestamp is appended with recalled evidence. It does not rewrite prior messages or change the fixed session prompt on later turns.

This is one synthetic policy and one repetition per action condition. It proves this concrete before/after behavior, not a general accuracy rate for temporal reasoning. Timestamping adds some context, and actions occurring long after retrieval still require current verification. Separate integration tests check invalidation notices within an existing conversation when recalled evidence expires or changes.

```sh
node --import tsx pi-memory/test/retention-live.mjs /tmp/pi-memory-retention-results
```

The output directory must be empty. The run uses a real three-minute wait and persists unsuccessful runs instead of silently retrying them.
