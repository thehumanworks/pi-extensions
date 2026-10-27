# @nothumanwork/pi-bot

A thin Pi UI for [`@nothumanwork/bot`](../bot/README.md): named specialists, direct conversations, delegation, progress and durable resume references.

All bot definition, tool loading, memory, execution and storage policy belongs to the SDK. The extension contains only adapter registration and rendering. A bot conversation is **not** a native Pi session: Pi displays inputs/replies and stores a reference; the SDK's `pi-durable` database owns its history.

## Install

```sh
pi install npm:@nothumanwork/pi-bot
```

Tested with Pi **1.4.0**, Node **22.19+**, and Linux with **`flock(1)`**. The SDK is an npm dependency and supplies its own pinned Pi runtime libraries. Neither standalone execution nor bot delegation starts a `pi` subprocess.

For shell/headless use, install the SDK executable separately:

```sh
npm install -g @nothumanwork/bot
bot init ./reviewer
bot run ./reviewer --cwd ../app --message "Review the staged diff"
```

## Commands

| Command | Action |
| --- | --- |
| `/bot` | Pick a named bot |
| `/bot <name\|directory\|URL>` | Route subsequent text to a new SDK conversation |
| `/bot new <name>` | Create a bot using a short description/persona editor |
| `/bot list` | List definitions without executing their modules |
| `/bot resume [ref]` | Select a durable conversation and its original workspace |
| `/bot info [ref]` | Show source, state, model, capabilities and revision |
| `/bot edit [ref]` | Edit a local `BOT.md` |
| `/bot stop` | Cancel this selected bot's pending chat requests |
| `/bot exit` | Return to ordinary Pi input; already accepted work continues |
| `/bot delete <ref>` | Confirm archiving an idle local source and colocated state |
| `/bot help` | Show usage and ownership boundaries |

`pi --bot reviewer` selects a bot at interactive startup using the same SDK-backed interface. Headless `pi --bot` is explicitly unsupported; use `bot run`, `bot chat`, or the `bot_run` tool. A failed startup selection does not silently route the request to Pi's ordinary model.

Names live under `$PI_BOT_HOME` or `<Pi user directory>/bots`. Paths containing `/`, `.` or `~` can select a source outside the roster. `/bot ./reviewer` and `/bot http://localhost:3000` both work. Tokens for protected daemons can be supplied through the `bot_run` tool or SDK CLI; the slash-command URL interface is tokenless.

The status indicator shows the selected bot and durable session. Text deltas appear in a progress widget; finished replies contain run/session IDs. Rapid follow-ups queue against the same conversation. `/reload`/Pi session resume restores the saved reference, not a copied transcript. Accepted work suspended when Pi closes resumes when that source is opened again. Workers close at Pi session shutdown; an idle selected worker also closes on `/bot exit`.

Pi `/model`, `/thinking`, `/tree`, `/fork` and native history editing **do not control** SDK conversations. Set the bot model/thinking in `BOT.md`; resume with `/bot resume`. Workspace changes require a new bot conversation, not a silent fork. Direct chat currently accepts text only and requires interactive Pi UI.

## Tools exposed to Pi

### `bot_manage`

Actions: `list`, `show`, `create`, `edit`. Create reusable specialists whenever useful. Definitions may be changed by complete `definition`, full persona `prompt`, or unique non-overlapping persona `edits`, with separate model/thinking/inheritance/tool/skill settings.

```text
bot_manage({ action: "create", name: "reviewer", description: "Reviews code",
             prompt: "Cite files, verify claims, and improve your own review procedures." })
bot_manage({ action: "edit", name: "reviewer", tools: [] })  // literally no tools
bot_manage({ action: "edit", name: "reviewer", tools: null }) // automatic discovery again
```

`null` clears optional model/thinking/selection settings; it is not the same as an empty array. The tool cannot delete bots. Human-confirmed archiving is a Pi administrative affordance, **not an approval requirement for a bot's own improvements**. Archiving does not relocate an independently configured external state directory; durable state remains bound to the original source path.

### `bot_run`

```text
bot_run({ bot: "reviewer", task: "Review the staged diff in this project." })
bot_run({ bot: "reviewer", task: "Explain finding two.", session: "dconv:1" })
bot_run({ bot: "http://localhost:3000", task: "Review the server workspace",
          authTokenEnv: "BOT_SERVER_TOKEN" }) // token optional
```

Tasks must be self-contained: the bot does not receive the surrounding Pi conversation. Results include output, usage, tool calls, terminal status and durable run/session IDs. Local runs use their requested cwd; a resumed conversation retains its original cwd. `session: "last"` selects the latest for the current/requested workspace. Remote cwd overrides are rejected because the server owns execution paths.

Pi tool cancellation flows to the SDK. Cancelling cannot undo external side effects. Local handles are reused within one Pi session, but the source has one runtime owner: if another process already serves it, use that daemon's URL rather than opening a second writer.

## Bot-owned capabilities and memory

Current definitions require `format: 2`. There is no old-home loader, native-session adapter, migration or compatibility mode.

The scaffold declares Pi workspace tools and `maintenance: true`, but omits a restrictive tool allowlist. Bots can autonomously author or improve `BOT.md`, `tools/`, `extensions/`, `skills/`, `scripts/`, and memory under `.bot/`. Valid generations activate after a tool batch, including within the same run. Invalid drafts stay on disk with repair diagnostics and the previous valid generation still active. No approval, promotion, PR or redeployment is required.

Capability inheritance is off by default. `inherit: global` opts into supported user-global Pi resources, never workspace `.pi` resources. The current classic extension bridge supports `registerTool` only; Pi lifecycle/UI/provider hooks, MCP and channels are not supported. Built-in provider auth/catalog/OAuth access is independent of this inheritance choice and uses the current OS user's existing Pi setup.

These are trusted executable bots, **not sandboxes**. Shell and authored tools use host permissions. A remote bot uses the server user's files and provider credentials; a daemon can deliberately run unauthenticated even on `0.0.0.0`. See the [SDK documentation](../bot/README.md) for optional tokens, checkpoint limits, durability/replay semantics and process lifecycle guarantees.

## Development

From the repository root:

```sh
npm run check --workspace @nothumanwork/pi-bot
npm run test --workspace @nothumanwork/pi-bot
```

Both commands build the sibling SDK first. Integration tests use temporary bot directories and scripted Pi models—no live provider calls.
