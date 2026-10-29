# Pi Usage

**OpenAI ChatGPT and Claude subscription usage limits in Pi.**

Run `/usage` for a scrollable view of each account's allowance and reset times—not tokens consumed in the current Pi session. OpenAI bars show **percent left**, like Codex. Claude bars show **percent used**, like Claude Code, including the five-hour session, all-models weekly, and Fable weekly limits.

## Install

From this checkout, after installing dependencies at the repository root:

```sh
pi install /path/to/pi-extensions/pi-usage
```

Then restart Pi or run `/reload`. For a one-session preview:

```sh
pi -e /path/to/pi-extensions/pi-usage/index.ts
```

Published releases:

```sh
pi install npm:@nothumanwork/pi-usage
```

Requires Pi 1.4.0's extension/auth APIs and Node.js 22.19+. No background polling, configuration file, or model tool is installed.

## Sign in

### OpenAI

Keep using **`/login openai` → Sign in with ChatGPT** for inference. Add the separate credential used by Codex to read usage:

```text
/login openai-codex
/usage
```

Choose the **same ChatGPT account/workspace** for both logins. The usage view displays the account belonging to the Codex credential; it does not automatically verify that it matches your inference account. Signing into the Codex provider does not require changing your selected model.

Pi owns credential storage, refresh, and refresh-token locking. This extension does not create another OAuth client, copy tokens, read `~/.codex/auth.json`, or use browser cookies. An API key is not a fallback.

#### Why the second OpenAI login?

The newer Sign in with ChatGPT token-sharing login does not currently expose Codex-style account usage. Its token is not accepted by Codex's usage endpoint. See [OpenAI issue #54219](https://github.com/openai/codex/issues/54219) and [OpenAI's errors and recovery guide](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

This extension reads **account allowance through Codex**. It deliberately **does not include Pi-specific app caps** on the newer login. An app-specific cap can therefore block Pi even when the account view shows allowance remaining. No allowance is inferred from session token counts or token expiry.

### Claude: native Pi or Claude Code / pi-claude-bridge

If already signed into Claude Code (including through `pi-claude-bridge`), just run:

```text
/usage claude
```

**No separate `/login anthropic` is needed for bridge users.** If Claude Code needs a login, run `claude auth login` in your terminal. Inference-only `claude setup-token` tokens may lack the profile permission needed for usage.

Alternatively, use Pi's native subscription login:

```text
/login anthropic
/usage claude
```

Select the Claude subscription/OAuth option, not an API key. An Anthropic API key is not a subscription-usage credential.

#### Where authentication lives

| Login | Credential store | Who resolves and refreshes it |
| --- | --- | --- |
| Pi native Anthropic | `anthropic` entry in `~/.pi/agent/auth.json`, or `$PI_CODING_AGENT_DIR/auth.json` | Pi's `modelRegistry.getProviderAuth("anthropic")` |
| Claude Code / bridge on macOS | macOS Keychain, normally service `Claude Code-credentials`; fallback `~/.claude/.credentials.json` if Keychain storage is unavailable | Claude Code, through the Agent SDK |
| Claude Code / bridge on Linux | `~/.claude/.credentials.json` | Claude Code, through the Agent SDK |
| Claude Code / bridge on Windows | `%USERPROFILE%\.claude\.credentials.json` | Claude Code, through the Agent SDK |

`CLAUDE_CONFIG_DIR` changes Claude Code's credentials-file directory **and** the macOS Keychain entry it selects. The SDK handles this, including config-specific Keychain naming; the extension does not duplicate that lookup or rotate Claude Code's tokens itself. The bridge passes the process environment to Claude Code and does not maintain a separate subscription login in Pi. See [Claude Code authentication](https://code.claude.com/docs/en/authentication) and the [bridge source](https://github.com/elidickinson/pi-claude-bridge).

**Account selection:** if the selected Pi model uses `claude-bridge`, use Claude Code's login. Otherwise prefer native Pi Anthropic OAuth when present, falling back to Claude Code only when no native OAuth credential is configured (an API key also falls through). A failed selected login does **not** silently switch to another account. The view labels the source and shows identity when available.

The Claude Code path inspects the stored **subscription**, not API billing: API-key, API-endpoint, profile, and third-party backend environment overrides are removed from the usage-only child. `CLAUDE_CONFIG_DIR` and an explicit `CLAUDE_CODE_OAUTH_TOKEN` remain respected; an inference-only token results in an unavailable state rather than a hidden account switch.

The Agent SDK opens a short-lived Claude Code process in an empty temporary directory. It sends **no prompt**, enables no tools or MCP servers, disables ordinary hooks/settings, does not persist a conversation, and requests `skipBehaviors: true` to avoid scanning local transcripts. Claude Code's managed policies still apply. The process is closed and the temporary directory removed on success, failure, cancellation, or timeout. Credential refresh remains owned by Claude Code.

Keep npm optional dependencies enabled: the Agent SDK supplies a platform-specific Claude Code binary. No separately installed CLI executable is required to read an existing login. The SDK is loaded lazily, only for this auth path.

## Commands and controls

| Command / key | Action |
| --- | --- |
| `/usage` | Fetch all supported providers |
| `/usage openai` | Fetch only OpenAI |
| `/usage claude` | Fetch only Claude subscription usage |
| `/usage anthropic` | Alias for `/usage claude` |
| `r` | Fetch a fresh snapshot |
| Up / Down | Scroll |
| Page Up / Page Down | Scroll a page |
| Enter / Escape / `q` | Close; cancel pending work |

The terminal view is an overlay. RPC clients receive the same information as a notification; run the command again to refresh. Print/JSON mode has no account-usage UI. Nothing is sent to the model or appended to session history.

The view includes:

- Account identity when available, plan when reported, credential source, and fetch time.
- OpenAI usage windows returned by the server, including five-hour, weekly, and additional model limits when present.
- Claude's **Current session (5h)**, **Current week (all models)**, and **Current week (Fable)**, plus other model-specific weekly limits when reported.
- Local reset date/time and a relative duration.
- Credit balance or unlimited-credit status when reported. Balances are not assumed to be dollars.
- Links to [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) and [Claude Settings → Usage](https://claude.ai/settings/usage).

Primary does **not** necessarily mean five-hour: some plans only report a weekly window. Labels follow the server's window duration. Missing/null values are shown as unknown, not zero usage or unlimited allowance. Expired reset timestamps prompt a refresh rather than inventing a replenished quota. Failed refreshes clear the previous snapshot.

Requests happen only when opening or refreshing the view, with no extension background polling or retry loop. Claude Code manages its own authentication/network behavior. A 15-second overall timeout bounds the wait, including auth resolution and SDK startup; closing the view cancels the usage request or SDK process. Pi may finish its own already-started credential refresh independently. One failed provider does not suppress other providers.

Claude's model-specific weekly limits are read from the SDK's `model_scoped` rows or the endpoint's `limits[]` rows—not an assumed `seven_day_fable` field. Missing Fable data remains **Not reported**, never 0% used. App/surface-specific caps and local behavior estimates are deliberately excluded.

## Implementation and extension points

```text
index.ts                 Command registration and mode handling
src/types.ts             Provider-neutral snapshots, windows, groups and errors
src/service.ts           Independent provider collection, cancellation and timeouts
src/providers/index.ts   Adapter registration
src/providers/openai.ts  Pi auth + Codex usage adapter and normalization
src/providers/claude.ts  Claude auth selection + native Pi OAuth HTTP adapter
src/providers/claude-code.ts  Claude Agent SDK usage-only connection
src/providers/claude-normalize.ts  Native/SDK quota normalization
src/format.ts            Shared text presentation
src/view.ts              Pi TUI overlay, refresh and scrolling
```

To add a provider:

1. Implement `UsageProvider` from `src/types.ts`.
2. Resolve credentials through Pi or the provider's own SDK and return a normalized `UsageSnapshot`. Set a window's `display: "used"` for Claude-style bars; the default is percent remaining.
3. Use `UsageError` for safe, actionable error messages. Never include tokens, raw auth errors, or response bodies.
4. Add the adapter to `createUsageProviders()` in `src/providers/index.ts` and add fixture-based tests.

No changes to the command or view should be needed. Other extensions are not dynamically discovered as usage plugins in this first version.

### SDKs and endpoint stability

- **Pi SDK:** provider authentication and refresh; commands and UI.
- **OpenAI and Anthropic JavaScript SDKs:** HTTP transport, error classification, timeouts and cancellation.
- **Claude Agent SDK:** Claude Code credential management and the structured usage control request. Version **0.3.310 is pinned** because `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` is explicitly experimental; the integration is isolated in one file.
- **jose:** decode account claims for routing/display (the server validates the bearer token).
- **Zod:** validate and normalize the usage response.

The direct adapters use the API SDKs' generic `get()` methods: OpenAI reads `GET https://chatgpt.com/backend-api/wham/usage`, as used by [Codex's backend client](https://github.com/openai/codex/tree/main/codex-rs/backend-client); native Anthropic OAuth reads `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`. An optional `/api/oauth/profile` request supplies native Claude account identity. These are **not stable public billing APIs** and may change. The Claude Code path uses the Agent SDK control API instead of duplicating its auth/storage integration.

The direct adapters send credentials only to fixed provider endpoints; redirects and SDK logging are disabled. Account metadata is escaped for terminal display. The extension writes no token or usage cache. Pi and Claude Code may update their own original credential stores during refresh.

## Develop

Run from the repository root:

```sh
npm install --ignore-scripts
npm run check --workspace @nothumanwork/pi-usage
npm test --workspace @nothumanwork/pi-usage
npm pack --workspace @nothumanwork/pi-usage --dry-run
```

Automated tests mock the network, credentials, and Claude Code process. They exercise the real API SDK transports and Pi extension loader, and cover both Claude auth paths, native/SDK quota schemas, account selection, used/remaining bars, errors, cancellation and process cleanup, multiple providers, narrow terminals, refresh, and scrolling. They do not make model requests or access a real account. Claude Code's usage-only SDK path has also been smoke-tested locally against a real subscription without any model requests.
