# Bot SDK: design record and implemented scope

This record replaces the original proposal after implementation was authorized. The subsequent user decision is authoritative: **no backwards compatibility or migration layer**. There is one supported BOT format and one conversation owner. The usage/API references are now [`bot/README.md`](../../bot/README.md) and [`pi-bot/README.md`](../README.md).

## Decisions

| Concern | Implementation |
| --- | --- |
| Public abstraction | **Bot**: source project, running instance, conversation/session, submitted run |
| Runtime | Pi `pi-durable` Harness owns the model/tool loop and SQLite conversations; `pi-ai` supplies providers; Pi `ModelRuntime` supplies normal user auth/catalog/OAuth |
| Independence | `@nothumanwork/bot` runs without the Pi UI extension or a global `pi` executable; it intentionally depends on Pi libraries |
| Source/state/workspace | Writable capability source; `.bot` state or explicit state directory; separately bound execution cwd |
| Self-improvement | Bots write canonical source/memory directly; valid generations activate at tool-batch boundaries without approval or deployment |
| Capabilities | Local typed tools, common tool/instruction bundles, skills, explicit built-ins/maintenance; optional supported user-global resources, never workspace `.pi` |
| Provider auth | Existing serving user's Pi setup by default; never copied into bot state; explicit `Models` injection for embedding/testing |
| Daemon access | No caller authentication unless a token is explicitly configured, including on `0.0.0.0`; no unsafe flag or mandatory confirmation |
| Concurrency | One source/state owner under kernel `flock`; runs sharing writable bot state serialize |
| Pi UI | Thin SDK client: input routing, progress, output and resume references. Pi does not own or mutate bot history |
| Compatibility | Required `format: 2`; no native JSONL history adapter, old-home loader or migration path |

## Package boundary

```text
bot/                          @nothumanwork/bot
  src/project.ts              capability loader/compiler and scaffold
  src/definitions.ts          typed authoring helpers
  src/catalog.ts              roster and definition editing
  src/runtime.ts              durable conversations/runs/revisions
  src/memory.ts               bounded memory/task context
  src/snapshot.ts             bounded local capability checkpoints
  src/lock.ts                 cross-process ownership
  src/worker*.ts              SDK-owned Node process transport/lifecycle
  src/server.ts, client.ts    single-bot HTTP server and client
  src/cli.ts, bin/bot.mjs      standalone CLI
  src/pi.ts                   rendering-independent Pi command/tool adapter
pi-bot/                       @nothumanwork/pi-bot
  index.ts                    register SDK adapter and Pi renderers
```

The SDK ships compiled ESM JavaScript, declarations, worker assets and its CLI. The Pi extension depends on it; packaging checks deliberately distinguish a standalone SDK from a Pi extension. Publish scripts accept the registered `bot` workspace as well as `pi-*` workspaces. Nothing is published as part of implementation or verification.

## Runtime ownership and recovery

One durable Harness owns all conversations for an open instance. Its scheduler persists admission, request-ID deduplication, run status and session/cwd binding. There is no nested `pi-agent-core` loop. The surrounding Pi transcript records only UI inputs/replies and a source/session reference.

New sessions and follow-ups are queued, not surprise interruptions. Retried request IDs must refer to identical inputs. An explicit cwd conflicting with a resumed conversation is an error; there is no automatic fork. Watches start with a current snapshot and then deliver changes. They are not a historical event-log API.

Embedded `openBot` executes in-process. CLI execution, default serving and the Pi adapter use `openBotProcess`, a child Node worker with typed bounded IPC, explicit cancellation, shutdown deadlines and process-tree cleanup. Supplying executable model objects uses embedded execution instead. Workers are isolation for lifecycle, not a sandbox.

Closing an owner suspends accepted work for restart; cancelling a run explicitly aborts it. An observer/client disconnect does not cancel accepted runs. Interrupted tools replay only under an explicit safe-replay declaration. Unsafe external effects report interruption; the SDK makes no exactly-once promise.

Source and state ownership use canonical paths and kernel locks. Lock files are not unlinked during release. A daemon and another local runtime cannot share mutable source even with separate state directories. Use the daemon's URL or copy the source for independent evolution.

## Autonomous capability generations

The scaffold includes workspace built-ins and declared self-maintenance. It does **not** freeze authored tool/skill discovery behind an initial allowlist. The bot can create a tool, skill or revised persona and use it later in the same run.

Compilation validates definition/schema/imports/collisions, records origins, snapshots a bounded source set and verifies that source did not change during compilation. At a tool-batch boundary it publishes one complete common extension generation. Invalid drafts remain on disk; the previous generation remains active and diagnostics enter the next model context so the bot can repair them. Checkpoints are automatic recovery aids, not an approval gate.

The durable instance records its active revision and interrupted runs' recorded revision. Recovery loads that checkpoint before considering the current draft. Corrupt/missing referenced snapshots and incompatible external fingerprints fail explicitly rather than pretending a hash is enough to reproduce code.

`tools: []` and `skills: []` mean none. Omission enables discovery. Catalog patch `null` removes an optional selection/default. Supported global inheritance is explicit; provider access is not inheritance. Local tools/skills override the global layer; ambiguous same-layer contributions fail.

## Service contract

The HTTP surface exposes health, info, durable submit/status/cancel, sessions, snapshot-plus-NDJSON watch, direct tool calls and reload. Clients cannot supply source/state/workspace paths. Request/response/stream buffers and stream counts are bounded; domain errors have stable codes and unexpected exceptions are sanitized.

Default bind is `127.0.0.1:3000`. Binding `0.0.0.0` with no token is supported without any extra flag or acknowledgment. An optional bearer token protects caller access; a deliberately configured empty token is an error. No provider credentials are sent by clients or returned as credential-management endpoints. All clients use the serving OS user's provider identity.

Without a token, reachable callers share the owner's exposed tools, memory/session surface and provider allowance. Operator-chosen network isolation/TLS is independent of SDK authentication policy.

## Pi interface

`/bot`, picker, `/bot new`, `/bot resume`, `/bot info`, `/bot edit`, `/bot stop`, `/bot exit`, confirmed archive, `bot_manage`, `bot_run` and interactive `pi --bot` call the SDK. They do not mount an alternate bot policy into Pi's native model loop. `/model`, `/tree`, `/fork` and native session editing therefore do not control bot conversations. Headless usage goes through the standalone CLI or delegation tool.

Management of other roster bots is separate from a bot's declared self-maintenance capabilities. Human-confirmed archive in Pi does not restrict autonomous edits. The SDK also exposes explicit administrative catalog functions.

## Deliberately unsupported / bounded

- Classic Pi factories support `registerTool` with a minimal context only. Lifecycle, provider-registration, UI, advanced delegated-tool semantics and MCP require dedicated adapters and are rejected, not partially loaded. Global inheritance consequently cannot load every installed Pi package.
- Common bot bundles are not raw durable extensions. MCP/connections, hooks, channels, schedules and multi-bot hosting are not implemented.
- Checkpoints cover bounded local authoring files/assets, not installed dependencies, arbitrary workspace trees or complete transitive global import graphs. Excluded credential-like filenames are not a general secret scanner.
- Restored module-relative runtime I/O sees checkpoint paths. External path references/dependency installations may prevent recovery after changes. There is no full environment snapshot or source-identity migration API.
- Embedded noncooperative code can delay close; workers use bounded termination. Process-tree cleanup is not adversarial containment. Module top-level side effects have no general disposal lifecycle.
- Direct tool calls are serialized/schema-checked but not durable submitted requests. Text requests only; no session fork/import API, multi-tenant authorization or TLS termination.
- Node 22.19+ and Unix `flock(1)` are required. Linux process lifecycle is tested; no Windows portability claim.

## Verification approach

Offline tests use scripted Pi models and temporary user/source/state directories. Coverage includes same-run self-improvement, invalid-draft repair, restart checkpoints, interrupted-effect replay policy, idempotency, cancellation, ownership, cwd binding, default credential paths, global resolution, HTTP limits/auth, worker cleanup/parent death, compiled CLI signals, and Pi reference-only integration. Live provider access/OAuth is not exercised by these tests.

Repository verification additionally checks TypeScript builds, release-script constraints, package export/bin assets and standalone packed-package loading. Exact execution results belong in the implementation report rather than this design record.

## Design sources

The original research used Cursor's [SDK overview](https://cursor.com/docs/agent-sdk.md), [project layout](https://cursor.com/docs/agent-sdk/reference/project-layout.md), [configuration](https://cursor.com/docs/agent-sdk/reference/agent-config.md), [tools](https://cursor.com/docs/agent-sdk/reference/tools.md), [HTTP API](https://cursor.com/docs/agent-sdk/reference/http-api.md) and [self-improvement guide](https://cursor.com/docs/agent-sdk/guides/improve.md), alongside installed Pi 1.4.0 SDK/extensions/configuration/provider/model documentation and `pi-durable` source/examples. The implementation borrows boundaries, not Cursor's managed deployment platform or full feature set.
