# Semantic search and reranking for pi-recall

A proposal. Nothing here is implemented. It builds on the uncommitted 0.3.1 working tree
(`recallConfig` in pi settings, test-only files excluded from the tarball).

## Recommendation

Add a derived SQLite index of the project's history and a retrieval pipeline over it:
BM25 full-text search, optional dense embeddings, rank fusion, and an optional reranker.
Expose it in three places, in this order:

1. `recall_search` with `match: "semantic"`, ranked by relevance (the agent tool).
2. A filter box in the `/recall` screen, and `/recall find <query>` (the slash command).
3. Auto-recall: a bounded, deduplicated block of relevant earlier messages injected before a turn
   from the user's prompt and project context (later, opt-in).

The design is tiered by what works with the credentials this machine has today.

### What the environment allows

| Fact | Consequence |
| --- | --- |
| OpenAI and Anthropic auth in `~/.pi/agent/auth.json` are both OAuth sign-ins | No hosted embeddings and no OpenAI Decisions classifier (`openai/gpt-6-luna`) without a separate API key. pi-memory hit the same wall. |
| `modelRegistry.streamSimple` works with OAuth models (`openai/gpt-6.1-terra`, `anthropic/claude-haiku-5-5`) | A chat-model reranker works on day one, as `backgroundCompaction.model` already does. |
| pi-ai 1.4.0 has `classify()` but no embeddings API | Embeddings need our own small HTTP adapter. |
| `node:sqlite` with FTS5 (`porter unicode61` and `trigram`) works in Node 24 and in Bun 1.4.2, verified here; the package floor is Node 22.19, where FTS5 availability is untested in this session | One import path, no native dependency, no build step for `pi install npm:`. |
| Corpus today: 56 session files, about 2,100 message-level documents, about 430k chars of conversation text, 8.6M chars of tool output | Brute-force cosine over stored vectors is fine for years. Do not add sqlite-vec. Embed conversation text, not tool output. |
| `search.ts` already says `order: "recent"` with a comment reserving relevance ranking; `sessions-tool.ts` keeps its cursor opaque for the same reason | The tool contracts anticipated this. |

### Tiers

| Tier | Needs | What it gives | Honest label |
| --- | --- | --- | --- |
| 0. BM25 index | nothing | Fast lexical search with ranking, snippets, prefix queries for the filter box. Replaces the linear regex scan for literal queries too. | Lexical |
| 1. Query expansion | a chat model (OAuth is fine) | The model turns a natural-language query into FTS terms and synonyms before BM25. | A lexical approximation of semantic search, not the real thing |
| 2. Chat-model rerank | a chat model | Top 30 to 50 fused candidates scored against the query; precision goes up a lot at this corpus size. | Real relevance judgement, 1 to 3 s latency |
| 3. Dense embeddings | an OpenAI-compatible `/embeddings` endpoint and key: OpenAI API key, or a local Ollama or LM Studio server | True semantic recall of paraphrases and vague queries; hybrid with BM25 through reciprocal rank fusion. | Semantic |
| 4. Classifier rerank | an API key for a classifier model | Cheaper and faster than a chat rerank, one request per batch, the pattern pi-memory's `extract.ts` used. | Semantic, when available |

Tiers 0 to 2 ship first and work for this user without any new account. Tier 3 is the switch that
makes `match: "semantic"` live up to its name; tier 4 is a drop-in alternative reranker.

## Design

### Index

**Location.** `<sessionDir>/pi-recall/index.sqlite`, beside `marks.jsonl`. Pi never reads
subdirectories of a session folder. In pi's default layout there is one index per project; with a
shared session directory one index holds every project, filtered by a `project` column, which is
how `loadMarks` already treats that layout. A scope that spans several session directories, such as
`project: "all"` or projects linked through `recallConfig`, opens one index per distinct
`sessionDir` and merges candidates before fusion, as `loadMarks` iterates directories. The
alternative, one index for every project under `getAgentDir()` where `guidancePath` already lives,
is simpler to query but ties index lifetime to the agent folder rather than to the sessions it
describes.

**Canonical data stays in the JSONL files.** The index is derived and rebuildable. A `meta` table
holds the schema version and the embedding model id. On mismatch the index is dropped and rebuilt,
the pi-memory pattern. `/recall reindex` forces it.

**Document unit.** One row per indexed field of a recalled entry, reusing the `fields()` partition
in `search.ts`: `where` in `text | summary | label | args | output`, plus `tool`. Key is
`(sessionId, entryId, where, tool)`. That keeps the `in: ["text", "tools", "outputs"]` parameter
meaningful in semantic mode. Columns: `project`, `sessionId`, `entryId`, `timestamp`, `type`,
`role`, `where`, `tool`, `text`. An FTS5 table mirrors `text` with `porter unicode61`; a second
FTS5 table with `trigram` serves paths and identifiers (`src/recall.ts`, `ENOENT`) and prefix
queries while typing.

**Chunks and vectors.** Only `where = text | summary | label` is embedded by default. Long texts
are chunked at about 1,500 chars with 200 of overlap. A `chunks` table holds
`(docKey, ordinal, text, embedding BLOB, model)`; vectors are float32 blobs, compared by brute-force
cosine in JS. Scores aggregate to a ref by max over its chunks and fields.

**Incremental update.** A `files` table records each session file's path, size, mtime and last
indexed entry id with its byte offset. Session files are normally append-only, so a grown file is
parsed from its previous size, but `SessionManager.open` can rewrite old-format files, as the
`openReadonly` comment in `sessions.ts` notes. The pass therefore checks that the recorded entry id
is still at the recorded offset before reading forward; otherwise, or when the file shrank or its
header changed, the file is reindexed whole. Fork copies carry their parent's entry ids,
which the existing `markLookup` lineage logic already handles; the index keys by session so copies
are separate rows, and ranking dedupes refs that share an entry id across a fork lineage.

**The current session** lags on disk, so it is indexed live from `sm.getEntries()` on
`agent_settled`, never from its file. Indexing runs when pi is idle and before a search that finds
stale files, with a progress note in the footer status.

**Concurrency.** Open with WAL and a busy timeout. Two pi terminals in the same project, or asx
workflow agents that are full pi sessions, can index the same directory at once.

### Retrieval pipeline

```
query ──┬─ BM25 (FTS5)             ─┐
        ├─ expansion → BM25 (opt) ─┼─ reciprocal rank fusion ─ filters ─ rerank (opt) ─ top k
        └─ cosine over chunks (opt)─┘
```

1. **Candidates.** BM25 top 100; dense top 100 when embeddings exist; expanded-term BM25 when a
   chat model is configured and the query is natural language (heuristic: several words, no path
   or identifier). Fusion by reciprocal rank with k = 60.
2. **Filters that already exist must carry over.** Project scope from `resolveScope`, `sessionId`,
   `in` scopes, and the exclusions `sessionView` applies: active branch only, `isRecalled`,
   in-context entries unless `includeContext`. Cheapest approach: index everything, then pass
   hits through `sessionView(...).excluded(id)` for the few sessions that scored. Thinking blocks
   are never indexed, as elsewhere.
3. **Priors**, mild and multiplicative: recency decay with a long half-life, a boost for user
   messages and compaction summaries over assistant text, a boost for messages marked critical,
   and a cap per session so one long session cannot fill the page.
4. **Rerank** the top 30 to 50. Chat model: one listwise request returning ordered ids with a
   relevance grade per candidate; fall back to pointwise batches if the output does not parse.
   Classifier model: one `classify()` request with a score question per candidate, each candidate
   in its own question so one text cannot sway another, split on refusal as pi-memory did.
   Candidates that fall below a grade threshold are dropped, not just reordered.
5. **Snippets.** For lexical hits, FTS5 `snippet()` or the existing `snippets()` over matched
   ranges; for dense hits, the start of the best chunk. Format matches today's `SearchHit`.

### Surfaces

**`recall_search`.** New `match: "semantic"` beside `literal` and `regex`. The result gains
`order: "relevance"`, `score` per hit, and `ranking: { lexical, expanded, dense, rerank }` saying
which stages ran, so the agent and the user can tell a tier 1 answer from a tier 3 one. Paging
changes contract: the ranked result set is cached per query hash for the session and `next` is an
opaque offset into it, as `sessions-tool.ts` already allows. `literal` and `regex` keep newest-first
semantics. `literal` uses an FTS5 phrase query only as a candidate prefilter: the porter
tokenizer is case-insensitive and stems, so it cannot honour smart case or the any-whitespace rule.
Each candidate is verified with the existing `Matcher.ranges()` on the stored text, which also
yields the snippets and keeps `caseSensitive` truthful; the regex scan remains the fallback for a
stale file. In semantic mode the `tools` and `outputs` scopes are lexical-only, since only `text`,
`summary` and `label` are embedded. `recall_sessions` gains an optional `query` that ranks sessions by their best hit, which
answers "which session was that in?" directly. The tool description changes from "something you can
name" to also cover "something you can only describe".

**`/recall` screen.** `/` opens a one-line filter (pi-tui `Input`) above the list. While it has
focus, printable keys go to the input and the `p`, `r`, space and arrow handlers are suspended.
Typing runs FTS5 prefix queries on the index, debounced, trigram for three or more characters and
porter prefix below that, and replaces the pager: filtering only the loaded 50 entries would hide
unloaded history, so the list becomes a ranked result set with
`more` paging through it. Enter runs the full pipeline, with dense and rerank when configured, and
shows a `relevance` badge and score; Escape clears the filter and restores the chronological pager
at the previous cursor. Session headers stay, grouped per hit. `/recall find <query...>` opens the
screen already filtered; `parseArgs` today rejects more than one word, so `find` is a new keyword
rather than a change to the single-word session-id form. Selection and attach work unchanged.

**Auto-recall** (phase 3). On `before_agent_start` with `messageType: "user"`: build the query from
`event.prompt` plus project context in the shape pi-memory's `extract.ts` used, namely cwd basename,
git branch and recently changed paths, and excerpts of instruction files. Run the pipeline scoped to
this project and the projects `recallConfig` names, exclude the current branch's in-context
entries, the marks block's refs, and refs already injected by a previous auto-recall block on this
branch (the `alreadyInContext` idea from `marks/reader.ts`). Keep what clears the rerank threshold
within a char budget like `PAGE_MAX_CHARS` but smaller, default about 6,000 chars, at most 5
messages. Return a `custom_message` wrapped as `<recalled_messages source="auto">`, matching
`attach.ts`, each message with its ref so `recall_messages` can read around it. Hard timeout,
default 2.5 s, after which it falls back to lexical and then to nothing: a prompt never fails or
waits long because of recall. Off by default; `/recall auto on` enables it, and the setting warns
when no rerank model is configured, since lexical-only injection is noisy.

**One sharp edge.** An injected block is a `custom_message` and would be indexed on the next pass
and recalled again. Give it a custom type constant and exclude it in `entries.ts` exactly as
`MARKS_MESSAGE_TYPE` is excluded.

### Configuration

`recallConfig` is a list or map of projects and its parser throws on anything else, so retrieval
settings get a new key in pi's `settings.json`, global or per project when trusted, read through
the same `settingsFiles` as `recallConfig`:

```json
{
  "recallSearch": {
    "rerank": "openai/gpt-6.1-terra",
    "expand": true,
    "embeddings": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "nomic-embed-text",
      "apiKeyEnv": "RECALL_EMBEDDINGS_KEY"
    },
    "auto": { "enabled": false, "maxMessages": 5, "maxChars": 6000, "timeoutMs": 2500 }
  }
}
```

`rerank` is a `provider/modelId` resolved with `modelRegistry.find` and checked with
`hasConfiguredAuth`, as `pi-background-compaction/index.ts` does for its model; a classifier model
id selects the classifier path, any chat model the listwise path, `"off"` disables reranking.
`embeddings` is one OpenAI-compatible adapter: it covers an OpenAI key, Ollama and LM Studio with
the same code. Omitted means tiers 0 to 2 only. A changed embedding model triggers a reindex of
vectors only. Status, index size and stale-file count show in `/recall status`.

### Phases and versions

Each shipped phase is a minor bump of `@nothumanwork/pi-recall`, per the monorepo rule.

1. **0.4.0: index and lexical ranking.** SQLite index, incremental update, live current session,
   `literal` prefiltered by FTS5, `match: "semantic"` running tiers 0 and 1, ranked paging,
   `recall_sessions` `query`. Tests: index round trip from fixture sessions, incremental growth,
   rebuild on schema change, filters preserved against `sessionView`.
2. **0.5.0: rerank and the `/recall` filter.** Chat-model and classifier rerankers behind one
   interface, the filter box and `/recall find`, `ranking` in results. Tests: reranker parsing and
   fallback with a fake `streamSimple`, key routing while the filter has focus.
3. **0.6.0: embeddings.** The HTTP adapter, chunking, cosine, fusion. Tests against a fake endpoint.
4. **0.7.0: auto-recall.** Opt-in, with the dedupe and timeout rules above. Tests on exclusion of
   in-context, marked and previously injected refs, and on the timeout path.

A `README.md` is listed in `package.json` `files` but does not exist; the first phase introduces
user-facing settings and should ship it.

### Risks

- **Index drift.** Mitigated by rebuild on version mismatch and by `literal` falling back to the
  regex scan when a file is stale.
- **Latency in the modal.** Typing stays local to FTS5; model calls only on Enter.
- **Reranker output format.** Listwise JSON can fail to parse; fall back to pointwise, then to the
  fused order, never to an error.
- **Cost.** Rerank is 30 to 50 short candidates per call; embeddings of 430k chars are about 110k
  tokens once, then incremental.
- **Transformers.js or any local in-process embedder** is left out: unverified under Bun and a
  heavy dependency for a `pi install npm:` package. Ollama or LM Studio cover local embeddings
  through the same OpenAI-compatible adapter.

## Decisions for the user

1. Embeddings: an OpenAI API key, a local Ollama or LM Studio server, or stay on tiers 0 to 2 for now.
2. Rerank model default: `openai/gpt-6.1-terra` as compaction uses, or `anthropic/claude-haiku-5-5`.
3. Auto-recall default off until a rerank model is set, or on with lexical ranking.
4. Whether `recallConfig` should fold into the new key as `recallSearch.projects` in a later major bump.
