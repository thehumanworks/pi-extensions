# Pi Usage

Account usage limits in Pi, starting with **OpenAI ChatGPT via the Codex login**.

Run `/usage` for a scrollable view of the account, plan, percentage remaining, reset times, and credits reported by OpenAI. Bars fill with **remaining** allowance, as in Codex—not tokens consumed in the current Pi session.

## Install

From this checkout, after installing dependencies at the repository root:

```sh
pi install /path/to/pi-extensions/pi-usage
```

Then restart Pi or run `/reload`. For a one-session preview:

```sh
pi -e /path/to/pi-extensions/pi-usage/index.ts
```

After publication:

```sh
pi install npm:@nothumanwork/pi-usage
```

Requires Pi 1.4.0's extension/auth APIs and Node.js 22.19+. No background polling, configuration file, or model tool is installed.

## Sign in

Keep using **`/login openai` → Sign in with ChatGPT** for inference. Add the separate credential used by Codex to read usage:

```text
/login openai-codex
/usage
```

Choose the **same ChatGPT account/workspace** for both logins. The usage view displays the account belonging to the Codex credential; it does not automatically verify that it matches your inference account. Signing into the Codex provider does not require changing your selected model.

Pi owns credential storage, refresh, and refresh-token locking. This extension does not create another OAuth client, copy tokens, read `~/.codex/auth.json`, or use browser cookies. An API key is not a fallback.

### Why the second login?

The newer Sign in with ChatGPT token-sharing login does not currently expose Codex-style account usage. Its token is not accepted by Codex's usage endpoint. See [OpenAI issue #54219](https://github.com/openai/codex/issues/54219) and [OpenAI's errors and recovery guide](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

This extension reads **account allowance through Codex**. It deliberately **does not include Pi-specific app caps** on the newer login. An app-specific cap can therefore block Pi even when the account view shows allowance remaining. No allowance is inferred from session token counts or token expiry.

## Commands and controls

| Command / key | Action |
| --- | --- |
| `/usage` | Fetch all supported providers |
| `/usage openai` | Fetch only OpenAI |
| `r` | Fetch a fresh snapshot |
| Up / Down | Scroll |
| Page Up / Page Down | Scroll a page |
| Enter / Escape / `q` | Close; cancel pending work |

The terminal view is an overlay. RPC clients receive the same information as a notification; run the command again to refresh. Print/JSON mode has no account-usage UI. Nothing is sent to the model or appended to session history.

The view includes:

- Codex account identity, plan, source, and fetch time.
- Usage windows returned by the server, including five-hour, weekly, and additional model limits when present.
- Local reset date/time and a relative duration.
- Credit balance or unlimited-credit status when reported. Balances are not assumed to be dollars.
- A link to [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

Primary does **not** necessarily mean five-hour: some plans only report a weekly window. Labels follow the server's window duration. Missing/null values are shown as unknown, not zero usage or unlimited allowance. Expired reset timestamps prompt a refresh rather than inventing a replenished quota. Failed refreshes clear the previous snapshot.

Requests happen only when opening or refreshing the view, with no automatic retries. A 15-second overall timeout bounds the wait, including auth resolution; closing the view cancels the usage request. Pi may finish its own already-started credential refresh independently. One failed provider does not suppress other providers.

## Implementation and extension points

```text
index.ts                 Command registration and mode handling
src/types.ts             Provider-neutral snapshots, windows, groups and errors
src/service.ts           Independent provider collection, cancellation and timeouts
src/providers/index.ts   Adapter registration
src/providers/openai.ts  Pi auth + Codex usage adapter and normalization
src/format.ts            Shared text presentation
src/view.ts              Pi TUI overlay, refresh and scrolling
```

To add a provider:

1. Implement `UsageProvider` from `src/types.ts`.
2. Resolve credentials through Pi and return a normalized `UsageSnapshot`.
3. Use `UsageError` for safe, actionable error messages. Never include tokens, raw auth errors, or response bodies.
4. Add the adapter to `createUsageProviders()` in `src/providers/index.ts` and add fixture-based tests.

No changes to the command or view should be needed. Other extensions are not dynamically discovered as usage plugins in this first version.

### SDKs and endpoint stability

- **Pi SDK:** provider authentication and refresh; commands and UI.
- **OpenAI JavaScript SDK:** HTTP transport, error classification, timeouts and cancellation.
- **jose:** decode account claims for routing/display (the server validates the bearer token).
- **Zod:** validate and normalize the usage response.

The adapter uses the SDK's generic `get()` method because there is no typed JavaScript SDK quota method. It reads `GET https://chatgpt.com/backend-api/wham/usage`, the internal endpoint used by [Codex's backend client](https://github.com/openai/codex/tree/main/codex-rs/backend-client). This is **not a stable public billing API** and may change. The adapter is isolated for that reason.

Credentials are sent only to the fixed ChatGPT endpoint. Redirects and SDK logging are disabled. Requests do not use API billing organization/project settings. Account metadata is escaped for terminal display. No token or usage cache is written to disk.

## Develop

Run from the repository root:

```sh
npm install --ignore-scripts
npm run check --workspace @nothumanwork/pi-usage
npm test --workspace @nothumanwork/pi-usage
npm pack --workspace @nothumanwork/pi-usage --dry-run
```

Tests mock the network and credentials, exercise the real OpenAI SDK transport and Pi extension loader, and cover normalization, errors, cancellation, multiple providers, narrow terminals, refresh, and scrolling. They do not consume a ChatGPT allowance or verify a real account's live quota.
