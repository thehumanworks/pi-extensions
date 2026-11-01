# pi-agent

Start a Pi session as a specialized agent. An agent is a Markdown file in Claude Code's [subagent format](https://code.claude.com/docs/en/sub-agents.md): YAML frontmatter, then a body that becomes the agent's system prompt. Each agent works in its own home directory, which is the cwd of all its sessions. Supports Pi 1.4.0.

## Install

From this checkout:

```sh
pi install ./pi-agent
```

## Use

```sh
pi --agent reviewer                      # interactive session as reviewer
pi --agent reviewer -p "Review the diff" # headless; also --mode json and --mode rpc
```

In a session:

- `/agent` lists the agents and any definition problems.
- `/agent reviewer` starts a new session as `reviewer`.
- `/agent reviewer Review the diff` starts the session and sends the prompt.

Each start opens a new session. The agent's earlier sessions are Pi sessions in its home, so `/resume`, `pi --session <file>`, or `pi -c` run from the home continue them as the agent. `/new`, `/fork`, `/tree` and `/reload` keep the agent. The footer shows `agent: <name>`.

If the agent doesn't exist, interactive Pi shows an error and stays a plain session. Headless runs send no prompt to Pi's default agent: print and JSON modes exit with status 1, and RPC mode refuses each prompt with an error.

## Define agents

```markdown
---
name: reviewer
description: Reviews code for correctness and style
tools: Read, Grep, Glob
model: sonnet
---
You are a senior reviewer. Read the change, then report problems in priority order.
```

Pi looks for definitions the way it looks for its own resources. A definition is a `.md` file directly inside an agents directory:

| Directory | Scope |
| --- | --- |
| `<cwd>/.pi/agents/` | Project; loads only in trusted projects (see below) |
| `~/.pi/agent/agents/` (`$PI_CODING_AGENT_DIR/agents/`) | User |

Project definitions come first, and the first definition of a name wins. `/agent` reports the definitions that lose. Files without frontmatter or a `name` count as documentation and are skipped. Ignore files, dot entries and `node_modules` are skipped too.

### Project trust

Pi asks whether to trust a folder only when the folder contains a resource Pi protects, and `.pi/agents` isn't one of them. A cloned repository could otherwise shadow your agents without asking. So project agents load only after a real trust decision:

- Pi asked about the folder because it has other protected resources, and you trusted it
- you trusted the folder with `/trust`
- `defaultProjectTrust` is `"always"`
- `--approve` was passed

If a requested agent is hidden because of trust, the error message says so.

### Homes

An agent's home is `~/.pi/agent/agent-workspaces/<name>/`, created the first time the agent starts. The home is the cwd of the agent's sessions, so tools run there, relative paths resolve there, and Pi loads the home's `AGENTS.md` and `.pi/` resources. Sessions are stored where Pi stores sessions for that directory, unless Pi runs with a custom session directory, which then holds them. With `--no-session`, the agent's session lives in a temporary directory that is removed when Pi exits. Names are unique, so an agent keeps its home for good. A project agent and a user agent with the same name share a home.

### Fields

| Field | Effect in Pi |
| --- | --- |
| body | Replaces Pi's base prompt, as `SYSTEM.md` would. Pi still adds project context, skills and the cwd. With pi-claude-bridge, Claude Code keeps its own system prompt and the body follows it, as the bridge does for any custom prompt. |
| `tools` | Allowlist. Omitted: Pi's usual tools. `[]`: no tools. Only the named tools are granted, MCP tools included (`mcp__server` grants a whole server). Names may be Claude Code's (`Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `PowerShell`, `Grep`, `Glob` → `find`, `LS`) or Pi's, with `*` patterns. |
| `disallowedTools` | Denylist, applied after `tools`. |
| `model` | Resolved like `--model`: `provider/id`, an id, or a pattern such as `sonnet`. `inherit` keeps the current model. A model that can't be resolved keeps the current model, with a warning. Applies when a session starts; a resumed session keeps its model. |
| `effort` | Thinking level. |
| `initialPrompt` | Prepended to the first prompt of a new session. Commands and skills in it are processed. |
| `name`, `description`, `color` | Used for listing. |

The tool policy also covers indirect calls. A call that `codemode` or `tool_search` makes to a tool the agent wasn't granted is blocked.

Permission rules like `Bash(git:*)` aren't supported. In `tools`, such a rule grants nothing; in `disallowedTools`, it denies the whole tool. `Agent` and `Task` aren't available yet.

Pi ignores `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background` and `isolation`, and warns when an agent sets them.

If a session's definition can't be loaded (deleted or invalid), the session runs with no tools until you fix the definition and run `/reload`.

## Limitations

- Pi fixes its cwd before extensions load, so `--agent` starts in the launch directory and switches to the agent's session before the first prompt. In JSON mode the first line is therefore the launch session's header. Events after it belong to the agent's session. The TUI reports the switch as "Resumed session".
- Agents don't run as subagents yet. Delegation from a running agent and agent creation, editing and evaluation are planned. Subagent runs are meant to be durable, using `@earendil-works/pi-durable`.

## Development

```sh
npm test       # unit tests and integration tests against the real Pi CLI with a scripted model
npm run check  # TypeScript
```

End-to-end tests against real providers are opt-in, since they use your logins and cost money:

```sh
PI_AGENT_E2E_MODELS=openai/gpt-6.1-sol,claude-bridge/claude-haiku-5-5 npm test
```

They run print mode, resume and RPC `/agent` with each model, and check the answer, the session's cwd, prompt, tools and model. They use your Pi agent directory for credentials but a temporary project, project agent and session directory, and remove the agent's home afterwards. `claude-bridge/` models load pi-claude-bridge from `~/.pi/agent/npm/node_modules`.
