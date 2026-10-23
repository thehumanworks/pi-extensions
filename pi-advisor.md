# Pi advisor

`pi-advisor.ts` adds an optional second-opinion model without changing the main session model.
Load it with `pi -e ./pi-advisor.ts`, or add its path to your configured extensions.

## Configuration

Choose a chat model configured in Pi, including custom providers and `models.json` models.
The advisor uses Pi's existing provider authentication; it does not manage credentials.

```sh
pi -e ./pi-advisor.ts --advisor openai/gpt-5.2
# Or:
PI_ADVISOR_MODEL=openai/gpt-5.2 pi -e ./pi-advisor.ts
```

Alternatively, add this to your Pi settings:

```json
{
  "advisorModel": "openai/gpt-5.2"
}
```

Startup precedence is `--advisor` > `PI_ADVISOR_MODEL` > effective `advisorModel`
settings (trusted project settings override user settings). Use `off` at any level
as an explicit disable. Invalid explicit values report an error rather than falling
back to another model. Model IDs can contain slashes, e.g. `openrouter/vendor/model`.

Commands:

- `/advisor` or `/advisor status`: show the current selection.
- `/advisor provider/modelId`: validate, enable immediately, and save the user default.
- `/advisor off`: disable future calls and save `advisorModel: "off"`.

Commands save to `getAgentDir()/settings.json` (normally `~/.pi/agent/settings.json`,
or the directory specified by `PI_CODING_AGENT_DIR`). Other settings are preserved;
malformed settings are not overwritten. An SDK host using a custom `agentDir` should
also set `PI_CODING_AGENT_DIR` to that directory if it exposes the saving command.
A command overrides startup configuration for the current extension runtime.
On reload/restart, the normal precedence applies again; a flag, environment variable,
or project setting can override the saved user default. Manual settings edits require
`/reload`. The TUI footer shows the enabled advisor model or a configuration error.
After correcting an unknown model or authentication error, select it with `/advisor`
again (or reload).

## Tool behavior

The main agent can call:

```json
{
  "question": "Should we retry this operation?",
  "context": "It creates a payment. The server timed out after accepting the request; we have an idempotency key."
}
```

The tool is named `ask_advisor`. `question` is required (up to 16,000 characters);
`context` is optional (up to 48,000 characters). The advisor receives only those
fields and its advisor instructions—not the session transcript, files, or tools.
Avoid including credentials or other sensitive data: supplied text is sent to the
selected provider and the call can incur additional charges.

Calls use medium reasoning where supported, an output limit of at most 4,096 tokens,
and the parent tool's cancellation signal. Usage is returned to Pi for session totals.
Only complete, nonempty text answers are successful; provider errors, truncated
responses, and empty replies are reported as tool errors. Changing/disabling the
advisor affects future calls, not requests already in flight. Advice does not
authorize actions or override user instructions. Non-interactive tool calls work
without the TUI.

## Tests

With Pi's packages installed locally:

```sh
bun test ./pi-advisor.test.ts
```

For a standalone checkout, point `PI_ADVISOR_SDK` to the installed Pi
`dist/index.js` and run the same command. Tests use temporary settings directories
and mocked/offline providers, including a real Pi extension-loader/session test;
no paid model requests are made.
