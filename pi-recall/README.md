# @nothumanwork/pi-recall

Recall earlier conversation, search sessions, mark important messages, and save conversation summaries.

## Tools and command

- `recall_messages`: read conversation history, with `messages` or `full` output.
- `recall_sessions`: find sessions in this project or other projects.
- `recall_search`: search earlier conversation.
- `recall_mark`: mark or unmark important messages.
- `recall_summary`: create, list or read saved summaries.
- `/recall`: the interactive history browser. `/recall summary` manages summaries.

## Summaries

### Slash command

```text
/recall summary                                  # summarise the running session
/recall summary create                           # same
/recall summary create <session_id>              # another session in this project
/recall summary create project                   # all sessions in this project

/recall summary list                             # summaries requested in this session
/recall summary list session <requesting_id>      # requested in another session here
/recall summary list project                     # requests across this project's sessions
/recall summary list project <project>           # another project's saved summaries
/recall summary list all                         # saved summaries across all projects
/recall summary read <summary_id>                 # read one without generating anything
```

`<project>` is an absolute path, a home-relative path, or unique trailing folders (the same naming convention as recall). The project name/path consumes the rest of the command, including spaces; do not add shell quotes.

Listing opens a paginated picker. Select a summary to read it in the scrollable recall viewer. Escape closes the viewer or cancels generation. These commands do not append the summary to the conversation or trigger an agent turn. The slash command requires the terminal UI; the tool works in all modes.

### Tool

```json
{"action":"create"}
{"action":"create","scope":"session","sessionId":"<session_id>"}
{"action":"create","scope":"project"}
{"action":"list"}
{"action":"list","scope":"session","sessionId":"<requesting_session_id>"}
{"action":"list","scope":"project"}
{"action":"list","scope":"project","project":"other-app"}
{"action":"list","scope":"all","limit":20}
{"action":"read","id":"<summary_id>"}
```

- **Create:** defaults to the running session. A source session ID may be complete or a unique prefix. `scope: "project"` uses all sessions in the current project. Generation never includes another project, even if `recallConfig` links it. The selected active branch of each session is read, including history preceding compaction. Each request summarises the whole selected history, not just the new messages.
- **List:** defaults to summaries **requested in** the running session, which may summarise another session or the whole project. `sessionId` is an exact requesting-session ID. `scope: "project"` lists all requests in a project; `scope: "all"` lists every project. Results contain metadata, not summary bodies. Pass `next` as `cursor`, keeping the same scope and filters. Default page size is 20, maximum 50.
- **Read:** takes a complete summary ID from any project and returns the saved text and source references. No model/authentication is needed to list or read.

Tool text output is limited to 2,000 lines or 50 KiB; oversized output is also saved in full to a temporary JSON file. Structured results contain the complete data. Successful tool generation reports its nested model usage to Pi; listing and reading do not charge that usage again.

### Request guards

There is no arbitrary minimum message count or time-based cooldown:

1. A first summary requires at least one eligible user or assistant message.
2. A later summary of that scope requires at least one conversation-message ID not already covered by a successful summary of the scope. IDs are qualified by session, so identical entry IDs in different sessions cannot collide. Revisiting an already-covered branch does not unlock another request.
3. Only one generation can run per project. A heartbeat-backed filesystem lock applies across tools, slash commands and Pi processes. Competing requests fail immediately rather than queue. Locks left by crashed processes become reclaimable after about 30 seconds; live requests renew them.
4. Messages are captured before the model call. Messages arriving while generation runs remain eligible for a later summary.
5. Failed, cancelled, truncated or empty generations do not write a checkpoint. An explicit retry is allowed. A successful summary and its checkpoint are saved together before reporting success.

**Summary activity does not create eligibility.** A user turn containing only summary-tool calls and their narration is bookkeeping, including its requesting user message. This is determined structurally, not by classifying the user's wording. It also covers nested/codemode calls and failed requests. Mixed turns keep the user request and non-summary work; summary calls/results and subsequent assistant narration are excluded until a new user prompt or non-summary tool call. Tool-only messages, custom entries and compaction records do not by themselves unlock generation. There is no force/bypass flag.

Checkpoints are per canonical source scope: each session has its own, and the project's all-session scope has another. Summarising a session does not consume the first opportunity to summarise the whole project.

### Storage and model

Summaries live under Pi's agent directory:

```text
<agent-dir>/pi-recall/summaries/<sha256-of-project-path>/<summary-id>.json
```

The default agent directory is `~/.pi/agent`; Pi's configured agent directory is respected. Records have private file permissions and are published by atomic rename. They include the project, source scope, covered entry and conversation-message IDs, requesting session, user/agent origin, snapshot/completion timestamps, model and summary text. They are independent of session files and remain listable after those files are deleted. Corrupt records raise an error rather than silently losing a checkpoint. Nested summary-call markers are also kept as custom session entries; they do not enter model context.

Generation uses **`vercel-ai-gateway / inception/mercury-3`**, with a maximum of 16,384 output tokens, reasoning turned off and no prompt-cache retention requested. This model must exist in Pi's model registry with configured credentials. There is no fallback to the current model.

Input uses recall's condensed message format: long messages are shortened and tool results are reduced. Thinking and custom/compaction messages are excluded. A conservative context-size estimate rejects oversized history before the model call rather than silently dropping whole sessions. Citations are requested as verbatim excerpts keyed by `session_id/message_id`, but are model-generated and are not independently verified. This is a saved recall summary, **not** Pi session compaction.

## Development

```sh
bun test
bun run check
```
