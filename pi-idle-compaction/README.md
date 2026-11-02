# pi-idle-compaction

Idle compaction for [Pi](https://github.com/earendil-works/pi), modelled on Claude Code's idle compaction ([v2.1.314](https://github.com/anthropics/claude-code/releases/tag/v2.1.314): "a 200K+ token conversation left idle is summarized, and the summary is used on your next message if the prompt cache has expired").

Providers cache the prompt prefix only for a few minutes after the last request. If you leave a long conversation and come back later, the next message re-reads the whole history uncached, which is slow and is billed at the full input rate. Once a conversation of at least 150k tokens has sat idle longer than the prompt cache lifetime, this extension compacts it, so your next message re-reads a short summary instead.

When it compacts, Pi shows its usual compaction block, followed by a grey italic line:

```text
Idle compaction: compacted 182,400 tokens after 5 min idle, since the prompt cache had expired.
```

The line is a session entry, so it is still there after a resume. It is never sent to the model.

## Install

```sh
pi install npm:@nothumanwork/pi-idle-compaction
```

The npm command works after the package has been published. From a checkout of this repository, run `npm ci --ignore-scripts` at the root, then `pi install ./pi-idle-compaction`.

It works out of the box, needs no other extension, and has no other prerequisites. It uses the session model and Pi's own compaction (`compaction.keepRecentTokens` and any `session_before_compact` handlers still apply).

## Configuration

The defaults need no settings. To change them, add an `idleCompaction` object to `~/.pi/agent/settings.json` or to a project's `.pi/settings.json`:

```json
{
  "idleCompaction": {
    "enabled": true,
    "tokenThreshold": 150000,
    "idleMinutes": 5
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set to `false`, or set `"idleCompaction": false`, to turn the extension off. |
| `tokenThreshold` | `150000` | Compact only when the context holds at least this many tokens. Claude Code uses 200k. |
| `idleMinutes` | `5` | How long the session must be idle before it compacts. Fractions are allowed, up to 1440. |

The extension reads Pi's settings each time the idle timer starts. An invalid value shows one warning and leaves idle compaction off until it is fixed.

### Why 5 minutes

The idle time should be no shorter than the prompt cache lifetime: compacting earlier throws away a cache that is still warm. The default is the shortest lifetime among the common providers:

| Provider | Prompt cache lifetime |
| --- | --- |
| Anthropic API ([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | 5 minutes by default, refreshed on each hit; 1 hour opt-in (`ttl: "1h"`) |
| Claude Code ([docs](https://code.claude.com/docs/en/prompt-caching)) | Main conversation: 1 hour on a Claude subscription within plan usage; 5 minutes with an API key, usage credits or a cloud provider. Claude Code only idle-compacts on the 1-hour TTL. |
| OpenAI, GPT-5.6 and later ([docs](https://developers.openai.com/api/docs/guides/prompt-caching)) | At least 30 minutes by default (`prompt_cache_options.ttl: "30m"`); `"12h"` opt-in |
| OpenAI, earlier models | `in_memory`: about 5 to 10 minutes of inactivity, up to 1 hour; `24h`: extended retention |

If you only use providers with longer caches, raise `idleMinutes` to match, for example `30` for GPT-5.6+ or `60` for a Claude subscription, so the extension compacts only once the cache has really gone.

## How it works

1. When the agent settles (no retry, compaction or queued message left) or a session starts, an idle timer starts. Starting a new run or ending the session cancels it.
2. When the timer fires, the extension checks that Pi is still idle with nothing queued, and that the context holds at least `tokenThreshold` tokens. It then runs Pi's compaction, which shows the usual progress indicator. Anything you send meanwhile is queued, and Escape cancels the compaction.
3. On success it appends the notice entry. Pi itself reports a failed or cancelled compaction. Each idle period compacts at most once.
4. If Pi's cache warming (`cacheWarming: "idle"`) refreshes the prompt cache while the session is idle, the cache is alive again, so the idle timer restarts. With the default `cacheWarming: "streaming"`, Pi does not warm idle sessions.

Unlike Claude Code, which summarizes in the background and applies the summary only if the cache has expired by your next message, this extension compacts as soon as the idle time has passed. With `idleMinutes` at or above your provider's cache lifetime, the cache has expired by then anyway. The summarization request itself reads the conversation uncached. That is the same cost the next message would otherwise pay, paid once while you are away.

The timer does not keep `pi -p` (print mode) running. In RPC mode the notice is also sent as an `info` notification, because RPC clients do not draw custom entries.
