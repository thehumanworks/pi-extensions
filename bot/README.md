# @nothumanwork/bot

Directory-defined, self-improving **bots**, powered by Pi. Embed a bot in a Node application, run it from the shell, or serve it as a long-running HTTP process. No Pi extension or global `pi` executable is needed for execution.

This package uses Pi's `pi-durable` conversation/model loop, `pi-ai` providers, and `pi-coding-agent` model configuration and built-in tools. It does not implement another model loop or credential store. The separate [`@nothumanwork/pi-bot`](../pi-bot/README.md) package supplies Pi commands and rendering.

**Requirements:** Node **22.19+**, a Unix-like host with **`flock(1)`**, and Pi provider configuration or a supplied `Models` collection. Worker lifecycle tests run on Linux. The current BOT format is **`format: 2`**; unversioned/other formats and native Pi conversation files are not supported or imported.

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

`bot --help` lists all commands and flags. A bare reference resolves under `$PI_BOT_HOME` or Pi's user `bots/` directory. Use `./reviewer`, an absolute directory, or a `BOT.md` path for an explicit project.

### Nix

A flake in this package provides the CLI, a development shell, and an optional
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

`run`/`submit` signals explicitly cancel admitted work. Disconnecting a watch or closing an HTTP client does not cancel accepted work. Closing an owning local runtime suspends accepted work for recovery; it is not a blanket cancellation. `callTool` validates and serializes a direct call but is not a durable submitted run.

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

`--cwd` is the execution workspace, not the bot's source directory. `--state-dir` relocates state. Source and memory are writable; persist **both** if improvements should survive container replacement. State is bound to its canonical source path; relocating state does not migrate identity to a different source path.

The default scaffold is intentionally open to newly authored capabilities:

```yaml
---
format: 2
name: reviewer
description: Reviews code and improves its own review procedures.
inherit: none
builtinTools: [read, bash, edit, write]
maintenance: true
# model: provider/model-id     # optional: use Pi's saved default
# No tools/skills allowlist: discover authored capabilities automatically.
---
You are a precise reviewer. Cite files and verify claims with tests.
Improve your own tools, skills and persona when useful.
```

- `inherit: none` is the default. No workspace `.pi` resources are inherited.
- `builtinTools` selects Pi built-ins alongside discovered authored tools. Available built-ins: `read`, `bash`, `edit`, `write`, `find`, `grep`, `ls`.
- `maintenance: true` adds `bot_read`, `bot_write`, `bot_edit`, `bot_reload`. They access source and memory; not SDK storage, credential files or dependency installations. This is a convenience scope, **not a sandbox** against shell or arbitrary code.
- An explicit `tools` array restricts **all** tools, including maintenance and built-ins. `tools: []` means **none**. Unknown names fail validation.
- Skills are discovered locally. An explicit `skills` array restricts them by name/path; `skills: []` means **none**.
- `inherit: global` opts into supported installed user-global extensions, skills, instructions and tool defaults. Local tools/skills override the global layer; duplicates within a layer fail. Global prompt templates/themes produce diagnostics instead of pretending to run. Provider credentials do not depend on inheritance.

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

Context contains `cwd`, `sourceDir`, `stateDir`, `sessionId`, optional `runId`, and an `AbortSignal`. Return a JSON value, string, or `{ content: [{ type: "text", text: "…" }], details?, isError? }`. Image content is also accepted. Non-JSON results, invalid schemas and invalid inputs fail explicitly.

Top-level `.ts`, `.js`, `.mjs`, `.cjs` files in `tools/` are entry points. A child capability directory needs an `index.ts`, `index.js` or `index.mjs`. Keep shared imports in `lib/`; do not put helper modules beside auto-discovered tool entry points. SDK root imports expose the public API, including `openBot` for explicitly authored peer-delegation tools. Use ESM imports for SDK subpaths; first-load synchronous `require()` of those lazy subpaths is not guaranteed. Never recursively open the same owned source; delegate to another source or its daemon.

`extensions/review.ts` can default-export `defineExtension({ name: "review", tools: [tool], instructions: "…" })`. It is a common bot capability bundle, not a raw `pi-durable` extension. A limited classic Pi factory bridge supports **`pi.registerTool` only**, with a minimal execution context (`cwd`, `signal`, `hasUI: false`, `mode: "print"`). Other Pi lifecycle/provider/UI APIs, delegated-tool exposure and unsupported result fields fail explicitly. Consequently, `inherit: global` is not compatible with every installed Pi package. Provider extensions requiring registration hooks also need a dedicated adapter; built-in providers and `models.json` do not.

MCP/connections, hooks, channels and schedules are not implemented. Declaring unsupported executable capabilities is an error, not a silent partial load. Source code is trusted and may run side effects while being inspected. Loading never installs packages automatically.

### Autonomous improvement and recovery

The bot may change its persona, skills, scripts, tools and bundles without approval, promotion or deployment. After a tool batch, and before a queued request, the SDK validates a complete capability generation and swaps it coherently. A new tool can be used **within the same run** without editing the scaffold's allowlist. Invalid drafts remain on disk; the previous valid revision stays active, with repair diagnostics in the next model context. Checkpoints are recovery aids, not human gates.

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
| POST | `/v1/runs` | Submit `{ message, session?, requestId? }`, returns 202 + run record |
| GET | `/v1/runs/:id` | Current run record |
| POST | `/v1/runs/:id/cancel` | Cancel a run |
| GET | `/v1/sessions` | Conversation metadata |
| GET | `/v1/sessions/:id/stream` | Snapshot + NDJSON events |
| POST | `/v1/tools/:name` | Direct `{ input, session? }` tool call |
| POST | `/v1/reload` | Validate/activate a source revision |

Optional token protection uses `Authorization: Bearer …` on `/v1/*`. HTTP errors are `{ error: { code, message } }`; domain errors map to 400/404/409/503, unknown failures to sanitized 500. Request/response/stream buffers and stream counts are bounded. Closing a watch disconnects only that observer. Direct HTTP tool calls do not have durable run IDs; use submitted runs when cancellation/recovery must survive a connection loss.

## Operational limits

- **One owner, serialized execution.** Kernel `flock` locks protect state and canonical source. A daemon and local invocation cannot simultaneously own the same source—even with separate state directories. Use its URL, or a source copy, instead. Lock files stay in place to avoid unlink races.
- **No exactly-once external effects.** Interrupted calls replay only when explicitly safe; unsafe calls report interruption. Cancellation cannot undo a tool's side effects.
- **No sandbox.** Tools/modules/shell use host permissions. Worker process-tree cleanup is best effort, not containment against deliberate escape. Embedded noncooperative tools can delay close indefinitely.
- **Checkpoints are not full environments.** Installed dependencies, transitive global imports and files outside snapshot scope are not pinned. Changed external entry fingerprints can prevent recovery. Restored modules run from checkpoint paths, so `import.meta.url`-relative runtime I/O may see that location. Missing/corrupt referenced checkpoints fail closed.
- **Trusted module loading.** Module top-level side effects have no general disposal lifecycle. Arbitrary package globals/side effects may survive a reload inside a worker. Keep capability modules declarative. Restart for full process isolation when changing such dependencies.
- **Scope.** One bot per service, text requests, no session fork/import/migration API, no multi-tenant isolation, TLS termination, cron, MCP or native Pi lifecycle compatibility. Model/retry defaults are read at open; supported capability changes reload at boundaries.

## Development

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
