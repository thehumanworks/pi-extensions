# pi-memory research digest

State of the art in agent memory as of October 2026, reduced to the findings that shape the
pi-memory design. Each entry says what the source does and what pi-memory takes from it.
Sources were fetched on 2026-10-23; see links.

## 1. Landscape

A source-level comparison of eight memory systems (Synix, Feb 2026,
<https://synix.dev/articles/agent-memory-systems/>) finds four distinct bets:

| Bet | Systems | What it means |
| --- | --- | --- |
| Trust the LLM, minimal structure | Mem0, Letta | Extraction and reconciliation are LLM judgment calls; little schema or provenance |
| Explicit knowledge structures | Cognee, Graphiti, Hindsight, EverMemOS | Typed facts, entity graphs, bi-temporal edges, pipeline-enforced consistency |
| Database infrastructure first | Tacnode | ACID, time travel, multi-modal storage under any memory model |
| Data access first | Hyperspell | Connect external sources, call search "memory" |

Universal weaknesses the article documents: temporal handling is inconsistent, only Letta and
Hindsight consolidate in the background, and almost every system reduces memory to "a search index
over past conversations". Agents that plan and adapt need procedural and strategic memory too.

Takeaways for pi-memory: keep structure where it is cheap and enforceable (typed items, provenance,
status, supersession links, journaled operations) and keep LLM judgment where it is irreplaceable
(what is worth remembering, how to merge). Provide background consolidation from day one.

## 2. Capture and reconciliation

### Mem0 (arXiv 2504.19413)

Two-phase pipeline per message pair: extraction (with a rolling conversation summary and a recent
window as context) then an update phase that retrieves the top-s similar memories and asks the LLM
to pick ADD, UPDATE, DELETE or NOOP per candidate via tool calls. Reported 26% relative LLM-judge
improvement over OpenAI memory on LoCoMo, 91% lower p95 latency and >90% token savings versus
full context. Weakness noted by Synix: overwrite in place, no provenance.

Taken: the ADD/UPDATE/SUPERSEDE/NOOP reconciliation step against top-k neighbours. Changed: never
overwrite; supersede with links and keep the old item archived, and journal every operation.

### Agentic Context Engineering, ACE (ICLR 2026, arXiv 2510.04618)

Treats context as an evolving playbook of itemised bullets. Three roles: Generator (does the task),
Reflector (extracts lessons from successes and errors, optionally over several passes), Curator
(turns lessons into small delta entries merged deterministically by non-LLM code). Identifies two
failure modes of naive memory: brevity bias (summaries drop the domain detail that mattered) and
context collapse (iterative whole-context rewrites erode knowledge over time). Grow-and-refine
keeps expansion in check with de-duplication. +10.6% on agent benchmarks, lower adaptation cost.

Taken: the role split (pi-memory's reflector and curator), itemised memories as the unit of
change, deterministic merge of deltas, and the rule that the store is never regenerated wholesale.
The compiled digest is derived from items and can always be rebuilt, so digest collapse is
recoverable.

### ReasoningBank (ICLR 2026, arXiv 2509.25140)

Distils reusable strategies from both successful and failed trajectories, judged by the agent
itself without ground truth. Memory item schema: title, one-line description, content. Retrieval by
embedding similarity; new items are consolidated back after each task. Outperforms raw-trajectory
and success-only workflow memories on WebArena, Mind2Web and SWE-Bench-Verified (up to 20%
relative, up to 16% fewer steps).

Taken: the title/description/content shape, explicit `failure` and `insight` memory types, and
learning from failed tool calls followed by a fix.

### A-MEM (NeurIPS 2025, arXiv 2502.12110)

Zettelkasten-style notes with keywords, tags and a contextual description; new notes link to
similar notes, and linking can trigger "memory evolution" that updates the neighbours' attributes.

Taken: keywords, triggers and links on every item; a bounded neighbour-update step during
consolidation that refreshes keywords and links rather than rewriting bodies.

### Cursor Memories (changelog 1.2; engineering talk by Yash Gaitonde)

Prototyped a sidecar model (observes the conversation, decides what to save and update) against a
tool-call approach (main agent saves memories itself). Strong main models biased toward "task
logs", the opposite of generalisable knowledge; the sidecar needed aggressive prompting to ignore
the 90%+ of content that is task specific. Shipped a hybrid: background sidecar generates memories,
the main model lets users correct them in natural language, and user approval was added for
background-generated memories to preserve trust. Wrong memories cause the agent to double down.

Taken: background capture as the default, tools for the main agent as a secondary path, a strong
"do not store task logs" preset, review/approval for anything the memory agent proposes to codify,
and provenance plus confidence in every injected memory so the main agent verifies rather than
doubles down.

### Claude Code auto memory (<https://code.claude.com/docs/en/memory>)

Four note types: `user`, `feedback`, `project`, `reference`. Skips anything derivable from the
codebase and anything already in CLAUDE.md. Per-repository directory shared across worktrees, a
`MEMORY.md` index whose first 200 lines or 25 KB load every session, one topic file per memory,
toggle in settings and environment variable, machine-local storage. Companion guidance: move
multi-step procedures into skills, rules that must always hold into hooks.

Taken: the type taxonomy (extended with `procedure`, `insight`, `failure`, `entity`), the
"derivable from code or already in AGENTS.md" exclusion, a bounded always-on digest, one file per
memory, git-root/remote based project keys shared across worktrees, and the codification targets.

## 3. Retrieval

### LongMemEval (ICLR 2025, arXiv 2410.10813)

Round-level granularity beats session-level storage; compressing to bare facts loses detail but
helps multi-session reasoning. Expanding the index keys with extracted facts, keyphrases and
timestamps raises recall@k by 9.4% and answer accuracy by 5.4%. Time-aware query expansion helps
temporal questions by 6.8% to 11.3%. Even with perfect recall, reading strategy matters (Chain of
Note and structured formats add up to 10 points).

Taken: every memory carries LLM-generated keywords, triggers and paraphrased summary as extra
index keys, so lexical search alone performs well when no embedder is configured; injected recall
is a structured block with provenance.

### Generative Agents (Park et al., 2023)

Retrieval score = normalised recency (exponential decay, factor 0.995 per hour since last access)
plus importance (LLM-rated 1 to 10 at creation) plus relevance (cosine), equal weights. Reflection
is triggered when accumulated importance crosses a threshold and produces higher-level
observations.

Taken: the three-term prior fused with lexical and vector ranks; importance rated at capture time;
a generalisation pass when enough related items accumulate.

### Hindsight (arXiv 2512.12818)

Four networks (world facts, agent experience, observations as synthesised entity summaries,
opinions with confidence) and three operations: retain, recall with a token budget, reflect.
Multi-strategy retrieval (vector, keyword, graph, temporal). 91.4% on LongMemEval with a strong
backbone.

Taken: budgeted recall (callers pass a token budget), the separation between evidence and
inference (memory bodies state the claim, frontmatter keeps the source), and entity summaries as a
consolidation output.

### Reflective Memory Management (ACL 2025)

Topic summaries as search keys over raw segments, plus a reranker adapted online from feedback
produced during response generation.

Taken: feedback from the main agent's run (which injected memories were used, helpful or harmful)
updates usage statistics that feed the ranking prior.

## 4. Background processing and forgetting

### Letta sleep-time compute (<https://www.letta.com/blog/sleep-time-compute/>)

Two agents share memory blocks. The primary agent cannot edit core memory; a sleep-time agent
rewrites it between interactions, turning raw context into learned context. They recommend a
stronger model for the sleep-time agent because it is not latency bound, configurable frequency,
and "anytime" semantics so the primary agent can read memory while the sleeper works.

Taken: the split between a fast retrieval path and a background memory agent with its own model
setting, idle-gated scheduling, and anytime-readable memory files.

### MemoryBank (arXiv 2305.10250)

Ebbinghaus retention `R = exp(-t / S)` with strength `S` starting at 1 and incremented on each
recall, resetting `t`.

Taken: the decay formula for archival decisions, with `S` increased by helpful uses and decreased
by harmful feedback, and archive rather than delete.

### Agent Workflow Memory (ICML 2025, arXiv 2409.07429) and Voyager

Induce reusable sub-task workflows from trajectories, abstract example-specific values into
placeholders, and store them as procedural memory that compounds. Relative success-rate gains of
24.6% (Mind2Web) and 51.1% (WebArena).

Taken: `procedure` memories with placeholders, and promotion of procedures that recur into skills
with bundled scripts.

## 5. Prompt caching

Anthropic's prompt caching documentation and the `claude-api` skill
(<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>,
<https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md>) state
the invariant: caching is a byte-exact prefix match over tools, system prompt and messages in that
order, so per-turn content must come last and never move. pi-goal's `docs/CACHE.md` documents the
same lesson inside pi: ephemeral `context`-handler injections reordered the transcript and broke
the prefix, and the fix was persisted append-only custom messages. pi itself disables cache writes
for one-off summarisation calls and supports cache warming while idle.

Taken: the invariants in ARCHITECTURE.md section 9.

## 6. Local infrastructure facts verified on this machine

- pi 1.2.0 runs on Node 24.21.0 (`bin/.pi-wrapped`), and `node:sqlite` with FTS5 works in that
  binary. No native npm dependency is needed for storage or lexical search. `sqlite-vec` is not
  available, so vectors are stored as BLOBs and scored in JS.
- Local embeddings in Node use `@huggingface/transformers` (ONNX runtime). Practical small models:
  `Xenova/bge-small-en-v1.5` (384 dims, CLS pooling, query prefix) and `all-MiniLM-L6-v2`
  (384 dims). Quantised `q8` weights are tens of megabytes and download on first use.
- The pi model registry exposes classifier models (`getAvailableOfType("classifier")`), which can
  answer per-candidate yes/no relevance questions cheaply, but it has no embeddings API.
