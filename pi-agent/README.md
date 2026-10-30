# @nothumanwork/pi-agent

Specialist agents with a permanent home, one continuous conversation, and scheduled work. A smaller alternative to `pi-bot`: **Pi's SDK owns execution, tools, models, compaction and JSONL history**. No bot SDK, database, child `pi` process, daemon or separate authentication layer.

Requires **Pi 1.4.0+** and **Node 22.19+**. Tested against Pi 1.4.0.

## Install

After publication:

```sh
pi install npm:@nothumanwork/pi-agent
```

From this workspace, before publication:

```sh
# In the repository root
npm install --ignore-scripts
pi install ./pi-agent
```

Create a specialist collaboratively with the agent already active in your session:

```text
/agent new
# Describe its purpose when prompted; the active agent proposes a definition.
# Continue chatting: "Make it read-only and focus on authorization bugs."
/agent eval try representative and adversarial review cases
/agent accept
/agent reviewer
```

You can optionally supply a name (`/agent new reviewer`), or a name and purpose (`/agent new reviewer Reviews authorization changes and missing tests`). You describe the goal; the active agent writes the definition—not you.

Or activate it at startup, including print/JSON modes:

```sh
pi --agent reviewer
pi --agent reviewer -p "Review /absolute/path/to/project"
pi --agent reviewer --mode json "Summarize your findings"
```

## Commands

| Command | Action |
| --- | --- |
| `/agent`, `/agent list` | Names, routing descriptions, homes and source files |
| `/agent <name>`, `/agent activate <name>` | Continue that agent's own conversation |
| `/agent new [name] [purpose]` | Ask the active agent to propose a new specialist from your description |
| `/agent draft` | Show the current proposal and revision-specific evaluation evidence |
| `/agent eval [request]` | Ask the author to design/run trial tasks and assess their results |
| `/agent accept` | Human-confirmed creation from the exact reviewed draft |
| `/agent reject` | Human-confirmed rejection of the creation draft; creates nothing |
| `/agent edit <name>` | Edit and stage a definition |
| `/agent approve <name>` | Display current/proposed definitions and confirm the exact revision |
| `/agent reject <name>` | Confirm discarding a pending revision |
| `/agent delete <name>` | Human-confirmed archive of an idle agent; remove its schedules |
| `/agent loops` | Inspect persisted schedules and their latest status |
| `/agent stop` | Cancel the current direct conversation request |
| `/agent off` | Cancel direct work and return to ordinary Pi |
| `/agent help` | Usage and session boundaries |

Deletion retains the agent's home files. Registry history/definitions move to `.archive/`, and a tombstone prevents accidental resurrection or reuse of the same name. Use a new name when creating a replacement. Editing, approval and deletion require an interactive UI or an RPC client that implements human dialogs; headless calls cannot approve or delete.

Activation is a **conversation adapter**, not a replacement of the outer Pi session. Text/images go to a native SDK session rooted in the agent's home. Replies show its session-file reference; the TUI shows progress. JSON mode emits Pi custom-message events, not a copy of every child tool event. An invalid selection or failed agent request never falls back to the outer model.

Pi's `/model`, `/thinking`, `/tree`, `/fork` and `!shell` still belong to **outer Pi**. Configure the specialist in its definition. Selection is saved in the outer session branch; the specialist's history is separate. Rapid overlapping direct requests are rejected as busy rather than queued; use `/agent stop` to cancel. Cancellation cannot undo completed external effects.

**Direct-chat cancellation:** use `/agent stop` (RPC clients can submit that text as a prompt). Normal Escape and RPC `abort` target the outer Pi turn; because routing happens in an input hook before that turn starts, they do **not** cancel a selected agent. Do not interpret an acknowledged outer RPC abort as confirmation that child work stopped. SIGINT/SIGTERM, `/agent off`, and session shutdown do cancel the direct child. Delegated `agent_run` tool calls use normal tool cancellation.

## Collaborative creation

`/agent new` asks **what the agent should do and what success looks like**, then sends that request to the current conversation. Ordinary Pi uses its currently selected model, instructions and conversation context. If a specialist is selected with `/agent`, that specialist authors the draft in its own existing conversation. There is no separate generator model and no raw-definition editor in this flow.

The author proposes a full Markdown definition through `agent_draft`, explains its choices, and can clarify ambiguities. Continue chatting to refine it: “be more skeptical,” “use these skills,” “try these edge cases,” or “run more evals.” `/agent draft` shows the complete proposal at any point. Restrictive specialist definitions must allow `agent_draft` to author drafts; the workflow does not silently broaden their tool permissions.

A proposal is **not yet an agent**: it is absent from the roster and cannot be activated or scheduled. While reviewing it, `agent_manage create/edit` is blocked for the author and all delegates/scheduled runs in the same Pi runtime to prevent bypassing acceptance through another agent. Only the human's `/agent accept` creates the exact revision displayed for confirmation; `/agent reject` creates nothing. The author cannot accept or reject on your behalf. Acceptance leaves the current author selected; activate the new agent explicitly when ready. Finish the draft before switching authors.

### Evaluating a proposal

Ask naturally for evals, or use `/agent eval [request]`. The author chooses representative tasks and explicit success criteria, then uses `agent_draft eval`. **Each trial requires human confirmation of the full definition, task and criteria before running.** It uses the candidate's actual prompt, model, thinking and tool/skill choices through Pi's SDK, with these deliberate differences:

- Each trial gets a fresh scratch home and native conversation; it never trains on an earlier trial's history or writes into the proposed production home by default.
- `agent_manage`, `agent_run`, `agent_loop` and `agent_draft` are disabled in the trial to avoid creating agents, delegating into existing histories, scheduling work, or editing the proposal from inside the candidate.
- Scratch context is **not a sandbox**. Other tools/global extensions retain host permissions, may access explicit paths outside the scratch home, may call external services, and consume provider quota. Review evals before approving them.

The actual output, errors, criteria, usage and transcript reference are recorded against the tested revision. The author assesses that evidence, explains which criteria succeeded or failed, and can propose improvements and new trials. **`completed` means the trial executed, not that the definition passed.** Revising the definition marks earlier evidence as old-revision evidence; it is never silently treated as validation of the new prompt. There is no automatic acceptance or fabricated pass score: you decide when the definition is successful, and may also accept without evals after review.

`/agent stop` cancels a pending/running evaluation and the author turn while retaining the draft. Stop/wait for current work before accepting or rejecting. A cross-process evaluation lease also prevents another resumed session from accepting/rejecting while a trial is pending or running. Failed/interrupted trials are not replayed automatically. A crashed owner may leave a `running` record with unknown outcome; the stale lease becomes recoverable after about 30 seconds, but that record is not passing evidence.

Drafts/eval artifacts live under `<roster>/.drafts/<id>/`. The outer session saves the workflow ID so reload/resume can recover it without generating or executing anything. Sessions/forks referencing the same workflow see its latest revisions and terminal status. Rejected and accepted records remain for inspection; trial memory is never copied into the accepted agent's home/history. Creation review requires a human UI (including supported RPC dialogs).

## Definitions

Managed definitions are `<Pi agent directory>/agents/<name>.md`. The default Pi directory is `~/.pi/agent`; Pi's `PI_CODING_AGENT_DIR` override is respected. Set `PI_AGENT_HOME` to override the **roster directory**, not the individual agent's working directory.

```markdown
---
name: reviewer
description: Reviews code for correctness and missing tests. Use after implementation.
home: ~/agents/reviewer
model: anthropic/claude-sonnet-4-5
thinking: high
# Omit tools and skills for unrestricted discovery.
# tools: [read, grep, find, ls, agent_manage, agent_run, agent_loop]
# skills: [code-review]
---

You are a meticulous code reviewer.
Read memory.md in your home when it exists.
Use explicit paths to inspect other projects.
Verify findings and cite files and lines.
Maintain concise, useful notes in memory.md.
Propose improvements to this definition with agent_manage; never self-approve.
```

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters/numbers separated by single hyphens, up to 64 characters. Defaults to filename for imported definitions. |
| `description` | Routing text shown to users and agents. Optional on import. |
| `home` | Permanent working directory; defaults to `<roster>/homes/<name>`. Supports `~`; relative paths resolve against the source definition's directory. Normalized to an absolute path on import. |
| `model` | Prefer `provider/model`. Omitted, `inherit` and `default` use Pi defaults/history, not the outer session's transient model selection. Explicit models never silently fall back. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; defaults to Pi's configured effort, otherwise `medium`. Clamped by Pi to the selected model's capabilities. `effort` is accepted as an alias. |
| `tools` | Optional allowlist of registered Pi tool names; `*` patterns supported. Omitted makes all registered tools available; `[]` means none. |
| `skills` | Optional list of installed skill **names**, not paths. Omitted discovers all; `[]` means none. Unknown selected skills are errors. |
| `disallowedTools` | Optional denylist, applied after the allowlist. |
| `readonly` | Cursor compatibility: restrict to `read`, `grep`, `find`, `ls`, intersected with any explicit tool selection. |

Tool and skill selection are **independent**: specifying only skills leaves tools available, and specifying only tools leaves skills discoverable. Management/delegation/scheduling tools are not secretly added to a restrictive allowlist. With no file reader, skill metadata remains visible but instructions cannot be loaded automatically; enable a reader to use them.

The Markdown body is the system-prompt preamble, with Pi's skill/cwd sections and a small runtime policy appended. Global/home `SYSTEM.md`, `APPEND_SYSTEM.md` and context files do not silently replace this persona. Home and global extensions remain trusted code and can add behavior.

### Claude and Cursor compatibility

The package reads the same Markdown/YAML format—no version tag or proprietary wrapper is required.

Discovery, in precedence order:

1. Managed roster.
2. Trusted project `.pi/agents/`, `.cursor/agents/`, `.claude/agents/`, walking from the current directory through ancestors to the repository root.
3. `~/.cursor/agents/`, then `~/.claude/agents/`.

Project/user source directories are scanned recursively, without following directory symlinks. The managed roster is flat. Invalid definitions and shadowed names are reported. Project discovery is skipped when the outer Pi workspace is untrusted.

On first explicit activation/delegation, the selected definition is **copied into the managed roster**, with an additive absolute `home`. The original file is not modified and is not subsequently watched. Edit the managed copy after import.

Supported translations:

- Claude's comma-separated `tools: Read, Grep, Glob` and YAML arrays.
- `Read/Write/Edit/Bash/Grep/Glob/LS` → `read/write/edit/bash/grep/find/ls`.
- `Agent` or `Task` in a tool list → `agent_run`.
- Cursor's optional name/description, `model: inherit`, and `readonly`.
- Bare model IDs and Claude aliases such as `sonnet` are resolved by Pi's model resolver. Missing/ambiguous models fail with a diagnostic; use a full Pi model reference when needed.

Foreign YAML keys and comments are preserved. This is **definition-format compatibility, not an emulation of the other products**. Fields whose runtime semantics Pi cannot honor (`permissionMode`, `hooks`, `mcpServers`, `isolation`, `maxTurns`, `autoCompactWindow`, `initialPrompt`, `memory`, `omitClaudeMd`, and enabled `background`/`is_background`) block execution until removed from an approved Pi copy. Other metadata, such as `color`, is preserved with a warning. Vendor-specific permission expressions like `Bash(git:*)` are rejected rather than weakened.

References: [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Cursor subagents](https://cursor.com/docs/context/subagents).

## Home, history and autonomy

Every direct request, delegated task and loop uses the same agent home and native session. Working on a different project does **not** create a new history. Include absolute project paths in tasks. Homes are immutable after creation; create a new agent if another home is needed.

An agent can maintain notes, memory, scripts and tools in its home. Put Pi extensions in `<home>/.pi/extensions/` and skills in `<home>/.pi/skills/` or `<home>/.agents/skills/`. New resources load on the next request. Resource discovery uses the home and global Pi configuration, **not the caller's project**. Provider credentials come from the normal Pi configuration; a transient outer CLI `--api-key` is not copied into children.

Agent homes are treated as trusted workspaces. Standard Pi tools, installed extensions, MCP, codemode and tool search use the real SDK lifecycle. Existing permission extensions remain in force; child sessions are headless and cannot approve their dialogs.

History is stored under `<roster>/.state/<name>/sessions/`. Each request opens the latest native JSONL session, performs the task, emits extension shutdown and disposes the session. Per-agent filesystem locks prevent concurrent writers across Pi processes. Different agents can work concurrently. Recursive delegation cycles and chains deeper than eight agents are rejected.

## Model-facing tools

### `agent_draft`

Available to the active author during `/agent new`: `show`, `propose`, and `eval`. It cannot accept, reject or create a production agent.

```js
agent_draft({ action: "show" })
agent_draft({ action: "propose", definition: "---\\nname: reviewer\\ndescription: Reviews code\\n---\\n\\nVerify findings and cite paths." })
agent_draft({
  action: "eval", revision: "<exact revision from show/propose>",
  task: "Review /tmp/review-fixture for authorization defects.",
  criteria: "Find the known cross-account access bug, cite its location, and avoid claiming the safe endpoint is vulnerable."
})
```

Evaluation approval is requested from the human in the outer session, including when a selected specialist is the author. Delegated/scheduled agents do not inherit the creation workflow. Without an open `/agent new` draft, this tool refuses operations.

### `agent_manage`

Actions: `list`, `show`, `create`, `edit`.

```js
agent_manage({ action: "list" })
agent_manage({
  action: "create",
  name: "reviewer",
  description: "Reviews code after implementation",
  prompt: "Verify findings, cite paths, and maintain useful notes."
})
agent_manage({ action: "show", name: "reviewer" })
agent_manage({
  action: "edit",
  name: "reviewer",
  definition: "---\nname: reviewer\ndescription: Reviews code\nhome: /existing/home\n---\n\nProposed instructions."
})
```

Creation also accepts a complete `definition` or a custom `home`. Editing requires the full Markdown definition and stages a revision. There is **no model-callable approval or deletion action**.

All existing-definition edits require human approval, including edits made by another agent on the target's behalf. This prevents accidental approval-by-proxy. Direct edits to the managed Markdown file are detected as pending revisions rather than automatically adopted. The approved snapshot stays active until `/agent approve` confirms the exact revision; changes take effect on the next request.

### `agent_run`

```js
agent_run({ name: "reviewer", task: "Review /srv/app. Focus on authorization and tests." })
```

The target receives the task and its own history, not the surrounding caller conversation. Results include output, warnings, usage and a native session-file reference. Large delegated outputs are truncated with a pointer to the full transcript. Simultaneous calls to the same agent fail busy; they do not fork its memory.

### `agent_loop`

```js
agent_loop({
  action: "put", agent: "reviewer", name: "daily",
  cron: "0 9 * * 1-5", timezone: "Europe/Prague",
  task: "Review /srv/app changes since your last check and update your notes."
})
agent_loop({
  action: "put", agent: "reviewer", name: "periodic",
  everyMs: 3600000, task: "Check your outstanding follow-ups."
})
agent_loop({ action: "list" })
agent_loop({ action: "pause", agent: "reviewer", name: "daily" })
agent_loop({ action: "resume", agent: "reviewer", name: "daily" })
agent_loop({ action: "remove", agent: "reviewer", name: "daily" })
```

Inside an agent, `agent` defaults to itself. An interval is at least one second. Cron supports five or six fields via Croner; timezone defaults to UTC. Specify exactly one of `everyMs` or `cron`.

Schedules persist in `<roster>/.loops.json`. Polling starts with the outer Pi session and stops on shutdown/reload. **A Pi process with this extension must remain alive**; this package does not install a daemon, cron entry or service, and print-mode Pi exits after its request. An existing schedule resumes when Pi next runs.

Different agents' deadlines run independently; loops for one agent execute serially. Missed ticks coalesce instead of creating an unbounded catch-up queue. A known busy admission is deferred. The next deadline is persisted **before** execution: an interrupted/uncertain run is not automatically replayed, though the next regular occurrence can still run. A crash can leave the last status as `started`; inspect its transcript before manually repeating effects. Pause/remove does not cancel an occurrence that has already started; shutting down Pi cancels owned work. Cancellation does not undo effects.

## Approval boundary and safety

These are **trusted autonomous agents, not sandboxes**. An agent with shell access, a custom extension, or another unrestricted tool has the operating-system user's permissions. It can access other projects, credentials and registry files.

Human-only deletion and approval are enforced by the management API/commands. Built-in write/edit calls to registry files are blocked, and normal external Markdown edits do not change the approved prompt. These safeguards do **not** prevent a hostile same-user shell program from tampering with internal snapshots, following symlinks, or deleting files. Strong enforcement requires a separate OS identity/container and a separately owned approval store.

Use a local filesystem for registry locking. Locks are heartbeated and stale locks become recoverable after about 30 seconds; they are cooperative leases, not distributed fencing or exactly-once execution. Native tool side effects are not durably replayable.

Only enable schedules and load definitions/extensions that you trust. Scheduled tasks use provider quota and may change external systems without another confirmation.

## Development

From the repository root:

```sh
npm run check --workspace @nothumanwork/pi-agent
npm test --workspace @nothumanwork/pi-agent
npm run pack:check
```

Tests use Pi's faux provider and real SDK sessions, built-in tools, an offline stdio MCP fixture, and actual CLI subprocesses. No live model credentials are required.
