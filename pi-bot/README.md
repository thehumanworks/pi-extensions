# pi-bot — persistent custom agents for Pi

Create named agents ("bots"), each with its own persona (system prompt), model, reasoning effort, and optional tool and skill allowlists. A bot works in your current directory like any other Pi agent. It also has a **home** at `~/.pi/agent/bots/<name>/` holding its memory, skills, scripts, task state and **conversation history**. Whatever a bot learns or builds goes with it to every project, and resuming a conversation pulls the history from the bot's home, not from the project.

Both humans and agents can create and edit bots; only humans can delete them. Humans talk to a bot directly with `/bot <name>` or `pi-bot <name>`. Agents delegate to a bot with the `bot_run` tool, much like Claude Code subagents, except that the bot remembers and its conversations can be resumed.

The design takes ideas from Claude Code custom subagents (frontmatter definitions, `MEMORY.md` injection, resumable runs), Grok Bot (a roster of durable bots, memory per bot), OpenAI dots, Meta's Muse and Claude Duet (one ongoing identity that learns and keeps working toward goals).

## Install

```sh
pi install npm:@nothumanwork/pi-bot        # after publication
# From this checkout:
pi install ./pi-bot
# Or for one session:
pi -e ./pi-bot
```

The optional `pi-bot` shell launcher ships in the same package. `pi install` does not put it on your `PATH`. To get it, run `npm install -g @nothumanwork/pi-bot`, or alias `node /path/to/pi-bot/bin/pi-bot.mjs`.

## Quick start

```text
/bot new reviewer          guided setup: description, model, thinking, tools, skills, persona
/bot reviewer              start a conversation with reviewer in this directory
/bot resume reviewer       pick up one of reviewer's earlier conversations
/bot exit                  back to an ordinary session
```

Or ask the agent: *"Create a bot called reviewer that reviews diffs for security issues, on openai/gpt-6.1-sol with high thinking."* It uses `bot_manage`.

From a shell:

```sh
pi-bot reviewer                     # new conversation, history stored in reviewer's home
pi-bot reviewer -c                  # continue its latest conversation in this directory
pi-bot reviewer -r                  # choose from all its conversations (the "all" tab spans projects)
pi-bot reviewer -p "review the staged diff"
pi-bot list
```

`pi-bot <name> [options]` runs `pi --session-dir ~/.pi/agent/bots/<name>/sessions --bot <name> [options]`, so every other Pi option works.

## The home

```text
~/.pi/agent/bots/reviewer/
  BOT.md        definition: frontmatter settings + persona prompt
  MEMORY.md     memory index, injected into every run (first 200 lines / 25 KB)
  memory/       one durable fact per file
  skills/       skills the bot wrote (<name>/SKILL.md); loaded automatically
  scripts/      reusable scripts the bot wrote, indexed in scripts/README.md
  tasks/        one state file per long-running task (status, plan, progress, next step)
  journal/      dated session log (YYYY-MM-DD.md)
  sessions/     Pi conversation history (JSONL), across all projects
```

`BOT.md`:

```markdown
---
name: reviewer
description: Reviews diffs for security and correctness
model: openai/gpt-6.1-sol
thinking: high
tools: [read, grep, find, ls, bash]
skills: [security-review, ~/team/skills]
---

You are a meticulous security reviewer. ...
```

| Field | Meaning |
| --- | --- |
| `name` | Informational. The directory name is the identity: lowercase letters, digits, `-`, `_`. |
| `description` | The bot's job, in one line. Shown to agents choosing a bot to delegate to. Required. |
| `model` | `provider/model-id`. Applied when a conversation starts. Omit it to use the session model. |
| `thinking` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. `effort` is accepted as an alias. |
| `tools` | Tool allowlist (exact names or `*` globs). Omit it to keep the default tools. |
| `skills` | Allowlist of shared skills, by skill name or by directory path. Omit it to keep all skills. The bot's own `skills/` always load. |
| body | The persona. Pi's default prompt, tools and project context stay in place. |

Unknown frontmatter keys are preserved. Edit with `/bot edit <name>`, ask an agent (it uses `bot_manage edit`), or use any editor. Persona and skill-name changes apply on the next prompt. Model, thinking, tool and skill-path changes apply to new conversations.

## What the bot is told

On every prompt in a bot session, pi-bot adds these system prompt sections:

- `bot`: its identity, role and persona.
- `bot_home`: its home path and layout, plus a working protocol for long tasks:
  - Orient from memory, tasks, skills and scripts before starting.
  - Put the state of long tasks in `tasks/` so a compaction or a fresh session can resume from the file alone.
  - Save durable learnings as memories, without duplicates and without secrets.
  - Codify repeated procedures as skills or scripts.
  - Leave a journal entry and a next step before stopping.
  - Keep project deliverables in the working directory, not in the home.
- `bot_memory`: the `MEMORY.md` index.
- `bot_state`: today's date, open tasks, scripts and the latest journal entry.

Ordinary sessions where `bot_run` is active also get a `bots` roster (name and description) so the agent knows whom it can delegate to.

## Commands

| Command | Action |
| --- | --- |
| `/bot` | Pick a bot to talk to (`/bot list` only lists) |
| `/bot <name>` | New conversation with the bot in this directory, saved in its home |
| `/bot resume [name]` | Choose one of the bot's conversations. One from another directory can be continued here (the history is copied) or opened in its original directory. |
| `/bot new [name]` | Create a bot step by step |
| `/bot edit [name]` | Edit `BOT.md` |
| `/bot info [name]` | Home path, settings and counts of memories, skills, scripts, tasks and conversations |
| `/bot exit` | Start an ordinary session in Pi's normal session directory |
| `/bot delete <name>` | Move the home to `~/.pi/agent/bots/.archive/` after you confirm |

Inside a bot conversation, Pi's own `/new`, `/fork` and `/resume` stay inside the bot's `sessions/`. Use `/bot exit` to get back to your ordinary sessions.

## Agent tools

**`bot_manage`**: `list`, `show`, `create` and `edit` bots. Every agent has it, including bots whose tool allowlist leaves it out, so any agent can set up a specialist or refine one. Models are checked against Pi's model registry and saved as `provider/id`. Tool names that no loaded tool matches produce a warning.

`edit` changes only the fields you pass:

```json
{ "action": "edit", "name": "reviewer", "thinking": "xhigh",
  "edits": [{ "oldText": "Be direct.", "newText": "Be direct. Cite file:line for every finding." }] }
```

- `prompt` replaces the persona; `edits` makes exact replacements in it. Each `oldText` must match once, as with Pi's `edit` tool.
- `"inherit"` clears `model` or `thinking`; an empty list clears `tools` or `skills`.
- `definition`, passed on its own, replaces the whole `BOT.md`, including extra frontmatter. It is validated before anything is written.

The tool has no delete action. Removing a bot stays with the human (`/bot delete`, which asks for confirmation and archives the home).

**`bot_run`**: delegate a self-contained task:

```json
{ "bot": "reviewer", "task": "Review the staged diff for injection risks and list findings with file:line.", "session": "new" }
```

The bot runs as a child `pi --mode json` process in the working directory (`cwd` overrides it), with its persona, model, tools, skills and memory. The result contains the bot's final answer and a session id. Pass `"session": "<id>"` to continue that conversation, or `"last"` to continue its latest conversation in this directory. If the session started in another directory, it is forked into this one, so the history comes along and the work happens here. Progress streams into the tool row. Aborting the tool stops the child. Delegation nests at most 3 levels deep.

## Tool allowlists and the home

If a bot's `tools` list leaves out `read`, `write` or `edit`, pi-bot still enables those tools, but only for paths inside the bot's home. A read-only reviewer can then keep its memory without being able to edit the project. This is a guard against mistakes, not a sandbox: a bot that has `bash` can still write anywhere. `bot_manage` is also always enabled, so a restricted bot can still create and edit bots.

## Environment

| Variable | Purpose |
| --- | --- |
| `PI_BOT_HOME` | Bots root (default `$PI_CODING_AGENT_DIR/bots`, i.e. `~/.pi/agent/bots`) |
| `PI_BOT_PI_COMMAND` | Executable that `bot_run` and `pi-bot` use to start Pi (default: the running Pi, or `pi` on `PATH`) |
| `PI_BOT_DEPTH` | Set by `bot_run` for child processes to limit nesting |

## Notes

- `pi --bot <name>` without a matching `--session-dir` applies the persona to that startup session only, and its history stays in Pi's normal session directory. Use `pi-bot <name>` or `/bot <name>` instead.
- Parallel `bot_run` calls to the same bot use separate conversations but share its home. Concurrent edits to the same memory file can race.
- Tool allowlists apply to tools registered when the session starts. MCP tools remain reachable as their exposure allows.
- A home is a plain directory. To carry a bot to another machine, sync it (for example with git), or leave out `sessions/` if the history is sensitive.

## Develop

```sh
npm run check --workspace @nothumanwork/pi-bot
npm test --workspace @nothumanwork/pi-bot
```

The tests use a temporary `PI_BOT_HOME` and a fake `pi` executable. They make no model calls.
