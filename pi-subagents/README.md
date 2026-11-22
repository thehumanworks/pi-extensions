# pi-subagents

Delegate work without leaving your conversation. The lead can keep answering you while workers run. A worker sends its result or asks the lead a question; its intermediate turns stay out of the lead's chat.

## Try it

Use a persistent Pi session with a working model login. From this checkout:

```sh
pi install ./pi-subagents
pi
```

After publication: `pi install npm:@nothumanwork/pi-subagents`.

Ask the lead: “Delegate a review of these requirements for contradictions. While that runs, help me choose acceptance tests.” The worker gets the assignment and its **own** conversation, not a copy of the lead's message history. By default it uses the lead's active model, thinking level, and system instructions. Workers use Pi's model registry and request-time authentication. There is no separate API key, hosted workflow service, or worker daemon.

### Choose worker settings

Only `task` is required. A lead can set any combination of the other arguments on `subagent_delegate` without changing the lead session:

| Argument | If supplied | If omitted |
| --- | --- | --- |
| `model` | An exact `<provider>/<model>` from the lead's `/scoped-models` list. Model IDs can contain slashes. | Use the lead's active model, even if no scope is configured. |
| `reasoningEffort` | A Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi limits the level to what the model supports. | Keep the lead's level. For an explicit model, use the first level set: scope, per-model setting, global setting, or lead session. |
| `systemPrompt` | Literal text (not a file path) that replaces the inherited system prompt for this worker. Worker reporting instructions and tool permissions still apply. | Inherit the lead's effective system prompt when the worker starts or resumes. |

For example, replace the model placeholder below with a name from your scope:

```json
{
  "task": "Find contradictions in the requirements and cite the conflicting lines.",
  "model": "<provider>/<model>",
  "reasoningEffort": "high",
  "systemPrompt": "You are a requirements reviewer. Report only contradictions supported by the text."
}
```

Pi resolves the scope from `/scoped-models`, `enabledModels`, or `--models`. If the scope is empty, omit `model` or configure a scope first. An out-of-scope name fails before the task is queued. The selected provider receives the worker's prompt, assignment, and tool results. Retries, resumes, and child tasks keep the saved model, effort, and any custom prompt.

### Worker access

Workers inherit the lead’s available tools when they start or resume. There is no worker file-access flag. If the lead can run a shell, use a remote host, or call MCP and extension tools, workers can use those tools too. Only the three subagent-management tools are excluded. Assign disjoint resources to concurrent writers.

With `codemode.mode = "only"`, both the lead and its workers use Pi’s native `codemode`. A worker script sees its inherited tools, not `subagent_delegate`, `subagent_status`, or `subagent_resume`. Ordinary calls go through the running lead’s Pi tool dispatcher, including permission hooks, remote routing, and current tool availability. A disabled direct tool is not enabled for a worker.

Pi does not allow tools to call a **model-only** tool through this dispatcher. Workers run those tools (including `codemode` and `tool_search`) in their own Pi session with the lead’s settings, trust level, and configured extensions. The router’s session state is separate; nested ordinary tool calls still use the lead’s live checks. A permission hook installed only in memory on the lead cannot intercept the outer worker-local router call. A custom model-only tool must come from a reloadable Pi extension: if its implementation exists only in an embedding application's memory, the worker reports the missing tool rather than substituting another implementation.

### Status and limits

- `/subagents` lists tasks and limits. The footer shows counts by state.
- `/subagents limits 3 1` sets maximum concurrency and depth for this lead session. These are the defaults. The lead is depth 0; depth 1 allows direct workers only. Concurrency accepts 1–32; depth accepts 0–8. Lowering limits does not kill running work. Depth 0 prevents new delegation.
- The lead uses `subagent_delegate`, `subagent_status`, and `subagent_resume`. Ask it to inspect a task ID, answer a blocker, or retry a failure. Routine progress does not trigger a lead turn.
- A worker can delegate one narrower assignment at a time when depth allows. It releases its slot while waiting. A child result resumes the parent waiting for it. A blocked child waits for the lead. If the child exhausts its retries, the lead is notified and its waiting parent receives the failure reason. If the lead retries that child later, its result goes directly to the lead without waking the parent again. Even with concurrency 1, a parent never waits while holding the child's slot.

### Recovery

Closing Pi, switching sessions, or reloading the extension stops the workers. Reopen the **same session file** to continue. A fork gets a separate board. No work happens while the lead is closed. Ephemeral sessions (`--no-session`) are not supported.

A private directory under `<Pi agent directory>/subagents/` holds a per-session SQLite board, including assignments, transcripts, tool results, and answers. Treat it like a Pi session transcript: it can contain sensitive project data and is not encrypted. SQLite admits only one owner at a time. To discard a board, close the lead before removing its directory.

The board checkpoints completed tool turns and commits results before notifying the lead. On interruption, safe work resumes from its checkpoint; an in-flight model request may run again and incur another charge. Failures retry with backoff, up to three attempts before the lead is asked to intervene. Workers record intent **before** invoking tools, including shell commands, remote calls, and codemode scripts. If interrupted before the tool-turn checkpoint, the worker blocks instead of assuming the call was read-only. Verify the outcome, then ask the lead to resume the task with what you found. Notices stay on the board while the lead is busy. Once the lead settles, missing notices are delivered against the saved conversation, even if its queue was cleared. After a user abort, notices are added without starting another turn. Reopening the same session also recovers missing notices.

This is local task recovery, not exactly-once execution of external actions. Worker checkpoints include native Pi session entries such as codemode’s stored values.
