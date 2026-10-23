# Canary extension

## Enable

Load `canary.ts` as a Pi extension, for example with `pi -e ./canary.ts`, or include its path in your configured extensions. After changing the extension, run `/reload`. Set a keyword and enable canary mode in one command:

```text
/canary chirp
```

This saves `"canary": "chirp"` to user settings (`~/.pi/agent/settings.json`, respecting `PI_CODING_AGENT_DIR`). If a trusted project's `.pi/settings.json` already defines `canary`, that override is updated instead. Other settings are preserved. The command waits until the agent is idle and automatically reloads Pi's settings/resources, so the new keyword is effective immediately without another manual `/reload`.

| Command | Behaviour |
|---|---|
| `/canary <keyword>` | Save the keyword and turn canary mode on. |
| `/canary on` | Enable using the existing keyword, without changing settings. |
| `/canary off` | Disable immediately, keeping the saved keyword. |
| `/canary` | Show the current mode and active prefix without changing anything. |

Only `on` and `off` are reserved (case-insensitive). Any other argument is the keyword, including `status`. Keyword case is preserved; the entire trimmed argument is used, so `/canary Blue Canary` sets `"canary": "Blue Canary"`. Keywords must be non-empty, single-line strings without control characters, including C1 controls and Unicode line/paragraph separators.

You can also set a **string keyword** (not a boolean) manually in user or trusted-project settings:

```json
{
  "canary": "chirp"
}
```

Then run `/reload` and `/canary on`. Enforcement requires **both** a valid keyword and enabled mode. The on/off choice is stored in the current session branch and restored on reload/resume/tree navigation; new sessions default to off. Malformed or busy settings files are not overwritten, and a failed save does not enable the mode. A leading UTF-8 BOM is accepted, matching Pi's own settings reader.

## Required response format

While enabled, the system prompt requires every visible assistant message to begin exactly with the case-sensitive prefix:

```text
chirp: The assistant's message.
```

Thinking/reasoning blocks, structured tool calls and their arguments, and tool results are exempt. Assistant text accompanying tool calls is **not** exempt. The extension detects violations; it does not silently rewrite responses to hide them.

## Recovery

At the end of the agent's response to a user message, a missing prefix triggers this sequence:

1. Flag the failure with a visible instruction and require the agent's next response to be a self-contained handover prompt. Tool execution is blocked during this phase.
2. Accept a complete, correctly prefixed, tool-free response beginning with `chirp: # Canary handover`, followed by a newline and handover content.
3. Generate a conversation summary using the current model, without tools and with thinking excluded from the serialized history. This is an additional model request and can incur usage charges.
4. Atomically append a **retain-none compaction** and the verbatim handover/resume instruction, then automatically continue the agent.

“Restart” means **fresh model context within the same session file**, not a new Pi process or new session file. The restarted model receives the system/tool checkpoint, compaction summary, and handover. Older conversation entries remain in the session history but are not replayed into the restarted context. Successful summary usage is attached to the compaction entry. Known limitation: usage from rejected or interrupted summary requests is not included in Pi's session totals; the current extension API does not expose an independent usage-recording operation.

Recovery allows at most two handover responses and one automatic restart per user message. The handover-attempt budget also applies when an earlier extension requests continuation. A deferred handover pauses recovery immediately instead of submitting more requests while a provider job may still be running; this does not explicitly cancel or retrieve that provider job. Further violations pause recovery rather than creating a loop. Provider errors, missing/empty/truncated summaries, and user cancellation do not discard history or automatically restart. Queued user input takes priority; a new user message resets the recovery state. If recovery pauses, inspect the preserved handover/history and send a new instruction, or disable canary mode.

## Tests

Requires Bun and the **current Pi API** (`getSettings`, boundary compaction drafts, `agent_before_settle`). From a package that has Pi installed:

```bash
bun test ./canary.test.ts
```

For a standalone extension, point the tests at your installed coding-agent entry point:

```bash
PI_CANARY_SDK=/absolute/path/to/pi/dist/index.js bun test ./canary.test.ts
```

The tests cover keyword persistence and automatic enabling/reload, settings precedence, case preservation, malformed/locked/BOM-prefixed settings, Unicode separators, symlinks, cancelled command changes, exact-prefix checks, reasoning/tool exclusions, branch restoration, bounded/deferred handover attempts, compaction failures, cancellation, queued input, preservation of other extensions' boundary drafts, headless operation, and Pi's real file loader/lifecycle with a scripted, offline provider.

See [Measured changes](canary.value.md) for before/after results and proposals deliberately not retained. To run the same tests against an older implementation, set `PI_CANARY_EXTENSION` to its absolute file path; both the unit harness and real loader use that implementation.
