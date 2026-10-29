# Layout review: persistent, long-running agents

## Recommendation

**Yes, keep a memory directory, but treat it as curated knowledge, not chat history.**
Keep writable knowledge under the state root (`.bot/memory/` by default), distinct
from authored capabilities and the execution workspace. A top-level `memory/`
would confuse source/checkpoint ownership with live state. Preserve this separation:

```text
researcher/
  BOT.md                    identity, scope, research + maintenance policy
  tools/                    bot-specific additions to global Pi/MCP defaults
  extensions/               optional bot bundles or native Pi factories
  lib/                      optional implementation helpers (not discovered tools)
  skills/                   optional reusable procedures
  .bot/                     writable persistent state, not committed
    MEMORY.md               small active index, not an encyclopaedia
    memory/<topic>.md       reusable, sourced knowledge with review dates
    memory/reports/         report-specific evidence and deliverables
    tasks/<task>.md         resumable work, status + next action
    journal/<date>.md       brief outcomes/maintenance decisions, not transcripts
    runtime.sqlite         SDK-owned conversations and run records
    revisions/             SDK-owned capability checkpoints, not memory backups
```

These examples use global Pi extensions/MCP by default and add one small local tool.
They do not create empty skills/extensions/assets directories just for symmetry.
A daemon is a long-lived process, not necessarily one endless conversation: use
bounded task conversations with explicit persistent state, and resume when useful.

## What the implementation actually does today

Inspected `src/memory.ts`, `src/project.ts`, runtime ownership and the documented
SDK interfaces:

- `MEMORY.md` is included as an excerpt: at most **200 lines / 25,000 bytes**.
  More content is truncated, not summarized automatically.
- Up to **20 open task summaries** are injected. Closed statuses are excluded;
  tasks are sorted by filesystem modification date, not a priority/deadline queue.
- Linked notes are not all injected. The bot must read relevant files explicitly.
- Resuming a persisted conversation gives that conversation's context. A new session
  is not an automatic retrieval of recent chats from every other session. `bot_history`
  provides bounded list/search/read access across the bot's native and isolated conversations,
  including after restart, without importing all previous chats into the prompt.
- There is no built-in cross-session semantic memory search, fact extraction,
  deduplication, TTL enforcement, automatic archival, journal rotation or memory GC.
- The maintenance tools can read/write/edit memory. The examples' cleanup procedure
  is an agent instruction, not an implemented automatic cleanup service.
- Tasks do not wake the agent. There are no SDK schedules/cron/background heartbeats.
  A serving process can remain idle forever without doing memory maintenance.

Thus, chat history is **episodic evidence**, task notes are **working state**, and
curated topic notes are **reusable knowledge**. They complement rather than replace
one another. `bot_history` retrieval can supply candidates for curation, but
must not silently treat something the model once said as an established fact.

## Keep memory clean and current

1. **Admission:** save only durable preferences, useful sourced facts, decisions,
   reusable procedures and unfinished work. Do not copy every answer or whole page.
2. **Identity:** one canonical topic note per topic; update it rather than appending
   near duplicates. Separate reports from facts intended for reuse.
3. **Provenance:** every factual note carries source URLs, observation/check dates,
   confidence, review-after, and supersedes/conflicts relationships. Distinguish
   user assertions, third-party evidence and model hypotheses.
4. **Retrieval:** load the small index, then a few relevant notes. Stale notes may
   suggest sources, but must not answer a current-pricing/current-release question
   without verification. Expiry means “recheck before reliance,” not “delete.”
5. **Bounded consolidation:** after a task, update touched notes/index and close
   the task. Weekly on the next request, inspect at most ten indexed notes. Avoid
   spending more on cleanup than on useful research.
6. **Archival and retention:** remove obsolete notes from the active index and mark
   them archived, preserving needed provenance. Set an operator retention policy
   before deleting personal preferences, old reports, journals or transcripts.
   The examples intentionally do not implement physical deletion or automatic GC.
7. **Enforcement:** prompt-level budgets and cleanup are best effort. A production
   installation should add a deterministic audit tool for broken links, duplicate
   topic IDs, missing provenance, overdue reviews, oversized indexes and excessive
   open tasks. Test the audit separately from model behavior.

A report stays an “as of” report even if a later note replaces one of its claims.
Never rewrite history to make an earlier report appear more current than it was.
Retrieved web instructions must not be allowed to rewrite the bot's memory policy.

## Gaps to address before calling this production autonomous operation

- **Wakeups:** an external scheduler/supervisor should submit explicit maintenance
  jobs to the existing daemon, using stable request IDs. Do not open a competing
  owner or leave a shell editing the state concurrently. No scheduler is added here.
- **Memory search:** start with index + lexical retrieval; add a derived search
  index only if the corpus merits it. Keep Markdown as the source of truth and make
  the index rebuildable. Use the supported `bot_history` tool for cross-chat retrieval;
  preserve its session/entry provenance and bot-home boundary, not direct SQL by the agent.
- **Resource growth:** monitor database, journal, reports, revisions and task counts.
  There is no bounded total storage policy merely because the injected index is
  bounded. Revision retention must preserve revisions needed for recovery.
- **Task correctness:** more than 20 open tasks can hide work from injected context.
  Add explicit backlog listing/prioritization for a busy agent. Record checkpoints
  before lengthy work and at safe boundaries, not just at the final answer. Native
  Pi requests interrupted by shutdown/crash fail closed rather than replaying;
  the next request can use task notes to decide what is safe to resume.
- **Transactions:** individual maintenance writes are atomic, but a topic + index +
  task update is not a multi-file transaction. Use idempotent, repairable updates
  and run link audits after interruptions. Avoid concurrent out-of-band editors.
- **Backups:** source snapshots are not memory/database backups. Back up source,
  live memory and SQLite consistently (stop the owner or use a proper SQLite backup
  procedure); preserve canonical paths when restoring. Credentials remain external.
- **Security:** no tenant isolation or sandbox. Separate OS accounts/containers and
  network controls are needed for untrusted users. Do not expose tool-serving APIs
  without considering authentication and the serving user's provider allowance.

The current layout is a good foundation for a durable, task-driven researcher.
The missing piece is operational policy and enforcement—not renaming transcripts
“memory,” and not keeping one conversation alive indefinitely.
