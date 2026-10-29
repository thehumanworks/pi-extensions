# pi-background-compaction

Background compaction for [Pi](https://github.com/earendil-works/pi). Pi normally pauses a session while it writes the compaction summary, about 30 seconds per compaction on `openai/gpt-6.1-sol` in the evaluation below. This extension writes the summary in the background as the context approaches Pi's compaction threshold, while the session keeps working on its full history. When Pi compacts, the ready summary is swapped in without another model call, and everything that happened since stays verbatim after it. Compaction never waits for a summary: if none is ready, the session keeps going and compacts at a later check, once it is.

```text
70% of the threshold   a summary of the conversation so far starts in the background
                       the session keeps going on its full history; the summary is held
Pi's threshold         Pi compacts: the held summary replaces the history it covers,
                       and every message since it is kept as is
not ready yet          compaction is deferred and the session keeps going; Pi checks
                       again after the next response and compacts once it is ready
```

The design follows Claude's [background compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-background) loop (replace exactly the history the request held, keep later turns after the summary) and OpenCode's [background compaction](https://opencode.ai/v2/docs/compaction/) (start early, hold the summary until compaction is due, fall back when it fell too far behind). Unlike OpenCode, compaction never waits for a summary still being written.

## Install

```sh
pi install npm:@nothumanwork/pi-background-compaction
```

The npm command works after the package has been published. From a checkout of this repository, run `npm ci --ignore-scripts` at the root, then `pi install ./pi-background-compaction`.

**Background compaction is off by default and has no default summarizer model.** Select a concrete model and explicitly enable it:

```text
/bg-compact model claude-bridge/claude-haiku-5-5
/bg-compact on
```

Use an available, authenticated `provider/modelId`. `on` fails without one; `session` and virtual/router models are not accepted. Selecting or changing the model leaves the extension off until another explicit `on`. `/bg-compact` alone shows status and never toggles it.

When enabled, it works with Pi's automatic compaction (`compaction.enabled`, on by default): `compaction.reserveTokens`, `compaction.keepRecentTokens`, and their per-model overrides still decide the threshold and how much recent history stays verbatim. **Turning this extension off does not disable Pi's built-in compaction**, which can still use the session model.

## How it works

1. **Start.** After each model response (`turn_end`) and when the session goes idle, the extension compares the context to Pi's threshold (`contextWindow - reserveTokens`). Past `trigger` of it, it plans the summary exactly as Pi would cut it (the same cut point, verified against Pi's `prepareCompaction`) and sends the request without waiting for it. Only one summary is written at a time. If the newest tool result is too large for the cut to leave it out, the request waits for the next boundary rather than hold a summary that keeps that output verbatim.
2. **Hold.** The finished summary is kept in memory and not applied, so the prompt cache stays valid until compaction is due. If the conversation grows past the staleness bound (OpenCode's `max(2 × keepRecentTokens, 30k)`, at most a quarter of the threshold), the held summary is extended in the background with only the messages since.
3. **Swap.** When Pi compacts (`session_before_compact`, for the threshold, context overflow, or `/compact` without instructions), the extension returns the held summary with the first kept entry it was planned for. Pi appends it like its own compaction. If the summary is still being written, compaction is deferred: the extension cancels Pi's compaction, the session continues on its full history, and Pi checks again after the next response. Pi shows each deferred check as a cancelled compaction. A refresh in flight never delays a held summary that already fits, and no refresh starts at the boundary where Pi is about to compact.
4. **Validate.** A held summary is used only if the session still contains the history it covers: the same latest compaction, its first kept entry on the current branch (not lost to `/tree` or a fork), and no context edits to a summarized message. If swapping it in would leave more than `maxSwapRatio` of the threshold in context, a short catch-up extends it in the background first, and compaction is deferred until it is ready. Once the catch-up has had its chance, or when the context overflows, the held summary is swapped in if it frees room. This prevents a compaction that frees almost nothing ([anthropics/claude-code#70459](https://github.com/anthropics/claude-code/issues/70459)).
5. **Use only the selected model.** Without a usable summary, compaction starts one in the background with the explicitly configured model and prompt, as a transcript request where it can (overflow recovery always uses a serialized one, since the overflowing context cannot be resent), and is deferred until it is ready. A `/compact` with nothing ready says so, then compacts once the summary is ready and the agent is idle. The extension never falls back to the session model or Pi's built-in summarizer: if the selected model is unusable, compaction is cancelled with a warning. Fix the model, or explicitly run `/bg-compact off` to allow Pi's built-in compaction.

### Retries and restarts

Each summary runs as a durable [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) job, stored per session in `~/.pi/agent/background-compaction/`. A failed attempt is retried `retries` times, first after `retryDelayMs`, then doubling up to 8 × `retryDelayMs`; `timeoutMs` bounds each attempt. Failures a retry cannot fix, such as a summary that hits the output limit or a request too large for the summarizer's window, fail at once. After a job fails for good, the next one starts after a backoff of 1 minute, doubling up to 10 minutes. Two failed jobs in a row stop background starts until the next compaction; compaction checks keep deferring and start a summary once the backoff has passed.

A summary still being written, or finished but not yet used, when Pi exits stays stored. The next process to open the session resumes it and uses it only if it still matches the branch. Stored jobs of sessions untouched for 7 days are deleted. Retry timers do not keep Pi running: in print mode (`pi -p`), a retry waiting out its delay runs the next time the session opens.

Summaries keep Pi's `<read-files>` and `<modified-files>` lists, and their usage is recorded on the compaction entry so session totals include it. Summaries that are never used still cost tokens.

### Request styles

- **Transcript** (`request: "auto"` picks it when it can): the conversation exactly as the session model last received it, system prompt and tool declarations included, plus one instruction, with tool calls disabled and the session's cache routing. The provider serves nearly all of it from the prompt cache: in the evaluation, 31.9k of 33.4k input tokens were cache reads. `auto` uses it when the summarizer is the session model on one of pi-ai's built-in provider APIs.
- **Serialized**: Pi's text rendering of the summarized messages with a standalone summarizer prompt, so any model can write it. Each tool result keeps `toolResultChars` characters (Pi keeps 2000). Used for a different summarizer model, for extension providers such as CLI bridges (which may treat a resent conversation as their next turn), and for refreshes and catch-ups.

## Configuration

Add a `backgroundCompaction` object to `~/.pi/agent/settings.json` or a project's `.pi/settings.json`. Enabling requires both `enabled: true` and an explicit `model`. Other keys are optional; each also has a `PI_BACKGROUND_COMPACTION_*` environment override (for example `PI_BACKGROUND_COMPACTION_TRIGGER=0.6`), except `enabled`, which uses `PI_BACKGROUND_COMPACTION`. Prompt and focus text values accept `@path/to/file` to read a file.

Command choices override environment and file settings **for the current session**, survive reload/resume, and do not change global or project settings. `/tree` does not undo an explicit `off`. For new sessions, precedence is environment → project settings → global settings → defaults.

```json
{
  "backgroundCompaction": {
    "enabled": true,
    "trigger": 0.7,
    "model": "claude-bridge/claude-haiku-5-5"
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in; requires a configured compaction model. Environment: `PI_BACKGROUND_COMPACTION=1` or `0`. |
| `trigger` | `0.7` | Fraction of Pi's compaction threshold at which the background summary starts. Lower gives a slow summary more time to finish before compaction is due, at the cost of an older summary and occasional refreshes. |
| `minTokens` | `16000` | Smaller contexts are not summarized in the background. |
| `model` | none | Required concrete summarizer as `provider/modelId`. Environment: `PI_BACKGROUND_COMPACTION_MODEL`. No implicit session model or fallback; unavailable, unauthenticated, and virtual models cannot be enabled. |
| `thinking` | `session` | Summarizer thinking level: `session`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Transcript requests keep the session's level so cached prefixes stay valid. |
| `request` | `auto` | `transcript`, `serialized`, or `auto`. |
| `prompt` | `coding` | Prompt preset: `coding` (structured checkpoint for coding agents) or `pi` (Pi's built-in prompts). |
| `systemPrompt`, `instructions`, `updateInstructions`, `transcriptInstructions` | preset | Replace parts of the preset: the summarizer system prompt, the first summary, merging into a previous summary, and the transcript instruction. |
| `focus` | none | Extra instructions appended to every summary request, like `/compact` instructions. |
| `keepRecentTokens` | Pi's | Recent history kept verbatim when a background summary is planned. |
| `maxStaleTokens` | `max(2 × keep, 30000)`, at most ¼ of the threshold | Growth after which a held summary is refreshed in the background. |
| `maxSwapRatio` | `0.5` | Largest share of the threshold a swap may leave in context before it is caught up first. |
| `toolResultChars` | `16000` | Characters of each tool result kept in serialized requests. |
| `maxTokens` | model limit, at most 65536 | Output cap for one summary, thinking included. |
| `timeoutMs` | `300000` | Abort one attempt at a summary after this long; it is retried. |
| `retries` | `2` | Retries after a failed attempt, 0 to 10. |
| `retryDelayMs` | `10000` | Delay before the first retry; later retries double it, up to 8 times. |

`PI_BACKGROUND_COMPACTION_TRACE=/path/file.jsonl` appends one JSON line per event, with timings and token counts: `start` (its `reason` tells a refresh, catch-up or compaction-time summary from a trigger), `ready`, `deferred`, `swap`, `retry`, `failed`, `cancelled`, `discarded`, `postponed`, `restored` and `resumed` after a restart, and `jobs` for storage errors.

## Commands and status

- `/bg-compact` or `/bg-compact status`: show on/off state, the explicit model, limits, settings, and counters. Never toggles anything.
- `/bg-compact model <provider/modelId>`: select a summarizer for this session, cancel pending work, and leave compaction off. Model IDs have tab completion. `/bg-compact model` shows the selection without changing it.
- `/bg-compact on`: enable only after the model is explicitly set, available, and authenticated. The confirmation names the model and warns that summaries incur usage even if not applied.
- `/bg-compact off`: disable, abort pending summaries and their retries, and discard held summaries. Pi's built-in compaction is unchanged. Requests already sent may still incur provider charges.
- `/bg-compact start`: write a background summary now, regardless of the trigger, **only if already on**.
- `/bg-compact cancel`: cancel pending work and drop the held summary without disabling future background work. Use `off` to disable it.

The footer shows `compact: off` when disabled. When enabled it always includes the concrete model, even while idle: `compact: idle provider/modelId`, `compact: writing provider/modelId`, or `compact: ready provider/modelId`. Startup also announces the model when enabled by settings or restored session controls.

## Evaluation

The `eval/` directory (not published) holds the harness used to choose the summarization defaults. The evaluation explicitly enables the extension with a named model; references to “defaults” below describe summarization parameters, not automatic activation. It uses two coding scenarios, a bookkeeping CLI and a JSON API, with 12 scripted user turns each. Facts are planted in user rules, decisions, corrections, long documents, logs, and data files. Each was recorded three times with `openai/gpt-6.1-sol` and compaction off, giving six real sessions of 46k to 61k tokens.

The replay runs the production `BackgroundCompactor` over each recorded session on the session's own clock. A background summary becomes ready its measured latency after it starts, so deferrals reflect the original pace. Past the threshold, every turn boundary is a compaction check until one swaps. At Pi's threshold, the session model is asked two things from the compacted context, without tools:

- 19 questions about earlier facts (context awareness).
- Code that depends on rules from early in the session, checked statically (output quality).

Thresholds sit just under each session's size after turn 10, with `keepRecentTokens` 8000. The score weights probes 0.7 and task 0.3. Each configuration ran twice per session (n = 12); ± is the standard error.

Final code, normal pace:

| Configuration | Score | Probes | Task | Blocked at compaction | Context after | Summary cost |
| --- | --- | --- | --- | --- | --- | --- |
| No compaction (upper bound) | 0.961 ± 0.004 | 0.974 | 0.931 | n/a | 50.2k | n/a |
| **This extension, defaults** | **0.982 ± 0.006** | 0.974 | 1.000 | **0 s** | 18.8k | $0.020 |
| This extension, `request: "serialized"` | 0.973 ± 0.008 | 0.974 | 0.972 | 0 s | 18.4k | $0.040 |
| Pi built-in compaction | 0.923 ± 0.011 | 0.890 | 1.000 | 31.6 s | 10.9k | $0.025 |
| Recent history only, no summary (lower bound) | 0.602 ± 0.017 | 0.526 | 0.778 | n/a | 9.5k | n/a |

Compaction no longer waits for a summary that is still being written. Re-run on this release, the defaults scored 0.979 ± 0.005 and `request: "serialized"` 0.976 ± 0.006 (n = 12), neither deferring a compaction. To force late summaries, `trigger: 0.97` starts them just before the threshold. There the earlier, waiting release blocked the session 19.6 s on average and 34.3 s at most (0.967 ± 0.006, n = 24). This release blocked 0 s and compacted 27 s later on average, at most 40 s and 2.1k tokens past the threshold (0.970 ± 0.005, n = 24).

A burst stress test compacts the bookkeeping sessions right after a single 15k-token tool result, at a 45k threshold (n = 6):

| Configuration | Score | Probes | Blocked |
| --- | --- | --- | --- |
| This extension, defaults | 0.906 ± 0.020 | 0.877 | 0 s |
| This extension, `request: "serialized"` | 0.951 ± 0.008 | 0.930 | 0 s |
| Pi built-in compaction | 0.820 ± 0.014 | 0.754 | 34.5 s |

End to end in Pi's runtime (`eval/live.mts`), the scripted sessions ran with real compaction at a 40k (bookkeeping) or 36k (API) threshold, twice per arm. Every compaction with the extension blocked for under 5 ms; Pi's built-in compaction blocked for 23 to 31 s each time. Transcript requests read 31.6k of about 32k input tokens from the prompt cache. With the extension, the bookkeeping runs compacted twice instead of once, because the swaps keep a longer verbatim tail.

| Scenario | Arm | Compactions | Blocked | Probes | Task |
| --- | --- | --- | --- | --- | --- |
| Bookkeeping | extension | 2, 2 | 0 s, 0 s | 0.89, 0.95 | 1.00, 0.83 |
| Bookkeeping | Pi | 1, 1 | 28.0 s, 31.3 s | 0.95, 0.89 | 1.00, 1.00 |
| API | extension | 1, 1 | 0 s, 0 s | 1.00, 1.00 | 1.00, 0.83 |
| API | Pi | 1, 1 | 23.0 s, 23.2 s | 1.00, 0.95 | 1.00, 1.00 |

How the defaults were chosen (one factor at a time from a baseline, n = 12 unless noted). These rounds ran on the earlier release, where compaction waited for a summary still being written:

| Parameter | Tried | Result |
| --- | --- | --- |
| Request style | serialized, transcript | Transcript 0.974 vs serialized 0.939. Transcript sees long tool output in full; serialized with Pi's 2000-character cut recovered none of the facts found only there. |
| Tool result characters (serialized) | 2000, 4000, 8000, 16000, 32000 | 0.939, 0.932, 0.938, 0.970, 0.972. The knee is at 16000, which covers the documents read in these sessions. |
| Prompt | `pi`, `coding` | `coding` was better by 0.013 serialized and 0.032 in transcript mode (0.942 with Pi's prompt). |
| Summarizer model | session `gpt-6.1-sol`, `claude-bridge/claude-haiku-5-5`, `openai/gpt-6-luna` | 0.939, 0.924 (0.921 with 16000 characters; no cost on a Claude plan), 0.885. |
| Thinking | session (`low`), `off` | 0.974, 0.971: no measurable difference. The session level stays the default so transcript requests reuse the cache. |
| Trigger | 0.6, 0.7, 0.8, 0.9 | All 0.968 to 0.977 at normal pace. In the burst test 0.8 blocked 32.6 s while 0.7 and 0.6 blocked 0 s; 0.6 also wrote 1.8 summaries per compaction. |
| Kept tail in transcript mode | 8000, 4000 | 0.974, 0.977 with a smaller context after compaction. It stays Pi's `keepRecentTokens`. |
| Focus on exact facts | none, one sentence | 0.974, 0.977 in transcript mode; 0.939, 0.926 serialized. Not adopted. |

Three findings changed the code rather than a setting:

- Pi's truncation marker (`[... N more characters truncated]`) led summarizers to report that the agent never saw the whole file and should read it again. The marker now says the cut belongs to the summary transcript.
- A catch-up costs about as much as a fresh summary, and compaction then waited for it. It now runs only when a swap would leave more than half the threshold. A refresh in flight is not waited for when the held summary already fits, and no refresh starts at the boundary where Pi compacts. Before these changes, trigger 0.6 still blocked 35 s in the burst test.
- A snapshot taken right after a large tool result held a summary that kept that output verbatim. Such boundaries are now skipped until the cut can fall after it.

The per-run scores of every round are in `eval/results/hill-climb.json` (`node eval/report.mjs eval/results/hill-climb.json --round=final` prints the first table). The recorded sessions are in `eval/data/sessions`. Reproduce with:

```sh
npx tsx eval/record.mts --scenario=ledger --name=ledger-1   # record a session
npx tsx eval/replay.mts --configs=eval/configs/final.json    # replay configurations
node eval/report.mjs eval/results/<run>                      # aggregate
npx tsx eval/live.mts --scenario=tasks --arm=extension       # end to end in Pi's runtime
```

## Limitations

- While enabled, compaction depends on the selected model. Until its summary is ready, the context grows past Pi's threshold into the `reserveTokens` headroom. A response that overflows the context window before then fails, as it does when compaction is cancelled; the next prompt compacts if the summary is ready. If the model keeps failing, fix or re-authenticate it, or turn the extension off to let Pi compact with the session model.
- A summary interrupted by a session switch or `/reload` resumes only when that session opens again. The selected model and on/off command choices are saved separately in the session.
- A background summary that is never used, because the session ended, moved to another branch, or compacted manually with instructions, still costs its tokens.
- Transcript requests send the whole conversation again. Cached input is cheap, but a provider without prompt caching charges for it in full; set `request` to `serialized` for those.
- Compactions written by the extension are recorded as extension-provided (`fromHook`). Pi does not carry file lists forward from those, so the extension carries its own.
