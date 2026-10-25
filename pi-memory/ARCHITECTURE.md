# pi-memory: architecture proposal

A pi extension that learns from sessions in the background, keeps a deduplicated and compressed
memory store per project and globally, codifies recurring knowledge into skills, agents, prompt
templates and guard rules, and gives the main agent two ways to recall: automatic injection before
a run and tools it can call. Memories are searchable from the editor with `#"..."` autocomplete.

Status: original proposal, retained as a design reference. An evaluated implementation now exists;
see `README.md` for supported behavior and deliberate limits, and `docs/EVALUATION.md` for results.
Every pi API named below was checked against
the type declarations shipped with pi 1.2.0 (`dist/core/extensions/types.d.ts`) and the docs under
`docs/`. Research behind the design is in `docs/RESEARCH.md`. The memory agent preset is in
`prompts/memory-agent.preset.md`.

## 1. Goals and non-goals

Goals:

- Learn durable, behaviour-changing knowledge from sessions without the user writing anything,
  and let the user and the main agent add to it deliberately.
- Keep the store small and trustworthy: reconcile instead of append, archive instead of delete,
  consolidate and compress in the background.
- Codify knowledge into the right pi artefact when it has earned it: skill, specialised agent,
  prompt template, guard rule, or a proposed instructions edit.
- Retrieve with a fast heuristic pass plus an optional fast LLM, under a token budget, scoped to
  the project the agent is in.
- Keep every request prompt-cache friendly.
- Be fully optional: off by flag, setting, or environment variable; clearable per project,
  globally, and entirely.
- Ship a strong memory-agent prompt that is editable by the user and by pi agents.

Non-goals (for this proposal):

- Cross-machine sync or a hosted service. The store is local files.
- A knowledge graph with typed entity extraction. Links between items are enough at this scale.
- Replacing AGENTS.md or skills. pi-memory feeds them; it does not own them.

## 2. Concepts

| Term | Meaning |
| --- | --- |
| Memory item | One atomic unit of knowledge, stored as one Markdown file with YAML frontmatter. The source of truth. |
| Scope | `global` or `project:<key>`. The project key is derived from the git remote, else the git root, else the cwd, so worktrees share memory. |
| Index | A derived SQLite database (FTS5, vectors, usage stats, watermarks, journal). Deletable and rebuildable from the files. |
| Digest | A compiled, token-budgeted "always on" block per scope, derived from items by consolidation. Loaded once per session into the system prompt. |
| Recall | Memories selected for one run and appended to the transcript as a persisted custom message. |
| Memory agent | The background model that extracts, reconciles, consolidates, and proposes codification. Its policy prompt is the editable `AGENT.md`. |
| Codified artefact | A skill, agent definition, prompt template, or guard rule generated from memories, recorded in a ledger with provenance. |
| Watermark | Per session and branch, the last entry id the capture pipeline has processed. |

Memory types: `feedback`, `preference`, `project`, `reference`, `procedure`, `insight`, `failure`,
`entity`. The first four come from Claude Code's auto memory taxonomy; the others come from
ReasoningBank, Agent Workflow Memory and Hindsight (see `docs/RESEARCH.md`).

## 3. Component overview

```
                 pi process (TUI / RPC / print)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  index.ts  registers flags, settings, /memory, tools, events, UI        │
 │                                                                         │
 │  ui/            autocomplete  #"query"   /memory browser   renderers    │
 │  retrieve/      hybrid search → fusion → fast-LLM select → budget       │
 │  capture/       delta collector → salience → reflector → curator        │
 │  consolidate/   scheduler, locks, worker launcher                       │
 │  codify/        emitters (skill, agent, prompt, hook rule), ledger      │
 │  store/         paths, project key, md items, sqlite index, journal     │
 └──────────┬──────────────────────┬───────────────────────────────────────┘
            │ files                │ spawn (idle only)
            ▼                      ▼
 ~/.pi/agent/memory/        pi worker process (JSON mode, restricted tools,
   AGENT.md                 worker.ts extension, AGENT.md as policy prompt)
   index.sqlite             runs consolidation and codification passes
   global/  projects/<key>/
```

Two tiers of background intelligence:

- Tier A, in-process structured calls through `ctx.modelRegistry.streamSimple()` with the memory
  model: reflect over a transcript delta, reconcile candidates. Short, schema-constrained, no tools.
- Tier B, a worker pi process for consolidation and codification: it needs to read the memory tree,
  compare against existing skills and agents, and write multi-file artefacts. Running it as a
  separate `pi` process (as the shipped `subagent` example does) isolates it from the host
  runtime, makes it killable, and lets `/memory consolidate` stream its progress. The exact flag
  set (JSON mode, tool allowlist, loading only `worker.ts`) must be validated against `pi --help`
  during implementation; the SDK's in-process `createAgentSession()` with an in-memory
  `SessionManager` is the fallback if spawning is undesirable.

## 4. Storage

### 4.1 Layout

```
~/.pi/agent/memory/                      memory.dir (default); PI_CODING_AGENT_DIR respected
├── AGENT.md                              editable memory-agent policy (copied from preset)
├── index.sqlite                          derived index for all scopes (WAL mode)
├── ledger.jsonl                          codified artefacts: memory ids → files written
├── proposals/                            pending codification proposals (one JSON + draft files each)
├── journal/<date>.jsonl                  every operation (add/update/supersede/archive/feedback)
├── global/
│   ├── DIGEST.md                         compiled always-on block for global scope
│   ├── items/<id>.md                     active items
│   ├── archive/<id>.md                   archived and superseded items (still indexed)
│   ├── skills/<name>/SKILL.md            codified skills (contributed via resources_discover)
│   ├── prompts/<name>.md                 codified prompt templates (contributed likewise)
│   └── hooks/<name>.json                 declarative guard rules evaluated by pi-memory
└── projects/<key>/
    ├── manifest.json                     remote, roots seen, worktrees, last seen
    ├── AGENT.md                          optional project addendum to the policy prompt
    ├── DIGEST.md  items/  archive/  skills/  prompts/  hooks/
```

Optional repo-local project scope: with `memory.scope.projectLocation: "repo"` the project tree
lives at `<git root>/.pi/memory/` so a team can commit it. It is only loaded when
`ctx.isProjectTrusted()` is true, matching pi's handling of project extensions and skills.

### 4.2 Item file

```markdown
---
id: m_01JB8K3Q5Z7X9M2N4P6R8T0V1W
type: failure
scope: project:github.com/thehumanworks/pi-goal
title: Run bun test with LD_LIBRARY_PATH on NixOS for native sqlite
summary: On NixOS, bun test fails to load sqlite3 unless libstdc++ is on LD_LIBRARY_PATH.
keywords: [bun, sqlite3, nixos, libstdc++, LD_LIBRARY_PATH, native module]
triggers: ["running tests in pi-goal", "bun test fails to load a native module"]
paths: ["pi-goal/**"]
importance: 7
confidence: 0.85
status: active            # active | archived | superseded | codified
supersedes: []
links: [m_01JB7...]
codified_as: null         # path when codified
source:
  session: ~/.pi/agent/sessions/--home-nixos-pi-extensions--/2026-10-18_….jsonl
  entries: [c3d4e5f6, d4e5f6g7]
  origin: tool_output     # user_statement | user_confirmation | tool_output | consolidation
created: 2026-10-18T19:07:12Z
updated: 2026-10-18T19:07:12Z
last_used: 2026-10-23T11:41:03Z
stats: { injected: 4, used: 2, helpful: 2, harmful: 0 }
---
Set `LD_LIBRARY_PATH` to the Nix `stdenv.cc.cc.lib` path before `bun test` when the package
uses a native sqlite module. Applies when running Bun directly outside the pi wrapper. The pi
wrapper already has the library on its path, so `pi`-launched runs are unaffected.
```

Design rules: the body is the claim, the frontmatter is the evidence and bookkeeping (Hindsight's
evidence/inference split). Files are written atomically (temp file plus rename) under pi's
`withFileMutationQueue()`. Ids are ULIDs so files sort by creation time.

### 4.3 Index (SQLite via `node:sqlite`)

pi 1.2.0 runs on Node 24.21.0 and `node:sqlite` with FTS5 is available in that binary (verified on
this machine). This avoids the native `sqlite3` dependency and the Bun/jiti loader patch that
pi-goal had to carry.

Tables:

- `items(id, scope, type, status, title, summary, importance, confidence, created, updated,
  last_used, file_hash, …)` mirrors frontmatter for filtering.
- `items_fts` FTS5 over `title, summary, keywords, triggers, body` with the `porter unicode61`
  tokenizer; ranked with `bm25()` using column weights (title and triggers highest).
- `embeddings(id, model, dims, vec BLOB)`; cosine similarity is computed in JS over all candidates
  of the relevant scopes. At the expected scale (thousands of items, 384 dims) a brute-force scan
  costs milliseconds, so no vector extension is needed.
- `usage(id, session, run, injected_at, verdict)` for the feedback loop.
- `watermarks(session_id, branch_leaf, last_entry_id, updated)`.
- `journal` is append-only JSONL on disk; the table holds a pointer for undo and stats.

Re-indexing: at `session_start` and before each consolidation, compare file mtimes and hashes
against `items.file_hash`; re-parse changed files. This is what makes items editable by the user
and by agents with ordinary file tools. `/memory reindex` rebuilds from scratch.

### 4.4 Embeddings

An `Embedder` interface with three implementations, selected by `memory.embeddings.provider`:

- `local`: `@huggingface/transformers` running `Xenova/bge-small-en-v1.5` (384 dims, `q8`) on CPU.
  Optional dependency, loaded lazily; first use downloads the weights. Query prefix and CLS pooling
  per the model card.
- `api`: an HTTP embeddings endpoint (OpenAI, Gemini, Voyage) with the key resolved from pi's
  credential store. pi-ai has no embeddings API, so this is a small direct client.
- `off`: lexical only.

Default `auto`: local if the dependency loads, else `api` if a key exists, else `off`. Lexical mode
is still useful because every item carries LLM-generated keywords, triggers and a summary as extra
index keys (LongMemEval's key expansion), and the fast-LLM selector can rerank.

## 5. Capture pipeline (background learning)

### 5.1 Triggers

| Event | Why | Work |
| --- | --- | --- |
| `agent_settled` | pi will not continue automatically; the run is complete | Enqueue the transcript delta since the watermark |
| `session_before_compact` | Details are about to be summarised away | Capture from `preparation.messagesToSummarize` first; the handler returns nothing, so pi's own compaction proceeds |
| `session_shutdown` | Quit, reload, or session switch | Persist a pending-delta pointer so the next pi start can finish the work |
| `message_end` (user role) | Cheap salience signal | Regex lexicon for corrections ("no,", "don't", "always", "never", "actually", "stop", "remember"); marks the turn high salience, no LLM |
| `tool_result` with `isError` followed by success | Failure then fix pairs | Marks the span for the reflector |
| `/memory remember`, `#remember "…"`, `memory_save` tool | Explicit | Direct curator path, no reflector |
| `pi.events` `pi-memory:remember` | Other extensions (pi-goal completion evidence, the verifier) | Direct curator path |

### 5.2 Idle gating and cancellation

Capture runs only when `ctx.isIdle()`, `!ctx.hasPendingMessages()`, no modal prompt is open
(tracked via `ui_prompt_start`/`ui_prompt_end`), and the editor is empty, the same conditions the
local `loop` extension uses. Work holds an `AbortController` that is aborted when a new run starts
(`agent_start`); because the watermark only advances after the curator commits, an aborted pass is
simply retried later. Salience gating skips runs that have no user correction, no failure/fix pair,
no explicit request and fewer than a configurable number of tokens, which keeps cost near zero for
short Q&A runs.

### 5.3 Stages

```
transcript delta ─▶ serialise ─▶ reflector (LLM #1) ─▶ candidates + verdicts on injected memories
                                                        │
          nearest neighbours per candidate (FTS + vectors, top 5) ◀─┘
                                                        │
                                   curator (LLM #2) ─▶ ADD | UPDATE id | SUPERSEDE id | NOOP
                                                        │
                       deterministic apply: write file, index, journal, update digest flag
```

1. Delta collection. Walk `ctx.sessionManager.getBranch()` from the watermark to the leaf, keep
   message entries, convert with `convertToLlm()` and `serializeConversation()` (tool results
   truncated, thinking omitted), and attach markers: salience hits, failure/fix spans, the ids and
   titles of memories injected during that run, and the hashes and titles of loaded context files
   (AGENTS.md etc.) so the reflector can apply the "already documented" exclusion.
2. Reflector. One call with the memory model. Input: `AGENT.md` policy, the code-owned output
   contract, the delta. Output (JSON): candidate items in the schema of section 4.2 plus a verdict
   per injected memory (`used`, `helpful`, `harmful`, `ignored`). ACE's lesson applied: the
   reflector only extracts; it never sees or edits the store.
3. Curator. For each candidate, retrieve the top five neighbours across the candidate's scope and
   global scope, then one call per batch decides the operation. Deterministic code applies it:
   `UPDATE` rewrites the body and bumps `updated` and `confidence`; `SUPERSEDE` writes a new item,
   moves the old file to `archive/` with `status: superseded` and a back link; `NOOP` records a
   reinforcement (bumps `stats` and decay strength on the existing item).
4. Post-write. Index the file, compute its embedding, append to the journal, and set a
   `digest_dirty` flag for the scope if the item's importance crosses the digest threshold.

Both calls use the explicitly configured memory model (`memory.capture.model`; capture stays off
when it is unset, and the session model is never used implicitly) with `cacheRetention` left on and a dedicated `sessionId`
(`pi-memory-worker`), because `AGENT.md` plus the contract is a stable prefix across captures and
benefits from the provider cache. These calls never share the main session's cache key.

### 5.4 Secret and injection hygiene

Before serialisation, the delta is passed through a secret scanner (common API key and token
shapes, PEM blocks, `.env` assignments, bearer headers); matches are replaced with `[redacted]`.
The reflector is told that tool output is data, not instruction, and items whose `source.origin`
is `tool_output` get lower default confidence and are flagged in the injected block. Codification
proposals derived only from tool output always require review.

## 6. Consolidation and compression

Runs in the worker (Tier B) when idle and any of these holds: the number of captures since the
last pass exceeds `memory.consolidation.everyCaptures` (default 20), the last pass is older than
`memory.consolidation.maxAge` (default 24h), a scope has `digest_dirty`, or the user runs
`/memory consolidate`. A lock file with pid and heartbeat prevents two pi processes from
consolidating at once.

Passes, each journaled and each expressed as itemised operations rather than whole-store rewrites:

1. Dedupe. Cluster by embedding cosine above 0.92 or by FTS overlap; merge into the clearest item,
   archive the rest with links. Applies A-MEM's neighbour update: refresh keywords and links of the
   survivors.
2. Generalise. When three or more related items express one lesson, write an `insight` or `entity`
   item that links the children. Children stay (archived only if they add nothing), which is the
   ACE anti-collapse rule: details live in items, abstractions on top.
3. Decay and archive. Retention `R = exp(-t / S)`, `t` in days since `last_used`, `S` starting at
   `1 + importance / 2`, incremented by each `helpful` verdict and decremented by each `harmful`
   one. Items below `memory.consolidation.decay.archiveBelow` (default 0.15) move to `archive/`.
   Nothing is hard-deleted automatically. `feedback` items with importance 9 or more never decay.
4. Compress. Rewrite verbose items into the format in the preset (title, summary, 120-word body),
   compressing wording but never conditions, commands or caveats. Evidence stays in frontmatter.
5. Promote. A lesson seen in two or more projects is proposed for `global` scope.
6. Digest. Recompile `DIGEST.md` per scope under `memory.digest.budgetTokens` (default 1200 global,
   1200 project): standing rules, user corrections, high-importance project facts, in a fixed,
   deterministic order so the rendered text only changes when its content does.
7. Codify. Produce proposals (section 7).

## 7. Codification

Targets and where they go:

| Knowledge shape | Artefact | Location | Discovery |
| --- | --- | --- | --- |
| Recurring multi-step `procedure`, used or confirmed in two or more sessions | Skill with optional `scripts/` | `<scope>/skills/<name>/SKILL.md` | `resources_discover` returns `skillPaths` (startup and `/reload`) |
| Repeated request shape | Prompt template | `<scope>/prompts/<name>.md` | `resources_discover` returns `promptPaths` |
| "Always/never" rule checkable by tool name, path glob or command pattern | Guard rule | `<scope>/hooks/<name>.json` | pi-memory's own `tool_call` handler evaluates rules: `block`, `confirm` (via `ctx.ui.confirm`), or `warn` |
| Recurring role with fixed constraints | Specialised agent | `~/.pi/agent/agents/<name>.md` or `<project>/.pi/agents/` | The installed specialized-agents extension discovers it; the ledger records it for cleanup |
| Project fact that every collaborator and tool should see | Suggested edit to `AGENTS.md` | Repository file | Never applied automatically; shown as a diff in `/memory review` |

Policy: the worker writes drafts into `proposals/<id>/` and the extension notifies the user. The
user accepts, edits (opens `ctx.ui.editor()`), or rejects in `/memory review`; `memory.codify.autoApply`
can list artefact kinds that may be applied without review (default empty, following Cursor's
decision to add approval for background-generated memories). Applied artefacts are recorded in
`ledger.jsonl` with the source memory ids; the source items get `status: codified` and
`codified_as`, and they stop being injected because the artefact now carries the knowledge.

Keeping skills and prompts inside the memory tree means a scoped clear removes them cleanly and
they do not pollute the user's own `skills/` directory. Agents must live where their discoverer
looks, so they are tracked by the ledger instead.

## 8. Retrieval

### 8.1 Default mode: injection before the run

Handler: `before_agent_start` with `messageType === "user"` (runs started by custom messages are
skipped). Steps, with a total latency budget `memory.retrieval.timeoutMs` (default 2500 ms) after
which the heuristic result is used as is:

1. Query assembly (no LLM): the prompt text, the previous two user messages, file paths that
   appear in recent tool calls on the branch, the project key, and the git branch name.
2. Candidate generation (target under 50 ms): BM25 over the FTS index and cosine over embeddings
   if available, both restricted to `global` plus the current project scope and `status: active`,
   each returning 40; reciprocal rank fusion; then a prior from Generative Agents added as a third
   term: normalised recency of `last_used`, importance, and a locality boost when `paths` match
   files in the query. Items already injected in this session are dropped. Top 24 survive.
3. Selection with the fast LLM (`memory.retrieval.model`, user specified; `off` disables). One call
   with the prompt and a compact candidate list (id, type, title, summary) asks for the ids worth
   injecting under `memory.retrieval.maxItems` (default 8) and `memory.retrieval.budgetTokens`
   (default 1200). `cacheRetention: "none"`, fresh `sessionId`. Alternative when the user has a
   classifier model configured: one `classify()` call with a boolean question per candidate, which
   is cheaper and avoids free-text parsing.
4. Injection: return `{ message: { customType: "pi-memory/recall", content, display: true,
   details: { ids, query } } }`. pi persists this as a custom message at the start of the run, so
   it is part of the transcript and the request grows append-only (section 9). Each item renders
   as `[id] title — body (type, scope, confidence, origin)`. A `registerMessageRenderer` draws it
   compactly in the TUI.

The digest is injected separately: at `session_start` the extension reads `DIGEST.md` for both
scopes once and sets `systemPromptOptions.sections.memory` in every `before_agent_start` of that
session to the same string. The section also carries the standing guidance ("memories can be
stale; verify against the code; correct with memory_feedback"). Because the string is fixed for the
session, the system prompt never changes mid-session on account of memory.

After `session_compact`, the injected-id set for the session is cleared so still-relevant
memories can be re-injected on the next run; nothing is re-sent proactively.

### 8.2 Agent-driven mode: tools

| Tool | Purpose | Annotations |
| --- | --- | --- |
| `memory_search(query, scope?, types?, limit?, include_archived?)` | Hybrid search, returns id, title, summary, score, scope | readOnly |
| `memory_get(ids)` | Full items | readOnly |
| `memory_save(type, title, content, scope?, triggers?, importance?)` | Direct curator path (reconciled, not blindly appended) | idempotent |
| `memory_feedback(id, verdict, note?)` | `helpful`, `harmful`, `outdated`; `outdated` with a note creates a supersede candidate | idempotent |
| `memory_forget(id, reason)` | Soft archive; hard delete is user-only | destructive hint |
| `memory_prompt(action, text?)` | `get`, `append`, `replace` for `AGENT.md`; validated against the code-owned contract | |

All tools return `structuredContent` with an `outputSchema` so codemode scripts receive data.
Exposure depends on `memory.mode`, chosen once at `session_start` and never flipped mid-session:
`inject` registers the tools with `exposure: "codemode"` (reachable through codemode and
`tool_search`, not declared in the main tool list), `agent` and `both` register them `direct`.
`memory_search` and `memory_get` are grouped in a `memory` namespace with instructions telling the
agent when to search (unfamiliar area, before repeating a failed approach) and when to save (after a
user correction).

### 8.3 Editor integration: `#"query"` autocomplete

`ctx.ui.addAutocompleteProvider()` stacks a provider over pi's built-in one. `/` is commands and
`@` is files, so `#` is free; the trigger is specifically `#"` followed by text up to the cursor,
which cannot collide with Markdown headings.

- Suggestions: debounced 120 ms, hybrid search with the `options.signal` passed through so typing
  cancels stale queries; items are `{ value: "#mem:<id>", label: title, description: summary }`,
  at most 10.
- Accepting a suggestion replaces the `#"…"` token with `#mem:<id>`.
- Submitting without accepting leaves `#"query"` in the text. The `input` handler then runs the
  semantic search for each quoted query, replaces the token with `[memory: "query"]` in the user's
  text, expands `#mem:<id>` tokens, and appends a `<memory_recall>` block with the matched items
  (top 5 per query). It returns `{ action: "transform", text }`, so the expansion is part of the
  user message itself. In `pi -p` and RPC modes the same transform applies; only the suggestion
  popup is TUI-only.
- `/memory` registers `getArgumentCompletions` for its subcommands and for item ids.
- `/memory browse` opens a `ctx.ui.custom()` overlay with a search field, a `SelectList` of
  results (reusing `fuzzyFilter`), a preview pane, and keys to archive, pin to digest, or insert
  `#mem:<id>` into the editor.

## 9. Prompt-cache invariants

The provider cache is a byte-exact prefix match over tools, system prompt and messages in that
order. pi-goal's `docs/CACHE.md` records how ephemeral `context` injections broke that prefix in
pi. pi-memory therefore commits to:

1. No `context` or `context_with_system` handlers. Recall is a persisted custom message returned
   from `before_agent_start`, which pi appends at the start of the run; previous recall messages
   are never removed or moved.
2. The system prompt section `memory` is computed once per session from the digest files. Digest
   changes made by consolidation apply from the next session. Tool registration and exposure are
   decided once per session; `setActiveTools()` is never called mid-session by pi-memory.
3. Tool descriptions and the recall block format are static strings with deterministic item order
   (by id), so identical content renders identically.
4. Editor expansion (`#"…"`) happens in the `input` transform and lands inside the user message.
5. Background model calls use their own `sessionId`; retrieval selection uses
   `cacheRetention: "none"`; capture and consolidation keep retention on because `AGENT.md` plus
   the contract is a stable prefix for the worker and should be cached for the worker's benefit.
6. Nothing is sent to the main session while it is busy; `pi.sendMessage` is not used for recall.
7. The injected-id set prevents re-sending the same memory in one session, which also keeps the
   transcript short.
8. Tests replicate pi-goal's prefix-invariance harness: for scripted sessions, every request's
   provider-visible message array must start with the previous request's array, with pi-memory
   enabled in both modes and across a compaction.

What this does not promise: a cache hit when the user switches model, when pi compacts, or when
another extension rewrites context.

## 10. Configuration, control, and clearing

Settings (`settings.json`, global with project overrides; unknown top-level keys are tolerated by
pi, as the local advisor extension relies on):

```jsonc
"memory": {
  "enabled": true,                        // master switch; a project can set false
  "mode": "inject",                       // inject | agent | both
  "dir": "~/.pi/agent/memory",
  "capture":  { "enabled": true, "model": "openai/gpt-6-astra", "minSalience": "any", "onCompact": true },
  "retrieval":{ "model": "claude-bridge/claude-haiku-5-5", "maxItems": 8, "budgetTokens": 1200, "timeoutMs": 2500 },
  "digest":   { "budgetTokens": 1200 },
  "embeddings": { "provider": "auto", "model": "Xenova/bge-small-en-v1.5" },
  "consolidation": { "model": "openai/gpt-6.1-sol", "everyCaptures": 20, "maxAge": "24h",
                     "decay": { "archiveBelow": 0.15 } },
  "codify":   { "propose": true, "autoApply": [] },
  "scope":    { "projectKey": "git-remote", "projectLocation": "home" }
}
```

Overrides and kill switches, in precedence order: `--no-memory` flag, `PI_MEMORY_DISABLED=1`,
project `memory.enabled: false`, global setting. `--memory-model` and `--memory-mode` override for
one invocation. Model values use pi's `provider/modelId` form and are validated at `session_start`
with `ctx.modelRegistry.find()` and `hasConfiguredAuth()`, as the advisor extension does; a bad
value disables that stage with a notification rather than disabling memory entirely.

`/memory` subcommands:

| Command | Effect |
| --- | --- |
| `/memory` | Status: scope key, item counts, mode, models, last capture and consolidation, pending proposals |
| `/memory on` / `off` / `mode <inject\|agent\|both>` | Runtime switch, persisted to user settings |
| `/memory search <q>` | Results in a notification or the browser |
| `/memory browse` | Overlay browser |
| `/memory remember <text>` | Explicit capture through the curator |
| `/memory forget <id>` | Archive |
| `/memory consolidate` | Run the worker now and stream its progress |
| `/memory review` | Accept, edit, or reject proposals |
| `/memory prompt [reset \| diff]` | Open `AGENT.md` in the editor; reset to preset; diff against preset |
| `/memory stats` | Usage, helpful/harmful rates, store size |
| `/memory backfill [--since]` | Run capture over historical session files for this project |
| `/memory reindex` / `export` | Rebuild the index; dump items as one Markdown file |
| `/memory clear project \| global \| all [--archive-only] [--including-codified]` | See below |

Clearing: `project` removes `projects/<key>/` and its rows, `global` removes `global/`, `all`
removes the whole memory dir except `AGENT.md` (use `--prompt` to reset that too). Codified skills,
prompts and hook rules live inside the scope and go with it; agents written elsewhere are removed
only with `--including-codified`, using the ledger. The command shows what will be removed and asks
for confirmation (`ctx.ui.confirm`), prefers the `trash` CLI when available (as pi's own session
deletion does), and in non-interactive modes requires `--yes`. A clear while the worker runs waits
for the lock.

## 11. The memory agent prompt

- Policy lives in `~/.pi/agent/memory/AGENT.md`, copied from `prompts/memory-agent.preset.md` on
  first run. A project may add `projects/<key>/AGENT.md`, appended after the global policy.
- A code-owned output contract (JSON schema for candidates, verdicts, operations and proposals,
  plus the "never delete, never store secrets" rails) is appended by the extension and cannot be
  edited away; it is versioned with the extension.
- Editable by the user through `/memory prompt`, and by any pi agent either with ordinary file
  tools or with the `memory_prompt` tool, which validates that the result still parses and warns
  when a preset section was removed.
- When the shipped preset version is newer than the header in the user's copy, `/memory` shows a
  notice and `/memory prompt diff` shows the changes; nothing is overwritten.
- The preset is strong by construction: it defines what to store and what not to store (task logs,
  derivable facts, secrets), the item format, reconciliation rules, verdicts on injected memories,
  earned-codification criteria, and consolidation behaviour. See the file.

## 12. Trust, privacy, and failure modes

- Secrets are scanned out before any model call; `.env`-style content is never stored.
- Repo-local project memory, hooks, skills and prompts load only in trusted projects.
- Tool output is treated as data; items from tool output carry lower confidence and visible
  provenance; codification from them always requires review.
- Wrong memory: every injected item shows confidence and origin, the system section tells the
  agent to verify against the code, `memory_feedback` and natural-language corrections feed
  supersession, and `/memory browse` makes deletion one keystroke.
- Store bloat: salience gating, reconciliation, decay, budgets on digest and recall.
- Context collapse: items are the source of truth; digests and insights are derived and
  rebuildable; no whole-store rewrites.
- Latency: retrieval has a hard timeout with heuristic fallback; capture never runs during a run.
- Concurrency: SQLite WAL with `busy_timeout`, atomic file writes, per-session watermarks, a
  consolidation lock with heartbeat.
- Non-TUI modes: capture, retrieval, tools and the `input` transform work in RPC and print modes;
  only the popup and overlay are guarded by `ctx.mode === "tui"`.

## 13. Module layout

```
pi-memory/
├── index.ts                 registration only; wires modules to the ExtensionAPI
├── worker.ts                loaded only by the worker process: memory-dir scoped tools
├── store/                   paths.ts projectKey.ts items.ts index.ts journal.ts secrets.ts
├── capture/                 delta.ts salience.ts reflector.ts curator.ts scheduler.ts
├── retrieve/                query.ts search.ts fusion.ts selector.ts inject.ts
├── consolidate/             runner.ts dedupe.ts generalise.ts decay.ts digest.ts lock.ts
├── codify/                  proposals.ts emitters/{skill,agent,prompt,hook}.ts ledger.ts rules.ts
├── ui/                      autocomplete.ts browser.ts renderers.ts commands.ts
├── prompts/                 memory-agent.preset.md  contract.ts  select.ts
├── docs/                    RESEARCH.md  CACHE.md (invariants and test plan)  PROMPT.md
├── tests/                   fake-pi harness (pi-goal style), prefix-invariance, retrieval eval
└── package.json             peerDependencies on pi packages; optional @huggingface/transformers
```

Only `index.ts`, `worker.ts`, `retrieve/`, `store/` and `ui/autocomplete.ts` are on the
interactive path; everything else runs when idle.

## 14. Delivery plan

1. Foundation. Store, index, project key, settings and flags, `/memory` basics, digest section,
   `#"…"` autocomplete and `input` expansion, the six tools, clear commands. No background model
   calls yet; memory is user-curated. Tests: file round trips, FTS ranking, prefix invariance.
2. Capture. Reflector and curator, idle scheduler, salience gating, verdict feedback, injection
   with the fast-LLM selector, `memory_feedback`. Tests: scripted sessions through the fake pi
   harness with a stub model; secret redaction; abort and watermark retry.
3. Consolidation. Worker process, dedupe, generalise, decay, compress, digest compile, stats,
   `backfill` over the 66 existing session directories to seed memory and to evaluate retrieval
   precision against held-out sessions.
4. Codification. Proposals and review flow, skill and prompt emitters with `resources_discover`,
   guard rules in `tool_call`, agent emitter with ledger, `AGENTS.md` suggestions, browser overlay,
   repo-local project scope.

## 15. Decisions taken in this proposal

- Files are canonical, SQLite is derived. Editability and clean clearing outweigh the cost of
  re-indexing.
- Capture is a background sidecar; tools are secondary. Main models produce task logs when asked
  to self-save (Cursor's finding), and background capture never costs the user latency.
- Reconcile with supersession, never delete automatically. Provenance and reversibility matter
  more than a minimal store.
- Proposals, not auto-apply, for codification and instruction edits. Review is one command.
- Recall is appended as a persisted custom message; the digest is fixed per session. This is the
  only pattern that is known to keep pi's transcript prefix stable.
- Default retrieval model and embedder are user choices; the design degrades to lexical search and
  heuristic ranking when neither is configured, and it stays useful.
