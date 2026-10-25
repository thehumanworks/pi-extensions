# Research and implementation decisions

Checked against primary sources on 2026-10-25. The imported [research proposal](RESEARCH.md) and [architecture proposal](../ARCHITECTURE.md) remain historical design inputs. Their runtime versions, proposed embedding support, and literature performance figures do not describe the shipped implementation or its measured performance.

## What the additional research changes

[LongMemEval](https://arxiv.org/abs/2410.10813) distinguishes extraction, multi-session reasoning, temporal reasoning, updates, and abstention, and separates indexing, retrieval, and reading. Accordingly, the evaluation measures both recalled evidence and downstream correctness, includes missing-information controls and later corrections, and tests expiry. The local synthetic fixtures are not a run of LongMemEval and do not inherit its published results.

[Agentic Context Engineering](https://arxiv.org/abs/2510.04618) describes lost detail from repeated summary rewriting and uses incremental reflection and curation. This supports keeping individual source records and supersession history. Our implementation uses a reflector and curator but does not claim to reproduce ACE. Live tests exposed the same practical hazard: replacing a bundled policy with a partial correction can lose unchanged fields, and a mixed short/long summary can expire while its durable default is still needed.

[Letta's sleep-time compute design](https://www.letta.com/blog/sleep-time-compute/) separates conversational work from asynchronous memory processing and makes processing frequency a cost tradeoff. Pi-memory therefore schedules bounded dream passes after an idle delay, cancels on foreground work, and persists retry backoff before inference. It does not assume that making extra model calls improves quality. Compressed evidence and semantic hypotheses have separate evaluation arms; hypotheses stay outside automatic recall.

[OpenAI's caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) and [diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics) motivate measuring actual cached usage alongside prompt-prefix stability. Pi-memory persists recall as appended messages and holds its digest and declarations fixed for a session. Our cache experiment reports provider usage and retains cache misses, rather than treating identical prefixes as proof of a hit.

## Decisions from the local measurements

| Question | Implemented decision | Evidence and limits |
| --- | --- | --- |
| Must retrieval use an additional model? | Lexical retrieval by default; optional bounded selector | The small frozen benchmark reaches its ceiling without a selector. This does not establish semantic-search parity on natural histories. |
| Should unused facts be evicted by count or age? | No destructive hard cap; explicit expiry and evidence invalidation | The growth experiment loses rare required facts under hard caps. Broad same-project queries still retrieve noise. |
| Does compression permit deleting originals? | Retain originals, link derived parents to exact source fingerprints | Candidate-only representations lose a durable fallback when a mixed-lifetime parent expires. |
| Can generalizations become standing rules automatically? | Save model generalizations as unreviewed hypotheses | Current action checks provide too little evidence for automatic promotion. |
| Is capture success implied by a successful model response? | Inspect canonical records and downstream actions | Real history runs exposed silently skipped corrections and incomplete replacements. Regression tests and fresh history recapture validate fixes. |

See [baseline and hillclimb](EVALUATION.md), [caching](CACHE-EVALUATION.md), [dreaming](DREAMING.md), and [storage growth](STORAGE-EVALUATION.md) for denominators, artifacts, and limitations. Installed-Pi tests use `openai/gpt-6.1-sol`; mock unit tests test contracts, not model quality.
