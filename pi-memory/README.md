# pi-memory

Local, project-scoped memory for Pi. It learns durable corrections and working procedures after a run, reconciles them with earlier evidence, and retrieves relevant context in future sessions. Markdown files are canonical; SQLite is a rebuildable search index. Supports the Node and bundled Bun builds of Pi 1.4.0.

## Install

From this checkout:

```sh
pi install ./pi-memory
```

After publication:

```sh
pi install npm:@nothumanwork/pi-memory
```

Installation enables lexical recall by default. Automatic capture and idle dreaming make separate model calls, so each runs only once its model is explicitly configured (`memory.capture.model`, `memory.dream.model`); the session model is never used implicitly for background work. No embedding service, additional credentials, or model download is required.

For an isolated trial without installing:

```sh
PI_MEMORY_CAPTURE=0 pi -e ./pi-memory/index.ts --memory-dir /tmp/pi-memory-trial
```

## Use

```text
/memory remember Run pnpm smoke:staging before a staging deployment.
/memory remember --until 2026-11-01T12:00:00Z Use one staging worker during the incident.
/memory search staging deployment
/memory browse
/memory stats
/memory forget <id>
/memory consolidate
/memory dream --force
/memory prompt
```

`#"staging deployment"` searches memory inside a prompt. Tab completes a memory reference in the TUI; `#mem:<id>` inserts a specific item. Both forms also work in print and RPC input. `#remember "a durable fact"` explicitly saves a fact.

Automatic capture uses the editable `AGENT.md` policy plus a code-owned validation contract. It skips small, ordinary turns, redacts common credential shapes, ignores credential-file reads, requires source entry IDs, and rejects unsupported candidates with diagnostics. Reconciliation is validated before committing. Corrections supersede old items and retain their evidence in the archive. A pending capture can resume after interruption. Memory is historical evidence; current instructions and verified files take precedence.

An invalid edit proposal can receive one corrective curator call per capture pass. Failed output is diagnosed and skipped instead of retried indefinitely; transport failures remain retryable. Unchanged facts in a bundled record are preserved when a correction edits one part.

## Settings

Add a `memory` object to Pi's `settings.json`:

```json
{
  "memory": {
    "enabled": true,
    "mode": "inject",
    "capture": { "enabled": true, "model": "openai/gpt-6.1-sol", "onCompact": true },
    "retrieval": { "maxItems": 8, "budgetTokens": 1200, "sessionBudgetTokens": 0, "timeoutMs": 2500 },
    "digest": { "budgetTokens": 1200, "scope": "decisions" },
    "consolidation": { "everyCaptures": 20 },
    "dream": { "enabled": true, "maxSourceItems": 12, "softActiveBytes": 1000000, "idleDelayMs": 30000, "backoffMs": 300000 }
  }
}
```

- `inject`: automatic recall; tools are available through codemode/tool discovery.
- `agent`: six memory tools are directly available; the agent decides when to recall.
- `both`: automatic recall and directly available tools.

The tools are `memory_search`, `memory_get`, `memory_save`, `memory_feedback`, `memory_forget`, and `memory_prompt`. All return structured content. Search/get are scope restricted. Forget is a soft archive; model tools cannot permanently clear stores.

`memory_save` requires an `evidenceQuote` copied from a user message or tool result on the current branch. The extension resolves its actual origin; tool observations cannot supersede explicit user evidence. Automatic recall excludes claims with confidence below 0.5; explicit search still makes them available for inspection.

`capture.model` and `dream.model` are required for capture and dreaming respectively; without an explicit `provider/modelId` that job stays off and `/memory capture`, `/memory backfill`, and `/memory dream` report why. `dream.model` falls back to `consolidation.model`. `/memory model` prints the three current selectors; `/memory model capture|dream|retrieval <provider/modelId|off>` validates the selector against the configured model registry, saves it to user settings, and applies after `/reload`. Set `retrieval.model` to a configured `provider/modelId` for optional model selection; invalid/unavailable selectors and timeouts fall back to lexical ranking. No retrieval model is used by default. The budget is enforced with a conservative UTF-8 byte upper bound, so actual tokenizer counts are lower; a memory is omitted whole instead of truncating its conditions.

Overrides: `--no-memory`, `PI_MEMORY_DISABLED=1`, `--memory-dir`, `PI_MEMORY_DIR`, `--memory-mode`, `PI_MEMORY_MODE`, `--memory-model`, and `PI_MEMORY_MODEL`. `PI_MEMORY_CAPTURE=0` disables automatic capture; `PI_MEMORY_DREAM=0` disables automatic dreaming. A configured project `memory.enabled: false` disables memory. `/memory off` disables it immediately and saves the preference; `/memory on`, `/memory mode inject|agent|both`, and `/memory model ...` take effect after `/reload`, preserving stable tool declarations.

`digest.scope` selects what the always-on system-prompt block holds. `decisions` (default) includes standing feedback and preference rules plus durable user-stated project decisions with importance 8 or higher and confidence 0.9 or higher, selected live from canonical sources at session start, so the block exists before the first consolidation. `rules` reads only the digest compiled at consolidation, which holds standing feedback and preference rules. The default was chosen on measured fresh-session repair results in [the coding hillclimb](docs/HILLCLIMB-CODING.md). It is a fixed per-session reading budget in the spirit of OptMem's `wake`, bounded by `digest.budgetTokens`, and it is byte-stable for the whole session. Items in the block are excluded from per-turn recall, so recall spends its budget on other evidence.

`retrieval.sessionBudgetTokens` is a cumulative ceiling on recall tokens injected into one session branch (0 disables it). Once reached, no new evidence is recalled; invalidation notices still appear because they are correctness, not retrieval. The spent amount is restored from persisted recall messages after a restart and resets at compaction. Environment overrides are `PI_MEMORY_DIGEST_SCOPE` and `PI_MEMORY_SESSION_BUDGET`.

Reproducible evaluation can also set `PI_MEMORY_TOKEN_BUDGET=1200`, `PI_MEMORY_DIGEST_BUDGET=0`, `PI_MEMORY_RETRIEVAL_MODEL=off`, and `PI_MEMORY_STRATEGY=baseline|improved`. The shipped default is `improved`. `PI_MEMORY_TRACE=/absolute/file.jsonl` records recall, capture and dream diagnostics; choose a private path because traces contain memory context.

## Storage and maintenance

Default location: `$PI_CODING_AGENT_DIR/memory`, or `~/.pi/agent/memory`. Project keys use the normalized origin remote, then Git's common directory, then the working directory. Sibling worktrees share memory. Global items are visible across projects; project items never cross project boundaries.

Each item is a Markdown file with JSON-compatible YAML frontmatter, including source session/entry IDs, confidence, status and usage. Edit the body or valid metadata with ordinary file tools, then run `/memory reindex`. Malformed files are reported and excluded. Writes are atomic and serialized across processes. Interrupted supersession has a recoverable intent record. No automatic operation hard-deletes memories.

Consolidation deduplicates, archives expired items and invalid derived parents, and compiles bounded standing digests from strong user preferences/corrections. Durable facts are not deleted for age alone. Temporary facts require a source-grounded expiration and cannot supersede durable defaults. Recall excludes expired evidence immediately; later turns receive append-only invalidation notices for previously recalled facts that cease to apply. Digests stay fixed during a session; recall is a persisted custom message. There are no `context` rewrites or mid-session tool toggles.

Short-term recall includes the host retrieval time so the model can apply a current override before its expiry. The [real-clock action test](docs/RETENTION-EVALUATION.md) verifies a temporary configuration followed by restoration of its durable default in fresh sessions.

Dreaming groups related project evidence into smaller, lossless parents while retaining the original sources. Changed or expired sources invalidate derived parents. Model-written generalizations remain inspectable, unreviewed hypotheses outside automatic recall. TUI/RPC dreaming waits for idle, cancels on new work, and records a backoff before inference. Print sessions require an explicit `/memory dream`. The 1 MB threshold triggers maintenance; it does not impose a destructive storage cap. See [dreaming and retention](docs/DREAMING.md) and [live idle scheduling](docs/BACKGROUND-EVALUATION.md).

```text
/memory capture
/memory backfill --since 2026-10-01
/memory reindex
/memory export
/memory clear project
/memory clear global
/memory clear all
```

Backfill is explicit and processes sessions for the current working directory. It uses the capture model and existing watermarks. Clear asks for confirmation, or requires `--yes` in print/JSON mode. `--archive-only` keeps historical evidence. Already-persisted recall messages remain in the current conversation; begin a new session after clearing to discard that historical context.

Clearing cancels matching pending capture and checkpoints the current branch to prevent discarded facts returning at shutdown. `--including-codified` also removes unchanged external agent files or the exact inserted instruction block using the provenance ledger. User edits are preserved.

## Codification

Repeated, user-evidenced procedures can become reviewable skill proposals. Explicit proposals also support skills, prompt templates, agents, declarative hooks and instruction additions:

```text
/memory propose skill staging-check <memory-id>
/memory propose hook protect-prod <memory-id> --rule {"tool":"bash","pattern":"deploy --prod","action":"confirm","message":"Confirm production deployment"}
/memory review
```

Drafts include provenance. Nothing is applied without review. Reviewed writes refuse short-lived or changed evidence, symlink destinations and collisions. Skills/prompts are discovered on the next reload. Hooks match an exact tool name and optional literal argument substring; they are not shell parsers. Agent definitions require a compatible agent extension to use them. Instruction proposals append an identifiable block to `AGENTS.md` only after review.

Hook execution and resource discovery revalidate the complete source fingerprint. Already-written instruction blocks and agent definitions are reviewed files; later memory edits do not silently rewrite them. Review those destinations after a policy change, or use scoped clear with `--including-codified` to remove unchanged generated artifacts.

`/memory prompt` edits the background policy, `prompt reset` restores the shipped preset, and `prompt diff` displays both versions when they differ. Code-owned scope, provenance and output validation cannot be removed by editing the policy.

## Evaluation and development

Start with [measured results and decisions](docs/RESULTS.md), including the harder action tasks, caching costs, real expiry, dreaming, and memory-size limits.

[Final integration and verification](docs/FINAL-HARDENING.md) records the capture follow-up fixes, exact source boundary, live checks and package checks.

See [EVALUATION.md](docs/EVALUATION.md) for the frozen benchmark, baseline, iterations, held-out results, model/runtime details and limitations. [Research decisions](docs/IMPLEMENTATION-NOTES.md), [prompt caching](docs/CACHE-EVALUATION.md), [dreaming](docs/DREAMING.md), and [storage growth](docs/STORAGE-EVALUATION.md) have separate evidence. Synthetic fixtures are isolated from personal memory and sessions. The harness saves raw Pi events, actual recall IDs, request usage, source hashes and executable answer checks.

```sh
npm run check --workspace @nothumanwork/pi-memory
npm test --workspace @nothumanwork/pi-memory
npm run eval --workspace @nothumanwork/pi-memory -- --help
node --import tsx pi-memory/test/cache-live.mjs
```

[ARCHITECTURE.md](ARCHITECTURE.md) retains the original broader proposal. This implementation uses file-backed evidence, lexical retrieval, structured capture, idle compression and reviewed codification. Local/API embeddings, repo-local team stores, a separate worker process and automatic cross-project promotion are not implemented. Semantic generalization is experimental and never automatically promoted. Unsupported repo-local configuration fails explicitly. The optional selector is available for experiments but is not required for the default configuration.
