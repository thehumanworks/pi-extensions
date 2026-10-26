# pi-background-compaction

Background compaction for [Pi](https://github.com/earendil-works/pi). Pi normally pauses a session while it writes the compaction summary, about 30 seconds per compaction on `openai/gpt-6.1-sol` in the evaluation below. This extension writes the summary in the background as the context approaches Pi's compaction threshold, while the session keeps working on its full history. When Pi compacts, the ready summary is swapped in without another model call, and everything that happened since stays verbatim after it.

```text
70% of the threshold   a summary of the conversation so far starts in the background
                       the session keeps going on its full history; the summary is held
Pi's threshold         Pi compacts: the held summary replaces the history it covers,
                       and every message since it is kept as is
```

The design follows Claude's [background compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-background) loop (replace exactly the history the request held, keep later turns after the summary) and OpenCode's [background compaction](https://opencode.ai/v2/docs/compaction/) (start early, hold the summary until compaction is due, wait for it if it is still being written, fall back when it fell too far behind).

## Install

```sh
pi install npm:@nothumanwork/pi-background-compaction
```

The npm command works after the package has been published. From a checkout of this repository, run `npm ci --ignore-scripts` at the root, then `pi install ./pi-background-compaction`.

It works with Pi's automatic compaction (`compaction.enabled`, on by default) and changes nothing else about when Pi compacts: `compaction.reserveTokens`, `compaction.keepRecentTokens`, and their per-model overrides still decide the threshold and how much recent history stays verbatim.

## How it works

1. **Start.** After each model response (`turn_end`) and when the session goes idle, the extension compares the context to Pi's threshold (`contextWindow - reserveTokens`). Past `trigger` of it, it plans the summary exactly as Pi would cut it (the same cut point, verified against Pi's `prepareCompaction`) and sends the request without waiting for it. Only one summary is written at a time. If the newest tool result is too large for the cut to leave it out, the request waits for the next boundary rather than hold a summary that keeps that output verbatim.
2. **Hold.** The finished summary is kept in memory and not applied, so the prompt cache stays valid until compaction is due. If the conversation grows past the staleness bound (OpenCode's `max(2 × keepRecentTokens, 30k)`, at most a quarter of the threshold), the held summary is extended in the background with only the messages since.
3. **Swap.** When Pi compacts (`session_before_compact`, for the threshold, context overflow, or `/compact` without instructions), the extension returns the held summary with the first kept entry it was planned for. Pi appends it like its own compaction. If the summary is still being written, compaction waits for it, which is still sooner than starting a new one. A refresh in flight is not waited for when the held summary already fits, and no refresh starts at the boundary where Pi is about to compact.
4. **Validate.** A held summary is used only if the session still contains the history it covers: the same latest compaction, its first kept entry on the current branch (not lost to `/tree` or a fork), and no context edits to a summarized message. If swapping it in would leave more than `maxSwapRatio` of the threshold in context, a short catch-up request extends it first. This prevents a compaction that frees almost nothing ([anthropics/claude-code#70459](https://github.com/anthropics/claude-code/issues/70459)).
5. **Fall back.** Without a usable background summary, the extension writes one at compaction time with the same model and prompt, as a transcript request where it can; overflow recovery always uses a serialized one, since the overflowing context cannot be resent. If that fails, Pi's built-in compaction runs as usual. After two background failures in a row, background summaries stop until the next compaction.

Summaries keep Pi's `<read-files>` and `<modified-files>` lists, and their usage is recorded on the compaction entry so session totals include it. Summaries that are never used still cost tokens.

### Request styles

- **Transcript** (`request: "auto"` picks it when it can): the conversation exactly as the session model last received it, system prompt and tool declarations included, plus one instruction, with tool calls disabled and the session's cache routing. The provider serves nearly all of it from the prompt cache: in the evaluation, 31.9k of 33.4k input tokens were cache reads. `auto` uses it when the summarizer is the session model on one of pi-ai's built-in provider APIs.
- **Serialized**: Pi's text rendering of the summarized messages with a standalone summarizer prompt, so any model can write it. Each tool result keeps `toolResultChars` characters (Pi keeps 2000). Used for a different summarizer model, for extension providers such as CLI bridges (which may treat a resent conversation as their next turn), and for refreshes and catch-ups.

## Configuration

Add a `backgroundCompaction` object to `~/.pi/agent/settings.json` or a project's `.pi/settings.json`. Every key is optional; each also has a `PI_BACKGROUND_COMPACTION_*` environment override (for example `PI_BACKGROUND_COMPACTION_TRIGGER=0.6`). Text values accept `@path/to/file` to read a file.

```json
{
  "backgroundCompaction": {
    "trigger": 0.7,
    "model": "claude-bridge/claude-haiku-5-5"
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the extension off (`PI_BACKGROUND_COMPACTION=0`). |
| `trigger` | `0.7` | Fraction of Pi's compaction threshold at which the background summary starts. Lower gives a slow summary more time to finish before compaction is due, at the cost of an older summary and occasional refreshes. |
| `minTokens` | `16000` | Smaller contexts are not summarized in the background. |
| `model` | session model | Summarizer as `provider/modelId`. Falls back to the session model when it is unavailable or signed out. |
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
| `timeoutMs` | `300000` | Abort a background summary after this long. |

`PI_BACKGROUND_COMPACTION_TRACE=/path/file.jsonl` appends one JSON line per event (`start`, `ready`, `wait`, `refresh`, `catch-up`, `swap`, `discarded`, `failed`), with timings and token counts.

## Commands and status

- `/bg-compact` or `/bg-compact status`: current state, limits, settings, and counters.
- `/bg-compact start`: write a background summary now, regardless of the trigger.
- `/bg-compact cancel`: drop the background summary.

While a summary is being written the footer shows `compact: writing`, then `compact: ready` while one is held.

## Evaluation

The `eval/` directory (not published) holds the harness used to choose the defaults. It uses two coding scenarios, a bookkeeping CLI and a JSON API, with 12 scripted user turns each. Facts are planted in user rules, decisions, corrections, long documents, logs, and data files. Each was recorded three times with `openai/gpt-6.1-sol` and compaction off, giving six real sessions of 46k to 61k tokens.

The replay runs the production `BackgroundCompactor` over each recorded session on the session's own clock. A background summary becomes ready its measured latency after it starts, so waits and blocking reflect the original pace. At Pi's threshold, the session model is asked two things from the compacted context, without tools:

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

How the defaults were chosen (one factor at a time from a baseline, n = 12 unless noted):

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
- A blocking catch-up costs about as much as a fresh summary. It now runs only when a swap would leave more than half the threshold. A refresh in flight is not waited for when the held summary already fits, and no refresh starts at the boundary where Pi compacts. Before these changes, trigger 0.6 still blocked 35 s in the burst test.
- A snapshot taken right after a large tool result held a summary that kept that output verbatim. Such boundaries are now skipped until the cut can fall after it.

The per-run scores of every round are in `eval/results/hill-climb.json` (`node eval/report.mjs eval/results/hill-climb.json --round=final` prints the first table). The recorded sessions are in `eval/data/sessions`. Reproduce with:

```sh
npx tsx eval/record.mts --scenario=ledger --name=ledger-1   # record a session
npx tsx eval/replay.mts --configs=eval/configs/final.json    # replay configurations
node eval/report.mjs eval/results/<run>                      # aggregate
npx tsx eval/live.mts --scenario=tasks --arm=extension       # end to end in Pi's runtime
```

## Limitations

- Held summaries live in memory. A restart or `/reload` loses them, and the next compaction writes its summary in the foreground.
- A background summary that is never used, because the session ended, moved to another branch, or compacted manually with instructions, still costs its tokens.
- Transcript requests send the whole conversation again. Cached input is cheap, but a provider without prompt caching charges for it in full; set `request` to `serialized` for those.
- Compactions written by the extension are recorded as extension-provided (`fromHook`). Pi does not carry file lists forward from those, so the extension carries its own.
