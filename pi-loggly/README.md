# Pi Loggly

**Loggly log analysis in Pi: agent tools, a health dashboard, and a status line that says when something changes.**

- **Tools** let the agent search, count, chart, facet and cluster logs, and check the health of every system.
- **`/loggly`** opens a dashboard with overall health, pressing issues, a table of every system with trends, and a drill-in for each system's dominant error messages.
- **`/loggly status on`** adds a status line to the current session, on its own row just above Pi's footer, such as `● loggly healthy · 143 systems` or `✖ loggly 1 critical │ checkout errors ×12: 640 in 10m, usually 50 “db timeout after <n>s”`, refreshed in the background. New critical issues raise a notification. It is off by default, so only the sessions you choose poll Loggly.
- **`/loggly report last 2h`** writes a report for any timeframe in words, as HTML, PDF and Markdown: what changed, when errors peaked, which systems and messages drove them.
- **Daily trends** are saved on this machine, so error and volume trends outlive Loggly's retention.
- **`@nothumanwork/pi-loggly/sdk`** is a typed TypeScript client for Loggly's retrieval APIs, usable without Pi.

## Install

From this checkout, after installing dependencies at the repository root:

```sh
pi install /path/to/pi-extensions/pi-loggly
```

Then restart Pi or run `/reload`. For a one-session preview:

```sh
pi -e /path/to/pi-extensions/pi-loggly/index.ts
```

Published releases:

```sh
pi install npm:@nothumanwork/pi-loggly
```

Requires Pi 1.4.0 and Node.js 22.19+.

## Credentials

Set two environment variables before starting Pi:

| Variable | Value |
| --- | --- |
| `LOGGLY_SUBDOMAIN` | Your account label: `acme` for `acme.loggly.com` |
| `LOGGLY_API_TOKEN` | An **API token** from Loggly *Settings → API Tokens*. Customer (ingestion) tokens cannot read logs. |

With [dotenvx](https://dotenvx.com), keep them in an encrypted `.env` and run `dotenvx run -- pi`. The token is sent only as a bearer header to `https://<subdomain>.loggly.com`; redirects are never followed.

## Dashboard

`/loggly` opens a full-screen dashboard:

- **Pressing issues**: error spikes, new errors and quiet systems in the latest window, most severe first, each with its dominant error message.
- **Ongoing**: chronic error rates and recurring bursts. They are real problems but not new, so they never turn the status line red.
- **Systems**: every system's errors now and usually, the ratio, error rate, event count, and a trend over the checked windows. The trend shows errors, or volume for quiet systems.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` | Select a system |
| `Enter` or `→` | Details: error and volume trends, daily errors from saved trends, error patterns from a sample of recent errors, the reproducing query, and a link to open it in Loggly |
| `i` | Put an investigation prompt for the selected system in the editor; send it to have the agent dig in with the tools |
| `m` | Mute or unmute the system (saved in the configuration) |
| `s` | Turn the status line on or off for this session |
| `r` | Refresh now (in details: resample errors) |
| `Esc`, `q` | Back or close |

In RPC and other non-TUI modes, `/loggly` prints the same report as text. `/loggly refresh` runs a check, `/loggly trends [every <days> | off]` saves daily trends now or on a schedule, `/loggly report [timeframe]` writes a report (see below), and `/loggly config` shows the active configuration and any problems in it.

## How health is judged

Every check splits recent time into windows (default: 10 minutes, ending 2 minutes ago to allow for indexing), and compares the latest with the median of the 12 before it (2 hours). Systems are the values of one field (`health.groupBy`). Two facet queries per window count errors and events for every system at once. Loggly matches a quoted value word by word, so a query for one system, such as a search link, leaves out other systems whose names contain all its words: `data` would otherwise also find `data-extraction-worker`. A check costs about 30 Loggly requests however many systems there are: 26 facets, one for volume since the window, and a sample of errors for up to three issues.

| Issue | Severity | Raised when |
| --- | --- | --- |
| Error spike | warning; critical at ×10 | Errors are at least ×3 the usual rate and at least 50 above it |
| New errors | warning; critical from 250 | A system that usually logs no errors logs at least 50 |
| Quiet system | warning; critical when no events at all, or quiet for two windows | A system usually logging 200+ events per window logs under 10% of that and has not resumed since |
| Ingestion drop | critical | Total volume across all systems halves (often an ingestion or indexing delay) |
| Recurring bursts | notice | A spike that matched a burst earlier in the baseline, such as an hourly job that fails |
| Chronic error rate | notice | 25% or more of a system's events are errors |

Messages are grouped by masking IDs, numbers, UUIDs, emails, IPs, timestamps, query strings and JSON payloads. Notifications fire once per new critical issue, not on every refresh.

The status line has its own row between the editor and Pi's footer, rather than sharing the footer's single row of extension statuses, so other extensions cannot push it out of sight. On a narrow pane it is cut at the pane's width; the overall verdict comes first, so `✖ loggly 1 critical · 2 warnings` stays visible at 40 columns. It never wraps, so rotating issues do not move the editor.

The status line only runs while Pi is open. It is a lens for whoever is working, not a replacement for paging. For durable alerting, ask the agent for a query and threshold, then create a Loggly alert from it.

Each session with the status line on runs its own checks, 27 facet queries and up to 3 small searches every `refreshSeconds`. `/loggly status on` and `off` apply only to the current session; a new, resumed or reloaded session starts from `statusLine.enabled`, which is off unless you change it. Sessions share nothing, so turn it on in one session to keep the load down.

## Daily trends

Loggly keeps logs for a limited period (30 days on many plans). pi-loggly saves a small summary of each complete UTC day so trends last longer:

- errors and events for each system: the 300 largest by events and the 300 largest by errors
- total errors and events
- the most frequent error messages, grouped by pattern, with one example each
- estimated patterns of the remaining errors, with 95% intervals (see below)

These counts are true totals, not estimates from a sample. Raw logs are never stored. The counts cost three requests a day and take a few seconds; with pattern estimates a day takes about 2 minutes and 320 requests. A day's file is 30–45 KB, about 8 KB of it estimated patterns: roughly 15 MB a year.

Message counts are partial. Loggly counts a field's values with a facet query, which returns at most 300 values and treats each distinct string as its own value; patterns are formed afterwards, on this machine. So a day's messages cover:

- only errors with a message field (the first of `health.messageFields`). Plain-text log lines have none and are not counted.
- only the 300 most frequent exact messages. Messages carrying IDs or URLs are each distinct, so they rarely make the list.

The report shows the share of errors covered, typically 40–70%.

### Estimated patterns

The errors those messages leave out are often the interesting ones: plain-text lines, stack traces, and messages carrying IDs. Their patterns are estimated from a sample, and labelled as estimates:

- **how**: the day is cut into 288 equal slices (`trends.sampleWindows`), each with one short window at a random time, sized to hold about 60 errors. Every error has the same chance of falling in a window, so the errors found, scaled up, estimate the day's without bias. A window holding more than a page of errors is counted, and a random stretch of it is sampled the same way.
- **what is stated**: only patterns seen in at least 10 windows with a relative standard error of at most 30%, each with a 95% interval. Growth is listed only when it exceeds the sampling error of both periods.
- **checks**: the same sample also estimates counts Loggly knows exactly (errors per system, and the listed messages). The report says how many of those intervals held the exact count, about 95% if the estimates are sound, and whether the sample's estimate of the remaining errors held their exact number.
- **limits**: a pattern that comes in a few dense minutes is missed, or seen in too few windows to state. The report says how much of the remainder the stated patterns account for, typically about half.

Tested against Loggly's exact counts on two days of about 1.5 million errors each, 47 of 47 intervals held the exact count. On one of the two days the sample's estimate of the remaining errors fell short of their exact number: bursts of rare errors that no window hit.

Days are saved:

- **with `/loggly trends`**: saves every missing day in the background, shows progress in the footer and reports when done. It also saves again the days Loggly still keeps that were saved with other settings, or without pattern estimates while they are on; their earlier files move to `replaced/`, never deleted. A first run with pattern estimates takes about an hour for 30 days, or a few minutes without.
- **on a schedule**: `/loggly trends every 7` saves at Pi start whenever 7 or more complete days are waiting, and reports what it saved. Pi start only reads the trends directory; Loggly is asked only when days are due. `/loggly trends off` stops it. Typing `/loggly trends` suggests a value: a quarter of Loggly's retention (7 for 30 days), alongside any current schedule. The setting is `trends.saveEveryDays`. Keep it well under Loggly's retention to allow for days Pi is not opened; pi-loggly warns when it is too long.
- **while the status line is on**: at the start and then hourly, a session saves any missing complete day Loggly still keeps. Checks make no requests when nothing is missing. These saves are unannounced, so they keep to exact counts; `/loggly trends` adds pattern estimates later. Days saved earlier are left as they are; only `/loggly trends` saves days again.

A day not saved before Loggly deletes it is lost, and reports list it as not saved. One process saves at a time, using a lock file next to the data.

Files live in `$XDG_DATA_HOME/pi-loggly/trends` (normally `~/.local/share/pi-loggly/trends`), one JSON file per day, readable only by you. Message examples are log text, so treat the directory like logs. Delete files to forget days.

Each day records the `health.scope`, `health.groupBy` and `health.errorQuery` it was saved with. Reports only compare days saved with the current settings, so changing them starts a new series; `/loggly trends` then saves the days Loggly still keeps again with the new settings. The `loggly_trends` tool and the dashboard read these files without contacting Loggly.

## Reports

`/loggly report <timeframe>` writes a report on what happened in Loggly over a timeframe written in words. Without one it covers the last 24 hours. It runs in the background, shows its progress in the footer, and sends a notification with the file paths when done: about 25 seconds for 2 hours, 35 for a week.

| Timeframe | Covers | Compared with |
|---|---|---|
| `last 2h`, `past 90 minutes`, `last 7 days`, `last week` | that length, up to the newest indexed minute | the same length just before |
| `today`, `since 9am`, `since monday`, `this week` | from that point until now, in local time | the same hours a day earlier when under a day, otherwise the same length before |
| `yesterday`, `monday`, `2026-10-28` | that whole local day | the day before |
| `2026-10-28 09:00 to 12:00`, `yesterday 9am to 5pm` | that range | the same hours a day earlier |

Quotes are ignored, so `/loggly report 'last 2h'` works. Typing `/loggly report` suggests timeframes. Times older than Loggly's retention are left out, and the report says so.

Each report has:

- **a verdict and summary**: totals, the change from the comparison period, the error peak and the system behind most errors.
- **findings**, most pressing first: systems that stopped logging or went quiet, started logging errors, grew errors (×3 or more), had a burst, or improved; error messages new since the comparison period; and, as notices, recurring bursts and systems whose events are mostly errors. Each links to the matching search in Loggly.
- **charts** of errors over time by the systems with most errors, against the comparison period's average, and of events over time.
- **a systems table** with errors, change, events, error rate and a trend line for each.
- **error messages**: exact counts of the most frequent messages, grouped by pattern.
- **error patterns**: every error grouped by pattern, estimated from a sample taken across the timeframe. This covers what the exact counts miss: errors with no message field, such as plain-text lines and stack traces, and rare variants.

A report splits its timeframe into up to 30 periods and costs about three requests per period. The thresholds come from the `health` settings. The error minimum (`health.minErrors`, set for 10-minute windows) grows with the square root of the timeframe: 173 for 2 hours, about 1,600 for a week. A week of small blips therefore doesn't bury the real changes.

Reports are saved in `$XDG_DATA_HOME/pi-loggly/reports` (normally `~/.local/share/pi-loggly/reports`), one directory per report with `report.html`, `report.pdf` and `report.md`, readable only by you. They contain log text and are never deleted automatically. The PDF is printed by a headless Chromium, Chrome, Edge or Brave found on `PATH`; set `PI_LOGGLY_BROWSER` to use another. Without a browser you still get HTML and Markdown, and the notification says why there is no PDF. The HTML is self-contained, with no scripts or outside resources.

## Configuration

Optional. Settings live in `loggly.json` in Pi's agent directory (normally `~/.pi/agent/loggly.json`). Invalid settings are reported once per session and fall back to their defaults. Muting and `/loggly trends every|off` update this file and keep any other keys.

```json
{
  "statusLine": { "enabled": true, "refreshSeconds": 300, "rotateSeconds": 8, "notify": true },
  "health": {
    "scope": "derived.Environment:(prod OR live)",
    "groupBy": "derived.AppName",
    "errorQuery": "json.level:(error OR fatal) OR syslog.severity:(Error OR Critical OR Alert OR Emergency)",
    "messageFields": ["json.message", "json.msg"],
    "muted": ["noisy-legacy-service"]
  },
  "tools": { "exposure": "direct" }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `statusLine.enabled` | `false` | Start every session with the status line on, polling in the background and saving daily trends |
| `statusLine.refreshSeconds` | `300` | Seconds between checks (minimum 30) |
| `statusLine.rotateSeconds` | `8` | Seconds each pressing issue is shown when there are several |
| `statusLine.notify` | `true` | Notify when a new critical issue appears |
| `health.scope` | `*` | Query that limits every check, such as production only |
| `health.groupBy` | `syslog.appName` | Field whose values are the systems. Use `tag`, a JSON field or a derived field if that suits your account better |
| `health.errorQuery` | syslog Error and above, `json.level` error/fatal/critical, `json.logLevel` ERROR/FATAL | Query matching error events. Field values match case-insensitively |
| `health.messageFields` | `["json.message", "json.msg"]` | Fields tried for each error's message; the raw log line is the fallback |
| `health.window`, `health.baselineWindows`, `health.lag` | `10m`, `12`, `2m` | Window length, number of baseline windows, and indexing allowance |
| `health.spikeRatio`, `health.criticalRatio`, `health.minErrors` | `3`, `10`, `50` | Spike thresholds |
| `health.silentMinBaseline`, `health.silentRatio` | `200`, `0.1` | Quiet-system thresholds |
| `health.chronicErrorRate` | `0.25` | Chronic notice threshold |
| `health.sampleSize`, `health.sampleIssues` | `200`, `3` | Errors sampled per issue, and issues sampled per check |
| `health.maxSystems` | `300` | Systems tracked per window (Loggly's facet limit) |
| `health.muted` | `[]` | Systems shown but never raised as issues |
| `trends.saveEveryDays` | `0` (off) | At Pi start, save daily trends when this many complete days are waiting. Set with `/loggly trends every <days>` |
| `trends.sampleWindows` | `288` | Random windows per day for estimated patterns, about one request each (20–1440). `0` saves exact counts only |
| `tools.exposure` | `direct` | `codemode` keeps the tools out of the model's direct tool list and exposes them to code mode only |

Run `loggly_facet` without a field, or `/loggly config`, to find field names in your account.

## Agent tools

All tools are read-only and share the `loggly` namespace. Its guidance tells the model that log content is untrusted data, and must never be followed as instructions.

| Tool | Purpose |
| --- | --- |
| `loggly_health` | Health of every system, or details for one, from the shared snapshot |
| `loggly_search` | Matching events with time, level, system and message; optional extra fields or full events |
| `loggly_count` | Counts (and optionally bytes) for up to 10 queries |
| `loggly_timeline` | Counts in equal time buckets, optionally split by a field's top values |
| `loggly_facet` | Top values of a field with counts and shares, or the fields present |
| `loggly_patterns` | Error messages grouped by pattern, with estimated totals and affected systems |
| `loggly_trends` | Saved daily trends: top and fastest-growing systems and messages, messages first seen recently, estimated patterns of the other errors, or one system's or message's days |

Times accept Loggly's relative syntax (`-15m`, `-2h`, `-1d`, `now`) or ISO 8601. When `loggly_search` output is truncated, or `full` is set, the complete events are written to a JSON-lines file readable only by you, in a private directory under `/tmp`. These files hold log data, so they are deleted after a day.

## SDK

```ts
import { LogglyClient } from "@nothumanwork/pi-loggly/sdk";

const loggly = LogglyClient.fromEnv(); // LOGGLY_SUBDOMAIN, LOGGLY_API_TOKEN
const { count } = await loggly.count({ query: "json.level:error", from: "-1h" });
const byApp = await loggly.facet("syslog.appName", { query: "json.level:error", from: "-1h", size: 20 });
for await (const event of loggly.events({ query: "tag:checkout", from: "-15m" }, { limit: 500 })) {
  console.log(new Date(event.timestamp).toISOString(), event.logmsg);
}
```

The client uses Loggly's paginated `/apiv2/events/iterate` API. Continuation URLs must stay on the same host and path over HTTPS, and pages are fetched lazily. Iteration cursors expire ten minutes after the previous page. Other methods cover `/apiv2/events/count`, `/apiv2/fields`, `/apiv2/volume-metrics` and `/apiv2/customer`. Customer tokens are never returned. Facet results set `truncated` when more values may exist than were returned; Loggly caps its distinct count at the requested size, so a full list counts as truncated.

Requests time out after 60 seconds and are retried on HTTP 429, 502, 503, 504 and network failures, honouring `Retry-After`. Errors are typed (`LogglyAuthenticationError`, `LogglyPermissionError`, `LogglyRateLimitError`, `LogglyApiError`, `LogglyTransportError`, …), and their messages never include response bodies. Loggly reports malformed queries as a generic HTTP 500, so a 500 is not retried unless it mentions a timeout.

## Development

```sh
npm run check --workspace @nothumanwork/pi-loggly
npm test --workspace @nothumanwork/pi-loggly
```

Tests mock `fetch` and make no network requests.
