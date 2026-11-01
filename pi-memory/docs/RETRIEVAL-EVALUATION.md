# Embeddings and graph evaluation

Automatic recall has two stages. SQLite FTS5 picks up to 24 candidates, then the classifier judges them. A memory that shares no stemmed word with the prompt never reaches the classifier. This evaluation asks whether embeddings or a graph fix that often enough to justify them. Nothing here is built.

Run it with:

```bash
AI_GATEWAY_API_KEY=... node --import tsx eval/retrieval-live.mjs vercel-ai-gateway/openai/gpt-6-luna-decisions openai/gpt-6.1-sol <cache.json> [out.json]
```

## Setup

`eval/retrieval-cases.json` holds 50 memories and 103 prompts. The search space is 168 memories, because the 118 memories of `eval/cases.json` and `eval/stress-cases.json` are added as distractors. Every strategy ends with the real classifier gate at its usual threshold, and embeddings are `openai/text-embedding-3-small` through the Vercel gateway.

| Class | Prompts | Written by | What it tests |
| --- | ---: | --- | --- |
| natural | 30 | `gpt-6.1-sol`, seeing one note at a time | The request as a developer would type it |
| overlap | 10 | Author of the memories | Prompts that share words with the memory |
| paraphrase | 16 | Author of the memories | The same need in other words |
| disjoint | 29 | `gpt-6.1-sol`, told to share no content word | The worst case for FTS5 |
| multihop | 10 | Author of the memories | Two memories, where the second is reachable only through the first |
| negative | 6 | Author of the memories | Nothing applies |

`fts raw` searches memories as the raw layer stores them. `fts distilled` adds the keywords and triggers reflection writes. `hybrid` fuses FTS5 and embedding ranks. `hybrid + graph` runs the gate on hybrid candidates, follows shared named entities one hop from what it kept, and runs the gate again on those neighbours with the kept memories as context. `classify all` skips candidate selection, which makes it the ceiling for this classifier.

## Results

Final recall after the gate. The last row counts memories injected that were not labelled relevant.

| Class | fts raw | fts distilled | embed | hybrid | hybrid + graph | classify all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| natural | 100% | 100% | 100% | 100% | 100% | 100% |
| overlap | 100% | 100% | 100% | 100% | 100% | 100% |
| paraphrase | 19% | 44% | 81% | 81% | 81% | 88% |
| disjoint | 14% | 69% | 90% | 86% | 86% | 100% |
| multihop | 45% | 60% | 50% | 60% | 85% | 65% |
| multihop, second memory only | 10% | 40% | 20% | 40% | 80% | 50% |
| all | 53% | 75% | 85% | 86% | 90% | 91% |
| wrong memories per prompt | 0.15 | 0.20 | 0.18 | 0.22 | 0.24 | 0.35 |

The classifier gate took 540 ms at the median for 24 candidates. `classify all` took 3.9 s, in sequential batches. The second gate pass added about 120 ms at the 90th percentile and almost nothing at the median, because it runs only when a kept memory has neighbours. No strategy except `classify all` injected anything for the negative prompts.

The two refused prompts described below are excluded from the table. Including them lowers no strategy, since their failure returns unfiltered candidates, but it inflates paraphrase and disjoint by a few points and adds up to eight wrong memories for each.

### Real prompts

The 58 distinct prompts from this repository's Pi sessions went through the classifier against all 9 memories visible to the project, with no candidate stage. It kept 30 pairs, and FTS5 could reach 29. The lost one was a five-word follow-up: "follow Pi's standards, that's the decision." This sample flatters FTS5, since those memories came from those sessions and the store is tiny.

### Embedding details

| Dimensions | Candidate recall |
| ---: | ---: |
| 256 | 85% |
| 512 | 85% |
| 1024 | 89% |
| 1536 | 91% |

Shortening saves little: 1536 dimensions is about 6 KB per memory. A plain JavaScript scan of 512-dimension vectors took 4 ms for 10,000 memories and 40 ms for 100,000, so no vector index is needed at this scale. An embedding call took 430–890 ms through the gateway, which would be added to every turn inside the 2.5 s recall deadline.

## Reading the results

- **Natural wording does not need embeddings.** FTS5 reached everything when the prompt was written freely. Embeddings help when the wording differs, and this data cannot say how often that happens at scale. The `natural` prompts came from a model that had read the note, so they probably share more words than a real prompt would.
- **Distillation is worth more than it looked.** FTS5 goes from 14% to 69% on disjoint prompts once reflection has added keywords. Raw entries lack those keywords, so they are the memories FTS5 finds worst, until a sleep pass runs.
- **Most multi-hop loss is in the gate, not in candidate selection.** `classify all` sees every memory and still finds only 50% of second memories, since nothing in the prompt relates to them. The graph step reaches 80% because the classifier sees why the neighbour matters. A graph that only adds candidates to the first gate pass reached 60%.
- **The ceiling for small stores needs no new dependency.** While a project has at most 24 visible memories, sending all of them to the classifier gives `classify all` recall at the cost of a normal call.

## Decision

Build none of this yet, and do not adopt a graph database. In order, when each becomes worthwhile:

1. **Classify everything while it fits.** Skip FTS5 when the visible memories fit one classifier call. This needs no dependency and covers today's 9 memories.
2. **Embeddings past 24 memories.** Fuse them with FTS5, as an opt-in `memory.embeddings.model`. pi-ai has no embeddings API, so this needs a small client, and each prompt and memory goes to one more endpoint. Vectors belong in the rebuildable SQLite index as BLOBs, keyed by content hash, so a rebuild does not embed everything again.
3. **Entity links from the sleep pass.** Reflection records named entities, and recall does the one hop as an indexed lookup followed by a second gate pass. This is the largest gain measured here, but it rests on 10 prompts written by the same author as their memories. It needs a held-out set before it is built.

A graph database adds nothing to that third step, because one hop over an entity table is a join. Multi-hop traversal has no evidence behind it here, and the [ACL 2026 comparison](https://arxiv.org/abs/2601.01280) does not support a general win for graphs either.

## Storage options

Markdown is canonical and the index is rebuildable, so moving to cloud storage is a question of syncing files and index, not of search. The search code needs only one small interface to allow that later.

| Option | Finding |
| --- | --- |
| BLOBs in the existing SQLite index | No dependency, works under Node and Bun, fast enough at this scale. Recommended. |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Apache-2.0 or MIT, but "pre-v1, so expect breaking changes". Needs [`allowExtension`](https://nodejs.org/api/sqlite.html) when the database is opened. |
| [libSQL / Turso](https://docs.turso.tech/features/embedded-replicas/introduction) | Built-in `F32_BLOB` and `vector_top_k`. Embedded replicas read locally and send writes to the primary unless `offline` is set. The clearest local-to-cloud path, but its docs do not say whether vector search runs on a local replica, and they point new projects at Turso Sync. |
| [LadybugDB](https://github.com/LadybugDB/ladybug) | The maintained fork of Kuzu: Cypher, full-text and vector indexes. Solves a problem this store does not have. |

Not evaluated: PGlite with pgvector, and FalkorDBLite.

## Outside evidence

- [Does Memory Need Graphs?](https://arxiv.org/abs/2601.01280) (ACL 2026) finds that implementation details matter more than the graph itself. On LongMemEval-S with GPT-4o-mini, graph beats flat on R@5, 0.969 to 0.928. Answer accuracy is 0.892 to 0.760 when retrieved values are whole sessions, but 0.690 to 0.752 when values are keys. Flat also wins on HaluMem-medium extraction recall, 0.712 to 0.474. Retrieval took 574 ms against 240 ms. Adding summaries, facts and keywords to keys raised R@5 from 0.902 to 0.938, the same effect as `fts distilled` above.
- [arXiv 2601.07978](https://arxiv.org/html/2601.07978v1) reports Mem0, RAG and full context at 77–81% on LoCoMo, against 55–56% for Graphiti and cognee.
- [agentmemory](https://github.com/rohitg00/agentmemory/blob/main/benchmark/COMPARISON.md) reports 86.2% for BM25 and 95.2% with vectors added. It is a vendor benchmark, and [memini](https://pkg.go.dev/github.com/eleboucher/memini/bench) reports only 97.6% to 98.4% with better stemming, so the gap depends heavily on setup.

Pricing: [OpenAI's embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) implies about $0.02 per million tokens for `text-embedding-3-small`. The [Vercel embeddings endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/embeddings) worked with `AI_GATEWAY_API_KEY`.

## Limits

- Except for `natural` and `disjoint`, the prompts were written with the memories. The classifier threshold was not tuned on held-out data.
- 2 of the 103 prompts were refused: the classifier answers `{"type":"refusal"}` for some prompt and memory pairs, and pi-ai then fails the whole request. Those prompts are the ones about printing contact details and about load-testing a payment vendor, and they are left out of the results above. Recall now asks again one memory at a time and keeps the refused memory, since it may be the one the prompt needs. Before that change, one refusal let every candidate through unjudged. In six live rounds on those two prompts the payment prompt was refused three times, kept 2 of 24 candidates including the relevant memory, and took about 1.1 seconds. In an earlier four rounds, three reached the 2.5-second deadline for a reason not found. Memories a deadline cuts off stay unjudged.
- Shorter vectors were measured by cutting the full ones and normalizing them, which [OpenAI documents](https://developers.openai.com/api/docs/guides/embeddings) as a way to shorten them.
