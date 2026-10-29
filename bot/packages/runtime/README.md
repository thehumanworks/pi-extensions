# @nothumanwork/bot

Directory-defined, self-improving **bots**, powered by Pi. Embed a bot in a Node application, run it from the shell, or serve it as a long-running HTTP process. No Pi extension or global `pi` executable is needed for execution.

Bots use the user's global Pi extensions, MCP servers, skills and tool defaults unless explicitly excluded. The default executor is Pi's native `AgentSession`; `pi-durable` owns the persistent run queue and records. Bots with `inherit: none` and no native Pi extension factories use the durable conversation executor. Neither path implements another model loop or credential store. The separate [`@nothumanwork/pi-bot`](../../../pi-bot/README.md) package supplies Pi commands and rendering.

**Requirements:** Node **22.19+**, a Unix-like host with **`flock(1)`**, and Pi provider configuration or a supplied `Models` collection. Worker lifecycle tests run on Linux. `BOT.md` needs a name, description and persona—no format or version field. Global Pi extensions and MCP are inherited by default.

## Quick start

```sh
npm install -g @nothumanwork/bot
bot init ./reviewer
bot validate ./reviewer
bot info ./reviewer
bot run ./reviewer --cwd ../app --message "Review the staged diff"
# Text mode prints the durable session/run IDs to stderr.
bot run ./reviewer --session dconv:1 --message "Explain finding two"
bot sessions list ./reviewer
bot chat ./reviewer --session dconv:1
```

Use the run's actual session ID; IDs are scoped to one bot's state. `run` persists its conversation by default. `--json` writes final structured results to stdout; diagnostics go to stderr. `--request-id KEY` deduplicates identical run submissions across restarts; reusing a key with different input returns a conflict.

`bot chat` streams each reply as it is generated, both for a local bot and with `--url`. The answer goes to stdout as terminal-formatted markdown, using Pi's renderer and theme. Everything else goes to stderr:

- thinking, dimmed
- each tool call with a one-line result
- a usage footer: status, duration, turns, tool calls, input/output/cache tokens, cost, model, and session/run IDs

Styling is on for terminals. `--no-color` or `NO_COLOR` prints plain text; output redirected to a file or pipe is plain unless `FORCE_COLOR` is set. `--no-stream` waits for each complete reply, and `--json` writes only final records.

`bot --help` lists all commands and flags. A bare reference **always** resolves under `$PI_BOT_HOME` or Pi's user `bots/` directory; a same-named directory in the caller's CWD cannot shadow it. Use `./reviewer`, an absolute directory, or a `BOT.md` path for an explicit project. This is the same name/path distinction used by the Pi adapter. Use an absolute `PI_BOT_HOME` when overriding the roster root.

### Nix

The workspace flake at [`../../flake.nix`](../../flake.nix) provides the CLI,
a development shell, and an optional
Nixpkgs overlay for `x86_64-linux` and `aarch64-linux`:

```sh
nix run 'github:thehumanworks/pi-extensions?dir=bot' -- --help
nix profile add 'github:thehumanworks/pi-extensions?dir=bot#bot'
# From the repository root:
nix develop ./bot
```

The CLI includes Node and its runtime command-line tools; a separate global
`pi` installation is not needed. See [the Nix guide](nix/README.md) for local
builds, flake inputs, NixOS `environment.systemPackages`, Home Manager
`home.packages`, and dependency updates. Bot sources/state must remain outside
the read-only Nix store, and provider configuration is still per-user.

### Existing Pi provider access

Provider access uses the current OS user's Pi setup automatically, including the built-in catalog, API keys, environment/ambient credentials, custom `models.json`, and OAuth refresh. `PI_CODING_AGENT_DIR` selects the Pi user configuration directory. There is **no bot login**, and credentials are not copied into bot source or state.

Model selection: explicit `openBot({ model })`/CLI `--model` → `BOT.md` model → saved Pi default → an available authenticated model. Thinking follows explicit settings, bot settings, then Pi defaults. An unresolved model fails before execution. `validate` validates source/capabilities; opening the runtime additionally resolves model configuration. Live provider/OAuth requests are not exercised by this package's offline test suite.

## Embed

```ts
import { openBot } from "@nothumanwork/bot";

const bot = await openBot("./reviewer", { cwd: "../app" });
try {
  const result = await bot.run("Review the staged diff", {
    onEvent: event => console.log(event.type),
  });
  console.log(result.output, result.sessionId, result.usage);
  await bot.run("Explain finding two", { session: result.sessionId });
} finally {
  await bot.close();
}
```

`openBot` is embedded, in-process execution. For an SDK-owned child Node process:

```ts
import { openBotProcess } from "@nothumanwork/bot/worker";
const bot = await openBotProcess("./reviewer", { cwd: "../app" });
try { console.log(await bot.run("Inspect the tests")); }
finally { await bot.close(); }
```

CLI runs, the default server factory, and the Pi adapter use `openBotProcess`. It forwards events and cancellation over bounded IPC, closes gracefully, then enforces a shutdown deadline with process-tree cleanup. If a blocked worker cannot confirm explicit cancellation by its deadline, the SDK terminates it and returns `UNAVAILABLE` rather than claiming success; accepted work may be suspended, not durably cancelled. It does not run `pi --bot`. Supplying executable `options.models` objects explicitly uses the embedded runtime instead; such objects cannot cross IPC. In-process tools must cooperate with cancellation.

### Public surface

| Import | Exports |
| --- | --- |
| `@nothumanwork/bot` | `openBot`, `initBot`, `loadProject`/`loadBot`, `validateBot`, `inspectBot`, `defineTool`, `defineExtension`, `Type`, definition/catalog helpers and public types |
| `@nothumanwork/bot/worker` | `openBotProcess`, `WorkerOptions` |
| `@nothumanwork/bot/server` | `serve`, `ServeOptions`, `BotServer` |
| `@nothumanwork/bot/client` | `connectBot`, `BotClient`, `BotClientError` |
| `@nothumanwork/bot/pi` | `registerPiBot`, the UI-independent Pi command/tool adapter |

A `BotHandle` exposes `info`, `submit`, `run`, `getRun`, `listSessions`, `watch`, `cancel`, `callTool`, `reload`, and `close`. `submit` returns durable acceptance; `run` waits for terminal status. Results include `runId`, `sessionId`, `bot`, `cwd`, `status`, `output`, optional `error`/`model`, usage and tool-call counts.

Sessions bind their cwd at creation. `session: "new"` creates one; `"last"` selects the latest for the effective cwd; an explicit `dconv:…` resumes its original cwd. An explicit conflicting cwd is rejected, never silently forked. To work elsewhere, start a new conversation. Watches deliver a current snapshot followed by events, **not** a replayable event log. Resubscribe for a fresh snapshot after disconnect.

`run`/`submit` signals explicitly cancel admitted work. Disconnecting a watch or closing an HTTP client does not cancel accepted work. Closing an owning local runtime is not a blanket cancellation of queued work. Interrupted native Pi requests fail closed rather than replaying possibly completed external effects; the isolated durable executor can suspend work for recovery. `callTool` validates and serializes a direct call but is not a durable submitted run.

## Bot layout and capabilities

```text
reviewer/
  BOT.md                    # metadata + persona
  tools/check_policy.ts     # default-exported typed tool
  extensions/review.ts      # common tool/instruction bundle
  skills/review/SKILL.md     # Pi skill format
  scripts/                  # utilities, not automatically tools
  lib/                      # imports, not discovered as tools
  assets/                   # capability assets
  evals/                    # fixtures, not runtime discovery
  .bot/                     # default writable state
    MEMORY.md
    memory/
    tasks/
    journal/
    revisions/              # automatic capability checkpoints
    runtime.sqlite          # durable conversations and runs
```

`--cwd` is the execution workspace, **not the bot's home**. A bot's canonical source path selects its identity; `<source>/.bot/` is its default persistent home for memory **and all conversation threads**, regardless of execution CWD, caller CWD, or interface (SDK, worker, CLI, Pi, HTTP). The model is told both home paths and its current execution workspace on every request.

`--state-dir` explicitly selects an alternate persistent home. Keep that path stable (prefer an absolute path): choosing another state directory intentionally selects separate history, not a workspace-specific view of existing history. Source and memory are writable; persist **both** if improvements should survive container replacement. State is bound to its canonical source path; relocating state does not migrate identity to a different source path.

The default scaffold is intentionally open to newly authored capabilities:

```yaml
---
name: reviewer
description: Reviews code and improves its own review procedures.
# Global Pi extensions, MCP, skills and tool defaults are inherited automatically.
maintenance: true
# excludeTools: [bash, "mcp__internal__*"]
# excludeExtensions: ["some-extension"]
# excludeMcpServers: [internal]
# model: provider/model-id     # optional: use Pi's saved default
# No tools/skills allowlist: discover authored capabilities automatically.
---
You are a precise reviewer. Cite files and verify claims with tests.
Improve your own tools, skills and persona when useful.
```

- Omitted `inherit` means `global`: installed user-global extensions, MCP servers, skills, instructions and tool defaults are available. Workspace `.pi` resources are not inherited. `inherit: none` explicitly opts out of all global capabilities; provider credentials are independent.
- `excludeTools`, `excludeExtensions`, and `excludeMcpServers` remove individual capabilities using exact names or `*` patterns. Excluded MCP servers are not connected. Tool exclusions apply to nested calls too. Extension exclusions match entry paths, filenames/stems, index-directory names, or `builtin:mcp` / `builtin:codemode` / `builtin:tool_search`.
- Bot-local `tools/` and `extensions/` are additive. Local tool/skill definitions override the global layer; duplicate authored definitions within a layer fail.
- `builtinTools` optionally overrides the initial built-in selection; otherwise the user's `defaultTools` applies (fallback: `read`, `bash`, `edit`, `write`). Available built-ins also include `find`, `grep`, `ls`. `builtinTools: []` does not remove inherited extension/MCP tools.
- `bot_history` is enabled by default for read-only recall across this bot's workspaces and threads, independently of `maintenance`. With an explicit `tools` allowlist, include `bot_history` to enable it; `tools: []` still means none.
- `maintenance: true` adds `bot_read`, `bot_write`, `bot_edit`, `bot_reload`. They access source and memory; not SDK storage, credential files or dependency installations. This is a convenience scope, **not a sandbox** against shell or arbitrary code.
- An explicit `tools` array remains a restrictive allowlist for **all** tools, including maintenance and built-ins. `tools: []` means **none**. Usually omit it and use exclusions instead. Global extension/MCP tools are discovered at session startup, not during offline validation.
- Skills are discovered locally. An explicit `skills` array restricts them by name/path; `skills: []` means **none**.
- Global prompt templates/themes produce diagnostics instead of pretending to run a UI. Inspection/validation does not execute global extension factories or connect MCP servers. Runtime `info()` includes discovered tools after sessions initialize.

### Recall across chats

Curated memory (`MEMORY.md`, `memory/`, task notes and journals) is shared across threads. The bounded memory index is live context; conversation history remains in the SDK-owned `runtime.sqlite` and is recalled on demand, not automatically concatenated into every new conversation.

The model can use `bot_history` to:

- **`list`** all its sessions, regardless of CWD, with titles, workspace paths and timestamps.
- **`search`** user/assistant text, tool calls and tool-result text with a case-insensitive literal `query`, across all sessions or an optional `session`.
- **`read`** a `session` chronologically, or retrieve a specific `entryId` from that session. Long entries expose `nextOffset`; repeat the entry read with that value as `offset` (UTF-16 characters).

Results identify their session, workspace and entry IDs. Follow `nextCursor` with the same action/query/session until it is absent—even an empty search page can have a continuation because each scan is bounded. `limit` is 1–20 (default 10). Search returns excerpts around matches; entry reads recover the full readable text. Recall scans original persisted entries, including those outside compacted active context. It omits system prompts, private thinking, binary image payloads and `bot_history` results (to avoid recursively recalling copies). Historical content is evidence, not fresh instructions or authorization.

```sh
bot tool call reviewer bot_history --input '{"action":"search","query":"release date"}'
bot tool call reviewer bot_history --input '{"action":"read","session":"dconv:2"}'
```

The same tool is available through `bot.callTool("bot_history", input)` and the HTTP tool endpoint. It never resumes or modifies the retrieved thread. `session: "last"` remains a convenience for resuming the latest thread **in the effective execution workspace**; it does not limit memory or recall. Explicit session IDs still resume their original workspace.

Both native Pi execution and the isolated durable executor expose the same history result contract. Entry IDs are immutable positive integers scoped to a session; do not interpret them as timestamps or array offsets. Search and read results have `{ sessionId, cwd, entryId, kind: "message", text, offset, totalChars, nextOffset? }`; list results contain session metadata only. Pages are `{ items, nextCursor? }`. Separate bots, explicitly separate state directories and ephemeral copies do not share history. No legacy-history import or migration is provided.

### Typed tools

`tools/check_policy.ts`:

```ts
import { defineTool, Type } from "@nothumanwork/bot";

export default defineTool({
  name: "check_policy",
  description: "Check a relative path against review policy",
  parameters: Type.Object({ path: Type.String() }),
  replay: "safe", // only if safe to rerun after an interrupted process
  async execute({ path }, ctx) {
    return { path, workspace: ctx.cwd, needsReview: path.startsWith("src/") };
  },
});
```

```sh
bot tool call ./reviewer check_policy --input '{"path":"src/index.ts"}'
```

Context contains `cwd`, `sourceDir`, `stateDir`, `sessionId`, optional `runId`, and an `AbortSignal`. An open runtime also supplies read-only `ctx.history(query, signal)` for authored tools; it uses the same bot-wide recall contract. Return a JSON value, string, or `{ content: [{ type: "text", text: "…" }], details?, isError? }`. Image content is also accepted. Non-JSON results, invalid schemas and invalid inputs fail explicitly.

Top-level `.ts`, `.js`, `.mjs`, `.cjs` files in `tools/` are entry points. A child capability directory needs an `index.ts`, `index.js` or `index.mjs`. Keep shared imports in `lib/`; do not put helper modules beside auto-discovered tool entry points. SDK root imports expose the public API, including `openBot` for explicitly authored peer-delegation tools. Use ESM imports for SDK subpaths; first-load synchronous `require()` of those lazy subpaths is not guaranteed. Never recursively open the same owned source; delegate to another source or its daemon.

`extensions/review.ts` can default-export `defineExtension({ name: "review", tools: [tool], instructions: "…" })`, or a native Pi extension factory. Native factories use Pi's real extension runtime, including lifecycle handlers, tool hooks, nested calls and MCP registration—not a registerTool-only bridge. Native execution is headless: interactive UI and session-replacement commands are not a complete Pi CLI embedding. Initial model selection still requires a configured model catalog or supplied `Models`; a model defined only by an extension's provider registration cannot yet be selected initially.

MCP uses the user's Pi `mcp.json`, OAuth storage and native stdio/HTTP transports, with codemode/tool-search exposure. There is no separate bot MCP configuration or credential copy. Bot-specific `connections/`, `hooks/`, `channels/` declarations and schedules remain unsupported; use native Pi extension lifecycle hooks and user MCP configuration. Local source is trusted and may run side effects during validation. Loading never installs packages automatically.

### Autonomous improvement and recovery

The bot may change its persona, skills, scripts, tools and bundles without approval, promotion or deployment. After a tool batch, and before a queued request, the SDK validates a complete capability generation and swaps it coherently. Native extension, MCP and tool-selection changes activate at an idle request boundary; authored tool/persona changes can activate after a tool batch. A new tool can be used **within the same run** without editing the scaffold's allowlist. Invalid drafts remain on disk; the previous valid revision stays active, with repair diagnostics in the next model context. Checkpoints are recovery aids, not human gates.

Memory is live writable context, separate from capability revisions: a bounded `MEMORY.md` index, linked memories, resumable task notes and journal entries. Task notes do not automatically schedule work. SDK `editBot` and BOT.md maintenance edits share a definition lock; arbitrary editors/shell writes remain outside that cooperative protocol.

Checkpoint scope is bounded: root authoring/config/docs plus `tools`, `extensions`, `lib`, `skills`, `scripts`, `assets`, `evals`. Limits are **2 MiB/file, 16 MiB total, 2,048 files, 10,000 scanned entries**. Hidden directories, `.env*`, recognized credential names, SDK state and `node_modules` are excluded. Symlinked capability files are rejected. This is not a generic secret detector.

`--ephemeral` copies that source scope into scratch source and state and removes them on normal close. The execution workspace is **not isolated**; dependency installations are shared, not copied. Hard process termination may leave scratch directories for manual cleanup.

## Serve and connect

```sh
bot serve ./reviewer --cwd ../app
bot run --url http://127.0.0.1:3000 --message "Review the staged diff"
bot chat --url http://127.0.0.1:3000 --session dconv:1

# Valid without authentication, confirmation or an extra flag:
bot serve ./reviewer --host 0.0.0.0

# Optional caller token, separate from provider credentials:
bot serve ./reviewer --host 0.0.0.0 --auth-token-env BOT_SERVER_TOKEN
bot run --url http://127.0.0.1:3000 --auth-token-env BOT_SERVER_TOKEN --message "Review"
```

Caller authentication is **off by default on every bind address**. An explicitly requested missing/empty token is an error. With no token, anyone who can reach the endpoint can invoke its tools, inspect conversations and consume the serving user's provider allowance. Network restrictions are the operator's choice, not an SDK prerequisite. The daemon always uses its own OS user's Pi credentials; client provider credentials are never forwarded.

```ts
import { serve } from "@nothumanwork/bot/server";
import { connectBot } from "@nothumanwork/bot/client";

const server = await serve("./reviewer", { cwd: "../app", host: "0.0.0.0", port: 3000 });
const client = connectBot("http://127.0.0.1:3000");
try {
  const accepted = await client.submit("Review", { requestId: "review-123" });
  console.log(await client.getRun(accepted.runId));
} finally {
  await client.close(); // does not cancel the accepted run
  await server.close();
}
```

The server owns its factory-created runtime; an explicitly injected `bot` handle remains caller-owned. Remote requests cannot override source, state or workspace paths. `serve` stays in the foreground for an external process supervisor. No service installation, daemonization or token generation occurs.

### HTTP contract

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health (public even when a token is configured) |
| GET | `/v1/info` | Active configuration/capabilities |
| POST | `/v1/runs` | Submit `{ message, session?, requestId? }`, returns 202 + run record; with `Accept: application/x-ndjson`, streams the run (below) |
| GET | `/v1/runs/:id` | Current run record |
| POST | `/v1/runs/:id/cancel` | Cancel a run |
| GET | `/v1/sessions` | Conversation metadata |
| GET | `/v1/sessions/:id/stream` | Session snapshot, then NDJSON events (below) |
| POST | `/v1/tools/:name` | Direct `{ input, session? }` tool call |
| POST | `/v1/reload` | Validate/activate a source revision |

Optional token protection uses `Authorization: Bearer …` on `/v1/*`. HTTP errors are `{ error: { code, message } }`; domain errors map to 400/404/409/503, unknown failures to sanitized 500. Request/response/stream buffers and stream counts are bounded. Closing a watch disconnects only that observer. Direct HTTP tool calls do not have durable run IDs; use submitted runs when cancellation/recovery must survive a connection loss.

### Streaming a run

A plain `POST /v1/runs` returns as soon as the run is durably accepted; poll `GET /v1/runs/:id` for the result. To receive the reply while it is generated, send the same request with `Accept: application/x-ndjson`. Streaming is chosen by the client per request; the server needs no option.

```sh
curl -N http://127.0.0.1:3000/v1/runs \
  -H 'Content-Type: application/json' -H 'Accept: application/x-ndjson' \
  -d '{"message":"Review the staged diff"}'
```

The response is `200 application/x-ndjson`, one event per line, each shaped `{ type, sessionId?, runId?, data }`:

1. `run_accepted`: `data` is the accepted run record, the same as the 202 body. Its `runId` is what you cancel.
2. That run's events as they happen (table below). The prior conversation is not repeated.
3. `run_settled`: `data` is the terminal run record (`status`, `output`, `error?`, `usage`, `toolCalls`, `model`). The response ends after this line.

Validation, authentication and admission errors, including `STREAM_LIMIT` (503), are ordinary JSON error responses sent before any stream starts. Ignore unknown event types; more may be added. Disconnecting stops delivery only and never cancels the run:

- `GET /v1/runs/:id` fetches the result later.
- `POST /v1/runs/:id/cancel` stops the run.
- A `requestId` makes a retried submission safe.

A client that reads too slowly to stay under `maxStreamBufferBytes` is disconnected the same way. Run streams count towards `maxStreams`.

Events for rendering a reply:

| Event | `data` |
| --- | --- |
| `message_start` | `message`. For `role: "assistant"`, `content` can already hold partial blocks |
| `message_update` | `changes`: ordered updates. `message` carries a full replacement `message`; `block`/`text_start`/`thinking_start`/`toolcall_start` carry `{ contentIndex, block }`; `text_delta`/`thinking_delta` carry `{ contentIndex, delta }` |
| `message_end` | `entry: { id, kind: "message", model: BotMessage[] }`: authoritative completed messages; `id` is the same session-scoped ID used by history |
| `tool_execution_start` | `toolCallId`, `toolName`, optional `args` and `parentToolCallId` |
| `tool_execution_update` | The tool identity and a bounded `summary` of real partial output |
| `tool_execution_end` | The tool identity, `isError`, bounded `summary`, and optional completed `entry`; identical shape for nested and direct calls |
| `snapshot` | Recent `entries`, optional current `run`, optional `generation.message`, `tools` with running/completed/failed status, and optional retry/compaction `notice` |
| `auto_retry_start` / `auto_retry_end` | `{ attempt, errorMessage }` / `{ success, errorMessage? }` |
| `compaction_start` / `compaction_end` | `{}` / `{ error? }` |
| `task_failed` / `error` | `{ message }` / `{ code, message }` |
| `run_start`, `turn_start`, `turn_end`, `run_end` | `{}`; execution activity, not a terminal run record |

The exported `BotEvent`, `BotTranscriptEntry`, `BotMessage`, and `BotHistoryPage` types in [`src/types.ts`](src/types.ts) define the bot-owned contract. Both executors normalize their private events before SDK callbacks, worker IPC or HTTP delivery. Provider signatures, raw native session entries, system prompts and internal scheduler documents are not wire fields. Messages have `user`, `assistant` or `toolResult` roles; content contains text, thinking (empty when redacted), tool calls or image metadata without binary data.

One `message_update` can carry many changes; a fast reply may arrive whole with no deltas. Always reconcile with `message_end`, and use `run_settled` (or a terminal `snapshot.run`) as the authoritative final status/output/usage. Once a run is terminal, ignore buffered partial updates for that run ID. Pi widgets, `bot_run` updates and the CLI show assistant text, tool names/arguments, results/failures and actual retry/compaction notices—not synthetic progress.

`BotClient.run(message, { onEvent })` and `bot chat --url` require this NDJSON contract. An interrupted stream can still recover the final status by polling; there is no older-server compatibility mode.

To observe a whole session rather than one run, use `GET /v1/sessions/:id/stream`. It sends a `snapshot` event with the current conversation state, then every event for that session until the client disconnects. It is not a replayable log; reconnect to get a fresh snapshot. Snapshots restore in-flight text and tool activity, with a bounded recent transcript window (up to 50 entries / 100,000 characters); use `bot_history` for complete paged history. Historical entries are not presented as newly generated reply text.

## Examples

[Two persistent Exa web researchers](../../examples/web-researcher/README.md) demonstrate
standalone CLI/service execution and a separate Pi `/bot` specialist, both using
the inherited global Exa MCP server without bot-specific adapters. The accompanying [layout review](../../examples/web-researcher/LAYOUT-REVIEW.md)
distinguishes curated memory, task state and conversation history, and documents
current maintenance and long-running-operation gaps. Examples live in the repository,
not the published npm tarball.

## Operational limits

- **One owner, serialized execution.** Kernel `flock` locks protect state and canonical source. A daemon and local invocation cannot simultaneously own the same source—even with separate state directories. Use its URL, or a source copy, instead. Lock files stay in place to avoid unlink races.
- **No exactly-once external effects.** Native Pi requests interrupted by shutdown/crash fail closed and are not automatically replayed. Inspect potential external effects before retrying. The isolated durable executor replays interrupted tools only when explicitly safe. Cancellation cannot undo side effects.
- **Executor changes.** Existing durable conversations require a new conversation when enabling native Pi execution. Native conversations retain their native transcript if inheritance is later disabled; they are not converted to durable tool-replay conversations.
- **No sandbox.** Tools/modules/shell use host permissions. Worker process-tree cleanup is best effort, not containment against deliberate escape. Embedded noncooperative tools can delay close indefinitely.
- **Checkpoints are not full environments.** Installed dependencies, transitive global imports and files outside snapshot scope are not pinned. Changed external entry fingerprints can prevent recovery. Restored modules run from checkpoint paths, so `import.meta.url`-relative runtime I/O may see that location. Missing/corrupt referenced checkpoints fail closed.
- **Trusted module loading.** Module top-level side effects have no general disposal lifecycle. Arbitrary package globals/side effects may survive a reload inside a worker. Keep capability modules declarative. Restart for full process isolation when changing such dependencies.
- **Scope.** One bot per service, text requests, no session fork/import/migration API, no multi-tenant isolation, TLS termination or cron. Model/retry defaults are read at open; supported capability changes reload at boundaries. Pi config/loader/OAuth integration uses version-pinned Pi 1.4 helpers.

## Development

**Contract policy:** this project has no bot-definition or public event-schema version discriminator. Keep the documented output contract stable and covered by contract tests. Do not add backwards-compatibility layers, migration paths or versioning changes unless the user explicitly authorizes them.

For a pinned Node/npm and runtime-tool environment, run `nix develop ./bot`
from the repository root, then `npm ci`. See [the Nix guide](nix/README.md)
for flake checks and lockfile maintenance.

From the repository root:

```sh
npm run check --workspace @nothumanwork/bot
npm run test --workspace @nothumanwork/bot
npm run check --workspace @nothumanwork/pi-bot
npm run test --workspace @nothumanwork/pi-bot
npm run pack:check
```

Tests use scripted Pi models and temporary user/source/state directories, including same-run self-improvement, recovery, auth policy, IPC and process lifecycle. No live provider calls are needed. Build emits ESM JavaScript and declarations; the npm package contains compiled runtime assets, not a dependency on Pi's extension TS loader.
