# Two persistent Exa researchers

- **`sdk/`**: standalone bot, runnable through the CLI or HTTP service.
- **`pi-bot/`**: separate researcher selected/delegated inside Pi with `/bot` or
  `bot_run`, with its own source, history and memory.

Both inherit **global Pi extensions, MCP servers, skills and tool defaults**.
There is no bot-specific Exa client, credential copy, or MCP dependency to install.
Each example adds one optional local tool, `research_clock`, alongside inherited tools.

## Setup

From this repository's `bot/` directory (Node 22.19+ and `flock` required):

```sh
# If repository dependencies/build are not already present:
npm ci --prefix ..
npm run build

# Check your global MCP servers. Exa is already configured in this harness.
pi mcp list
node bin/bot.mjs validate ./examples/web-researcher/sdk
node bin/bot.mjs validate ./examples/web-researcher/pi-bot
npm --prefix examples/web-researcher test
```

If Exa is not configured, add this entry to the current user's Pi `mcp.json`
(normally `~/.pi/agent/mcp.json`), preserving other servers:

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp",
      "headers": { "x-api-key": "${EXA_API_KEY}" },
      "exposure": "codemode"
    }
  }
}
```

Export `EXA_API_KEY` before launching the bot/Pi. Provider authentication also uses
that user's Pi setup. `PI_CODING_AGENT_DIR` selects a different Pi configuration
root. A remote daemon uses its serving user's setup, not its caller's credentials.

Validation is offline: it checks source/configuration without connecting MCP or
executing global extension factories. The full inherited tool inventory is discovered
when a runtime session starts. Both examples instruct the researcher to discover
Exa through codemode/tool_search and cite source URLs.

## 1. Standalone CLI or service

```sh
node bin/bot.mjs run ./examples/web-researcher/sdk \
  --message 'Research current Exa MCP capabilities. Prefer official sources and cite them.'

# Use the actual session ID returned by the run:
node bin/bot.mjs chat ./examples/web-researcher/sdk --session dconv:1

# Persistent foreground service; use a supervisor for boot/restart:
node bin/bot.mjs serve ./examples/web-researcher/sdk --port 3000
# In another terminal:
node bin/bot.mjs run --url http://127.0.0.1:3000 \
  --message 'Compare current Exa web search and fetch capabilities.'
```

Use `--cwd /absolute/workspace` when needed. Persist the source and `.bot/`
directories; do not use `--ephemeral` for persistent research. The service has no
web UI or background schedule. Configure authentication/network controls before
exposing it to untrusted clients.

## 2. Inside Pi

Install/enable `@nothumanwork/pi-bot` if needed (`pi install npm:@nothumanwork/pi-bot`).
When developing this checkout, use the built local packages rather than an older
published version; the inheritance behavior requires this updated SDK.

```text
/bot /absolute/path/to/pi-extensions/bot/examples/web-researcher/pi-bot
Research current Exa MCP capabilities and give me a source-grounded brief.
/bot exit
```

Or start interactively from `bot/`:

```sh
pi --bot ./examples/web-researcher/pi-bot
```

The parent Pi agent can delegate with:

```js
bot_run({
  bot: '/absolute/path/to/pi-extensions/bot/examples/web-researcher/pi-bot',
  task: 'Research current Exa MCP capabilities; prefer official sources and cite URLs.'
})
```

The bot uses the same **global configuration**, not the parent's live connections,
workspace-only resources, session-added resources, or conversation. Each worker
owns its native Pi runtime and connections. Delegation requests remain self-contained.

## Exclude defaults; add local capabilities

Neither example needs an `inherit` or `tools` declaration. Optional exclusions in
`BOT.md` accept exact names or `*` wildcards:

```yaml
excludeTools: [bash, "mcp__internal__*"]
excludeExtensions: [some-extension]
excludeMcpServers: [internal]
```

Use `inherit: none` only for a bot that should not inherit global resources.
`tools: [...]` remains a restrictive allowlist for compatibility—usually omit it.
`builtinTools: []` removes the initial builtins, not extension/MCP tools.

Add bot-specific tools under `tools/` or bundles/factories under `extensions/`.
`tools/research-clock.ts` shows a minimal additive tool with no extra dependencies.
Local tools override same-named global tools. These examples intentionally inherit
all enabled global capabilities; they are not restricted to research-only access.

## Memory, recovery and safety

See [the layout review](LAYOUT-REVIEW.md). Personas include checkpointing, provenance,
expiry and bounded curation policies. Memory is created lazily under `.bot/`; no
sample memories or databases are committed. Curation and search budgets are model
instructions, not enforced billing limits or a background garbage collector.

This is process/resource isolation, **not a sandbox**. Global extensions and tools
run with host permissions. Only one process can own a bot source; use its service
URL if it is already serving.

Native Pi conversations and run records persist, but an interrupted in-flight
request **fails closed and is not automatically replayed**: external effects may
already have happened. Inspect before retrying. Queued work remains durable.
If upgrading a bot previously run with `inherit: none`, start a **new conversation**
rather than trying to convert an existing durable-executor conversation.

## Smoke checks

These use the real worker tool pipeline without an LLM request. The fetch uses Exa
quota; tools may still be denied by inherited permission extensions.

```sh
node bin/bot.mjs tool call ./examples/web-researcher/sdk research_clock --input '{}' --json
node bin/bot.mjs tool call ./examples/web-researcher/sdk mcp__exa__web_fetch_exa \
  --input '{"urls":["https://exa.ai/docs/reference/exa-mcp"],"maxCharacters":500}' --json
```

The SDK test suite covers inherited native lifecycle hooks, MCP discovery/exposure,
exclusions (including nested calls), cancellation, cleanup, and transcript reopening
using offline servers/models. The example tests verify that both definitions use
global defaults and add their local tool without an Exa adapter.
