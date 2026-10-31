# @nothumanwork/pi-bot

Named bots for Pi. A bot is a directory, and Pi runs in it: the body of its `BOT.md` is the system prompt, and everything else is ordinary Pi project behaviour for that directory, including settings, extensions, skills, context files and sessions. A bot session is a normal Pi session (same TUI, `/model`, `/tree`, `/resume`, `/compact`, tool rendering), whose working directory is always the bot's home.

Tested with Pi **1.4.0** and Node **22.19+**.

## Install

```sh
pi install npm:@nothumanwork/pi-bot   # after publication
pi install ./pi-bot                   # from this checkout
```

## Quick start

```text
/bot new reviewer        name, one-line description, system prompt; then start talking to it
pi --bot reviewer        start Pi as reviewer from any directory, continuing its latest conversation
/new                     inside the bot: a fresh conversation, still in reviewer's home
/bot reviewer            switch a running Pi to reviewer's latest conversation
/bot exit                back to a new session where Pi started
```

Or ask an agent: *"Create a bot called reviewer that reviews diffs for security issues."* It uses `bot_manage`.

## A bot's home

```text
~/.pi/agent/bots/reviewer/       ($PI_BOT_HOME/reviewer when set)
  BOT.md                         description + system prompt
  AGENTS.md                      optional standing context (a Pi context file)
  .pi/settings.json              model, thinking, tools… (Pi project settings)
  .pi/extensions/  .pi/skills/  .pi/prompts/  .pi/mcp.json
```

```markdown
---
description: Reviews diffs for security and correctness
---

You are a meticulous security reviewer. …
```

The body replaces Pi's default preamble, as `--system-prompt` would. Pi still adds context files, skills and the working directory, and pi-bot adds a short `<bot>` section that tells the bot where its home, definition and environment are, and how to reach other bots. Only the `description` frontmatter key is read. Configure everything else the Pi way, for example:

```json
{ "defaultProvider": "openai", "defaultModel": "gpt-6.1-sol", "defaultThinkingLevel": "high", "defaultTools": ["read", "grep", "find", "ls"] }
```

in `.pi/settings.json`. Sessions live where Pi keeps them for that directory (`~/.pi/agent/sessions/--<home>--/` by default), so `/resume` inside a bot lists the bot's conversations. The `<bot>` section names that directory, so the bot can search earlier conversations when asked about them.

## Working directory

The home is the working directory of every bot session. Work on other directories through absolute paths; when you start Pi elsewhere, the bot is told where.

Pi fixes its working directory before extensions load, so `pi --bot <name>` starts in the current directory and, once startup has finished, switches to the bot's latest session (or its first), the same replacement `/resume` performs. Anything you submit meanwhile, including a prompt on the command line, is held and sent to the bot's session. The starting directory's own project resources load briefly first.

- Each launch continues the same conversation; `/new` starts another in the bot's home, and `/resume` picks an older one.
- `-r`/`--resume` and `--session` resolve against the starting directory before pi-bot runs; use `/resume` inside the bot instead. Started inside the home, they choose the session as usual.
- Print and JSON modes cannot switch sessions before they run their prompt. Run them from the home (`cd ~/.pi/agent/bots/reviewer && pi -c -p "…"`) or use `bot_run`. RPC mode switches like the TUI.
- Two Pi processes on the same bot append to the same session file, as two `pi -c` would.
- An unknown bot fails without running the prompt in an ordinary session.

## A bot changes itself

- **Instructions:** it edits `BOT.md`; the new text applies from its next turn.
- **Environment:** it edits `.pi/`, `AGENTS.md`, its skills or extensions, then calls `bot_reload`. Pi reloads when the turn ends, and the changes apply from your next message. `/reload` does the same.
- **Other bots:** `bot_manage create`, then it edits their files.

pi-bot answers Pi's project-trust check for bot homes with *yes*, so a bot's own `.pi` resources load without a prompt, including in headless `bot_run` children. Bots are trusted agents, **not sandboxes**: their tools and extensions run with your permissions.

## Commands

| Command | Action |
| --- | --- |
| `/bot` | Pick a bot and continue its latest session |
| `/bot <name>` | Continue the bot's latest session (or start its first) |
| `/bot list` | Names, descriptions and homes |
| `/bot new [name]` | Create a bot interactively |
| `/bot edit [name]` | Edit `BOT.md` (the current bot by default) |
| `/bot exit` | Leave the bot: a new session where Pi started |
| `/bot reload` | Reload once Pi is idle (what `bot_reload` queues) |
| `/bot help` | Usage |

There is no delete command; to retire a bot, move or remove its directory.

## Tools

**`bot_manage`** — `list` bots, or `create` one from a name, description and system prompt. Existing bots are changed by editing their files.

**`bot_run`** — delegate a self-contained task: `bot_run({ bot: "reviewer", task: "Review /srv/app for authorization bugs." })`. It runs `pi --mode json` in the bot's home with the same Pi installation, so the child is the bot as you would talk to it, with its own prompt, settings, extensions and history. Each call starts a new session unless you pass `session: "<id>"` from an earlier result, or `"last"` for the bot's latest session. The result is the bot's final reply plus its session id. Delegation nests at most three levels. Cancelling the tool call stops the child; it cannot undo effects already made. Continuing a session that is also open elsewhere appends to the same session file.

**`bot_reload`** — only in bot sessions; see above.

## Migrating from 0.3

0.3 ran bots through the `@nothumanwork/bot` SDK. That SDK, its `bot` CLI, daemons, durable queue and `.bot/` memory and history are gone. Existing bot directories keep working: their `BOT.md` body becomes the system prompt. Their `.bot/` and `.sdk-*.lock` files are no longer used and are left in place. SDK conversations are not imported into Pi sessions. Move a bot's `model`, `thinking` and `tools` frontmatter into `.pi/settings.json` (`defaultProvider`/`defaultModel`, `defaultThinkingLevel`, `defaultTools`); in `BOT.md` they have no effect.

## Development

From the repository root:

```sh
npm run check --workspace @nothumanwork/pi-bot
npm test --workspace @nothumanwork/pi-bot
```

Tests run the real Pi CLI (print, JSON and RPC modes) in temporary directories with a scripted faux model; no provider credentials are passed to them.

The HTTP server (`src/server/`, `bin/`) and desktop app (`desktop/`) in this directory are not part of the npm package. They still import bot modules removed before 0.3, so they and `test/server.test.ts` do not currently build.
