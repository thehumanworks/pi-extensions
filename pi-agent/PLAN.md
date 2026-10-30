# pi-agent implementation plan

## Research
- Pi 1.4.0 SDK, extension lifecycle, native sessions, resource loaders, MCP/codemode examples.
- Existing pi-bot delegates to a separate runtime; this package instead uses createAgentSession directly.
- Claude: https://code.claude.com/docs/en/sub-agents
- Cursor: https://cursor.com/docs/context/subagents

## Design
- Markdown/YAML definitions; preserve foreign fields, normalize common tools/model aliases, report unsupported behavior.
- Registry under Pi's agent directory; stable agent homes and native persistent session history.
- Activation routes input to the same SDK runner used by delegation and loops. It does not replace the outer Pi session.
- Approve exact revisions of existing definitions; all edits staged, including external edits. No model deletion/approval tool.
- Autonomous tools, inherited resources, no OS sandbox. Approved snapshots prevent accidental live prompt replacement, not malicious same-user shell access.
- Durable schedules, per-agent session locks, claim-before-dispatch, no replay after uncertain failures. Poll while Pi is alive; no daemon installation.

## Work — complete
1. Definition parsing and compatibility.
2. Atomic storage, proposals and human administration.
3. SDK runner and management/delegation tools.
4. Persisted scheduler.
5. Flag, slash commands and conversation adapter.
6. Offline integration tests, workspace/package validation, review and fixes.

## Review iterations
- Independent review caught scheduler-wide head-of-line blocking, dropped same-agent loop occurrences, a discriminated-union type error, and stale-answer reporting after handled input. Fixed and covered by regression tests.
- Follow-up review identified native Escape/RPC abort as an outer-session operation, not cancellation of an input-hook-owned child. The supported /agent stop contract is explicit in help, activation output and README. SIGINT/SIGTERM bridging added and tested in the real CLI.
- Added exact proposal integrity checks, registry write/edit guards, lifecycle cleanup and offline MCP tests.
- Collaborative-creation review caught a delegated-management bypass and an in-memory-only evaluation admission guard. All descendant management tools now retain the creation guard without inheriting authoring capability; a filesystem lease covers eval approval/execution/evidence and excludes competing accept/reject/eval operations. Regression tests added; follow-up review found no remaining high-confidence blocker.

## Validation
- Package typecheck: passed.
- Package tests: 56 passed (faux provider, native SDK tools/history, real print/JSON CLI, SIGINT, offline stdio MCP, approvals, loops, concurrency, cancellation, collaborative creation, native current-session generation/iteration, fresh trial contexts, revision evidence, delegated review guards and cross-instance evaluation leases).
- Root pack:check: passed (builds and 19 packaging checks).
- Root test:scripts: 19 passed.
- publish:package -- pi-agent --dry-run: passed; no upload or login.
- git diff --check: passed.
- Full root check: fails in unrelated pi-bot server sources/tests referencing removed bots.ts, sessions.ts, models.ts and helpers.ts.
- Full root tests: pi-agent passes; unrelated failures in pi-bot (missing bots.ts), pi-orchestration (Nix lock version mismatch and source-only fixture missing Node types), pi-remote (SSH connection reset).
- npm audit reported existing host/dependency advisories, including undici; no unrelated dependency upgrades attempted.

## Collaborative `/agent new` — complete
1. Researched actual Pi command dispatch, `sendUserMessage`, SDK input interception, model-only tools and abortable human UI dialogs. Native SDK integration proves generation stays in the active conversation, including selected specialist history.
2. Replaced template/editor creation with purpose-first conversation. Optional requested name; active model proposes complete definitions with `agent_draft`, normal chat drives iterations. Durable off-roster drafts persist by an outer-session workflow ID.
3. Added `/agent draft`, `/agent eval [request]`, exact-revision human `/agent accept` and `/agent reject`. No model-callable acceptance. Existing edit approval/rejection remains separate and intact.
4. Added human-confirmed evaluations through native SDK sessions in fresh private scratch homes/histories. Management/delegation/scheduling tools disabled; actual task output/errors, success criteria, usage and transcript references retained per tested revision. Execution completion is not a pass grade; the author evaluates evidence and the human decides acceptance.
5. Added cancellation, abortable approval, revision CAS after dialogs, shared evaluation leases, no replay of uncertain trials, and guards against ordinary management/write bypasses. Accepted/rejected draft records remain inspectable; eval memory is never copied to production.
6. Updated README/help, source-package asset checks and automated tests. Latest package typecheck, all 56 tests, root pack:check (build + 19 checks), root script tests (19), npm pack dry run and diff whitespace check pass. No publish/commit/staging performed.

## Intentional boundaries
- Loops require a live Pi process; no service/daemon installed.
- Activation is an SDK conversation adapter, not native outer-session replacement. Use /agent stop for direct-chat cancellation.
- Approval/deletion are management API guarantees, not protection against hostile same-user shell/extension code.
- Foreign schema is preserved; unsupported restrictive runtime semantics fail closed rather than being silently emulated.
- Existing staged .envrc / flake / src/definition.ts changes were not modified or staged over.
- Draft review requires a human UI. Selected authors must permit agent_draft; permissions are not silently broadened. Sessions/forks sharing a draft ID see the latest shared revision/status, not independent copies.
- Trial homes/history are fresh, not an OS sandbox. Other tools and inherited global extensions can have real effects/costs; human approval is required for each trial. A crashed evaluation can leave an unknown-outcome record; the stale lease recovers without replay.
