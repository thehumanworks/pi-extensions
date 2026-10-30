# 1. Summary

**Claude Code’s `/loop` and pi-loop share a recurring-prompt interface, but they have different execution and lifecycle models.**

- **Claude Code `/loop` continues an existing session.** A scheduled prompt is delivered between turns in that conversation, with its session permissions and MCP connections. It is not normally a fresh conversation per run.
- **pi-loop creates a fresh, independent conversation for every run.** It saves a self-contained prompt, working directory, model and thinking level, then executes through a detached SQLite-backed worker. It does **not** inherit the creator’s history, extensions, skills, MCP servers, project instructions or permission hooks.
- **Claude supports fixed schedules and self-paced loops.** An explicit interval is converted to cron and scheduled with `CronCreate`; an omitted interval uses `ScheduleWakeup`, with Claude choosing the next delay. pi-loop supports only explicit, fixed-duration intervals—not cron or self-pacing.
- **pi-loop deliberately has stronger persistence.** Closing Pi does not stop its worker. After worker downtime, it recovers unfinished work or performs one overdue run. Claude’s current documentation restores unexpired `CronCreate` tasks on session resume, but does not replay downtime misses or restore a self-paced loop.
- **The safety trade-off is substantial.** pi-loop requires creation confirmation—or explicit unattended opt-in—but subsequent runs have host file/shell access without the interactive session’s permission hooks. Claude’s scheduling tools normally do not require an approval prompt, but the work they trigger inherits session permissions.
- **pi-loop’s durability and fresh-run design resemble Desktop scheduled tasks more than `/loop`.** It is still local, however: unlike cloud routines, it cannot execute while the host is off or asleep.

**Scope:** checked on **2026-10-30**. Claude claims below describe the current official documentation unless marked historical, inferred or user-reported; I did not test a Claude binary. Our implementation is **pi-loop 0.1.0**, with `pi-durable` and the worker runtime pinned to **1.3.0** (`package.json:2-3,31-34`). Local references are relative to `/home/nixos/pi-extensions/pi-loop`. I read `README.md`, `index.ts` and every file in `src`; no files were modified.

# 2. Comparison table

“Theirs” means **session `/loop` and its scheduling tools**, not Desktop or cloud scheduling.

| Dimension | Theirs | Ours | Same, different or partial |
|---|---|---|---|
| Basic purpose | Repeated prompts, polling and reminders within a Claude Code session. [Scheduling docs][C] | Repeated host-side agent jobs, independent of the creating Pi session. `index.ts:27-33`; `src/client.ts:64-69` | Partial |
| Creation architecture | Bundled skill; Claude converts the request and calls scheduling tools. [C][C] | Command sends instructions to the current model, which must call the `loop` tool. `index.ts:95-106` | Same: model-mediated creation |
| Invocation | `/loop 5m <prompt>`; trailing `every 2 hours` also documented. `/proactive` alias since v2.1.105. [C][C]; [release][R105] | `/loop <frequency> <task>`; one leading interval token required. `src/protocol.ts:14-18` | Partial |
| Interval omitted | Self-paced: Claude chooses **1 minute–1 hour** after each iteration. [C][C] | No self-paced mode; missing frequency is invalid. `src/protocol.ts:14-18` | Different |
| Prompt omitted | Built-in maintenance prompt, or project/user `loop.md`. [C][C] | Bare `/loop` displays help; interval without task is invalid. `index.ts:78-79`; `src/protocol.ts:14-18` | Different |
| Duration parser | `s/m/h/d`; seconds round **up to minutes**; awkward intervals such as `7m` or `90m` are rounded to a clean cron interval. [C][C] | Case-insensitive numeric `s/m/h/d/w`; decimals accepted at whole-millisecond precision; invalid values rejected, not rounded. `src/protocol.ts:4-11` | Different |
| Minimum/maximum interval | Documented minimum **1 minute**; self-paced maximum delay **1 hour**. [C][C] | **1 second–365 days**. `src/protocol.ts:7-10` | Different |
| Cron/calendar scheduling | `CronCreate` accepts five-field local-time cron. [C][C] | No cron/calendar parser; fixed millisecond durations. `src/protocol.ts:4-11,21-23` | Different |
| One-shot tasks | Supported through `CronCreate`; delete after firing. [C][C] | No one-shot action or recurrence flag. `src/protocol.ts:26-36`; `src/scheduler.ts:71-74` | Different |
| First run | First scheduled fire follows scheduling/jitter. An additional immediate execution during `/loop` setup is observed but **not specified by current docs**. [C][C]; [reported transcript][I67967] | Exactly one interval after admitted creation, not immediately. `src/scheduler.ts:122-131` | Partial: theirs not fully specified |
| What a run is | Prompt delivered into the current session between turns. [C][C]; [tools][T] | New conversation for every run; saved prompt submitted to it. `src/scheduler.ts:46-61` | Different |
| History and context | Existing session context, subject to normal compaction; no documented per-loop isolated context. [C][C]; [general context documentation][P] | No creator or previous-run history automatically supplied. Saved prompt plus worker instructions/tools. `src/scheduler.ts:46-61,85-96` | Different |
| Model/effort | No documented per-cron model/effort setting; use of current session configuration is an inference. | Provider/model ID and thinking level captured at creation and applied each run. `index.ts:56-60`; `src/scheduler.ts:47-49` | Different |
| Tools, skills and MCP | Session MCP connections inherited. Model-invocable skills can run; built-in slash commands, denied/user-only skills and MCP prompts arrive as text. [C][C] | Worker installs `CodingTools`: `read/write/edit/bash`; no interactive extensions, skills or MCP installation. `src/scheduler.ts:85-96`; `index.ts:31-32` | Different |
| Working directory | Local-session operation; exact per-fire cwd behavior is not separately specified. [C][C] | Existing absolute cwd required and saved per schedule; used by each run’s host environment. `src/scheduler.ts:47-49,94,114` | Partial |
| Creator session busy | Due prompt waits until current turn ends; low-priority enqueue. [C][C] | Creator’s busyness is irrelevant after creation: worker runs separately. `src/client.ts:64-69`; `src/worker.ts:26-27` | Different |
| Overlap | Main-session turns do not run concurrently; multiple due-task ordering is undocumented. [C][C] | No overlap within one schedule; different schedules can run concurrently. `src/scheduler.ts:34-75,126-128` | Partial |
| Misses during long work | Documented to coalesce into **one fire when idle**, not one per missed interval. [C][C] | Waits for current run to settle, then skips to next future grid slot; no extra immediate catch-up after that run. `src/scheduler.ts:62-74`; `src/protocol.ts:21-23` | Partial |
| Misses during downtime | Restored recurring tasks wait for next future due time; no replay. [C][C] | Persisted overdue sleep admits one run when recovered; then advances to a future slot. An interrupted run resumes its saved conversation/checkpoint. `src/scheduler.ts:26-75,98` | Different |
| Jitter | Intentional offsets; special five-minute cadence and early one-shot behavior. [C][C] | No deliberate jitter in extension code; ordinary runtime/provider latency still applies. `src/scheduler.ts:39-40,71,125`; `src/protocol.ts:22-23` | Different |
| Expiry/task cap | Recurring tasks: **7 days**, final fire then delete. **50 tasks/session**, eight-character IDs. [C][C] | No extension-level TTL or schedule-count cap; UUID IDs. `src/scheduler.ts:16-25,113-134` | Different |
| Session exit | Stops firing unless session is kept running in the background. [C][C] | Detached worker continues after Pi exits. `src/client.ts:64-69` | Different |
| Process restart/reboot | Session resume restores unexpired `CronCreate` jobs, not self-paced loops; special saved-task behavior also exists. [C][C] | SQLite recovery when worker starts; automatic recovery on extension load if database exists. No OS startup service installed. `index.ts:16-21`; `src/worker.ts:26-27`; `src/scheduler.ts:97-98`; `README.md:97` | Partial |
| Machine sleep | `/loop` suspend/wake behavior is **not explicitly documented**. Desktop’s catch-up rule must not be assumed. | Cannot execute asleep; persisted due time/checkpoint is recovered after wake/start. Ownership lock is not lease-based. `src/worker.ts:14-18`; `src/scheduler.ts:39-50` | Partial |
| List/cancel | Ask Claude; `CronList`/`CronDelete` are model tools. No documented `/loop list` command. [C][C] | Direct `/loop list/show/delete`, without a model turn; also model-callable tool actions. `index.ts:35,81-94` | Partial |
| Pause/resume | No documented per-task pause for session `/loop`. | Explicit pause/resume; pause/delete abort and await the task. Resume a paused/terminal task at now + interval. `src/scheduler.ts:138-159` | Different |
| Keyboard stop | Esc/idle Ctrl+C stop waiting **self-paced** loops, with background-session exceptions; not fixed cron loops. [C][C] | No loop-specific Esc/Ctrl+C handling. Persistent controls are pause/delete; worker-wide stop is separate. `index.ts:75-110` | Different |
| Global disable/configuration | `CLAUDE_CODE_DISABLE_CRON=1`; bundled-skill disable is a separate, narrower control. [Environment variables][E] | No equivalent disable environment variable. `PI_LOOP_HOME`, `PI_LOOP_NODE`, `PI_LOOP_ALLOW_UNATTENDED`; `/loop stop` is temporary process control. `src/paths.ts:4-9`; `src/client.ts:64`; `index.ts:53-54,82-89` | Different |
| Creation confirmation | Scheduling tools normally require **no Manual-mode permission prompt**; Claude confirms cadence/ID after scheduling. [T][T]; [C][C] | Blocking UI confirmation of prompt, frequency, cwd and model; without UI, requires `PI_LOOP_ALLOW_UNATTENDED=1`. `index.ts:43-60` | Different |
| Permissions during execution | Inherits session permission prompts. [C][C] | Host file/shell execution without creator’s permission hooks; saved cwd is not a sandbox. `src/scheduler.ts:85-96`; `index.ts:31-32` | Different |
| Results/observability | Results appear in ongoing transcript; task listing includes next-run times in recent versions. [C][C] | List/show expose task state and last **20** outputs, each truncated to **16,000** characters. `src/scheduler.ts:65-70,109-111,162-164` | Partial |
| Idempotency and external effects | Public `/loop` documentation does not establish exactly-once external effects. | Stable create/run request IDs and transactional checkpoints; still **not exactly-once external effects**. `src/scheduler.ts:45-60,117-133`; `README.md:99` | Partial |

# 3. Notable differences in detail

## 3.1 Claude has two loop mechanisms; ours has one

### Fixed intervals: `/loop` → `CronCreate`

Claude documents:

```text
/loop 5m check the deploy
/loop check the deploy every 2 hours
/loop 20m /review-pr 1234
```

Claude converts an explicit interval into cron, schedules it and reports the cadence and job ID. This is not a published deterministic interval parser inside `CronCreate`: **`CronCreate` consumes cron**, while the `/loop` skill/model performs the conversion. Current documentation specifies:

- Units `s`, `m`, `h`, `d`.
- Seconds round **up** to minute granularity.
- Intervals such as `7m` and `90m` are rounded to a nearby “clean cron step.”
- No complete rounding table or tie-breaking rule is published. [Scheduling docs][C]

`CronCreate` accepts:

```text
minute hour day-of-month month day-of-week
```

Fields support wildcards, numeric values, steps, ranges and lists. Sunday is `0` or `7`; names such as `MON`/`JAN` and extensions such as `L`, `W`, `?` are unsupported. Constrained day-of-month and day-of-week use **OR**, not AND. Times are **local**, not UTC. [Scheduling docs][C]

Ours instead has a concrete parser:

```text
/loop 30s check the build
/loop 1.5h summarize ./events.log
/loop 1w audit dependencies
```

It validates a single numeric token plus unit, multiplies by a fixed scale and rejects values outside 1 second–365 days or not representable as whole milliseconds. Thus **`7m` and `90m` retain their exact durations**, and `1d` means 86,400,000 milliseconds—not a local-calendar appointment (`src/protocol.ts:4-18`).

Both systems nevertheless depend on a model to complete creation. Our command asks the model to prepare a self-contained prompt and call `loop`; it does not directly install a schedule (`index.ts:99-106`). An open Claude report similarly describes `/loop` executing once without calling `CronCreate` ([#90883][I90883]). That report is evidence of a failure mode, not a verified current implementation specification.

### Omitted interval: self-paced Claude loops

Current Claude:

```text
/loop check CI and address review comments
```

After each iteration Claude chooses the next delay, **between one minute and one hour**, and prints its reason. It uses `ScheduleWakeup`, rather than a fixed recurring cron. The pending wakeup appears in the task list as a one-shot. Claude may instead use `Monitor` to react to streamed events without polling. [Scheduling docs][C]; [tools reference][T]

If an iteration neither reschedules nor explicitly stops:

1. Claude Code schedules one fallback wakeup about **20 minutes** later.
2. If that iteration also fails to reschedule, the loop ends.

`ScheduleWakeup {stop: true}` can explicitly end it. The tools Markdown reference pins `stop` support to **v2.1.202+**. [Scheduling docs][C]; [tools Markdown][TM]

**We have none of these modes.** Frequency and task are required; there is no dynamic-delay tool, fallback wakeup, Monitor integration or built-in “stop when complete” mechanism (`src/protocol.ts:14-18,26-36`; `src/scheduler.ts:71-74,85-91`).

### Omitted prompt: Claude maintenance versus our help

Bare Claude `/loop`, or `/loop 15m`, uses a maintenance prompt: continue unfinished conversation work, tend the current branch’s PR, then perform cleanup. It is instructed not to start unrelated initiatives, and to push/delete only as continuation of transcript-authorized work.

`.claude/loop.md` overrides that default; otherwise `~/.claude/loop.md` can supply it. Edits apply next iteration; content beyond **25,000 bytes** is truncated. Explicit command-line prompts bypass it. [Scheduling docs][C]

Our bare `/loop` is **help**, not autonomous maintenance; `/loop 15m` lacks a task and fails parsing (`index.ts:78-79`; `src/protocol.ts:14-18`).

## 3.2 “A run” is fundamentally different

### Claude: another turn in the same conversation

The official contract is a prompt scheduled **within the current session**, delivered **between turns**. Permissions and MCP connections explicitly inherit from that session. That establishes same-session continuation, not a fresh scheduled conversation. [Scheduling docs][C]; [tools reference][T]

The normal context model supplies system/project context and conversation history; compaction replaces history with a summary. Applying that to a scheduled turn is a reasonable inference from the documented same-session mechanism, not a separate `/loop` context guarantee. Likewise, **the current session’s model/effort is the likely configuration, but the scheduling page does not explicitly specify it**. [General context documentation][P]

Scheduled slash text is restricted: only skills Claude may invoke itself execute. Built-in `/model`, `/clear`, `/permissions`, user-only/denied skills and MCP prompts arrive as text instead. [Scheduling docs][C]

### Ours: a new, narrowly configured worker conversation

At each due time, pi-loop atomically creates a conversation and checkpoints its ID, then applies saved model, thinking level and cwd. The run submits only the saved task prompt to that conversation (`src/scheduler.ts:39-61`).

The registry contains host coding tools and a small scheduled-task role instruction, not the interactive coding-agent environment (`src/scheduler.ts:85-96`). Consequences:

- “The issue we discussed” must be resolved into facts **at creation**, not rediscovered from creator history.
- Previous run summaries are stored for management but are **not fed into the next run**.
- A job relying on an interactive skill, MCP server or project instruction will not automatically have it.
- A slash command in a saved prompt is not an installed worker command.
- The model/provider ID is saved, and creation rejects a model the worker cannot resolve (`src/scheduler.ts:114-116`).
- Runs share real filesystem state, despite having isolated conversations.

The prompt-rewriting requirements—preserve scope, resolve only known facts, ask rather than guess—are instructions to the creating model, not semantic enforcement. The user confirmation is therefore important (`index.ts:27-32,47-55,99-105`).

## 3.3 First run, cadence, busyness and jitter

### First run: ours is explicit; Claude’s setup turn is underspecified

Our creation sets:

```text
first_due = Date.now() + interval
```

It does **not** execute the task during creation (`src/scheduler.ts:122-131`; `index.ts:100`).

Claude’s current docs describe installing the schedule and displaying its next run, but do not state whether `/loop` also executes the task immediately in the setup turn. A reported v2.1.175 transcript shows **both** `CronCreate` and “Now running the first check immediately” ([#67967][I67967]). Therefore:

- Do not equate creating `CronCreate` with an immediate scheduler fire.
- Do not promise that current `/loop` always waits before doing any work.
- The setup-turn immediate execution is observed, but is not a clearly documented current guarantee.

### Busy and long-running work

Claude checks for due work **every second**, enqueues at low priority and waits for the current turn to end. The documented rule is **one coalesced fire when idle**, not one per missed interval. [Scheduling docs][C]

Our worker is unaffected by the creator’s active turn. Within one schedule, it waits for the current submission to settle before advancing the schedule (`src/scheduler.ts:59-74`).

The next due time is:

```text
previous_due
  + max(1, floor((finished_now - previous_due) / interval) + 1) × interval
```

This preserves the original interval grid while skipping elapsed slots (`src/protocol.ts:21-23`).

For example, a five-minute job due at `:05` that finishes at `:22` next runs at `:25`; it does **not** immediately execute another catch-up at `:22`.

Different schedules have separate durable tasks/conversations and can execute concurrently—even in the same working directory. Conversation isolation is not filesystem isolation (`src/scheduler.ts:46-49,126-128`).

### Claude deliberately shifts execution times

The **current HTML documentation** specifies:

- Recurring jobs: late by up to **half the gap to the next run**, capped at **30 minutes**.
- Evenly spaced schedules: the same lateness each time; uneven schedules can have different lateness per slot.
- **`*/5 * * * *` exception:** runs **4m45s after the previous run**, to avoid crossing a five-minute prompt-cache lifetime.
- One-shots at `:00` or `:30`: up to **90 seconds early**; other minutes are not shifted.
- Self-paced wakeups can receive that one-shot early shift.
- Actual next-run display requires **v2.1.299+**. [Scheduling docs][C]

We implement **no intentional jitter**. Due times are duration-grid timestamps; actual starts can still be late because the machine, runtime or provider is unavailable (`src/protocol.ts:21-23`; `src/scheduler.ts:39-40,71,125`).

## 3.4 Durability: ours is stronger, but not an always-on service

### Claude’s current session persistence

The current official limitations say:

- Exit stops firing; backgrounding can keep the session and its tasks running without a terminal.
- `--resume`/`--continue` restore unexpired **`CronCreate`** tasks.
- Expired recurring tasks and passed one-shots are not restored.
- **Self-paced `/loop` is not restored.**
- Downtime misses are not replayed; recurring jobs wait for the next future fire.
- Background Bash commands and monitors are not restarted.
- A background self-paced wakeup that becomes due while its process is down stops, with a notice on restart. [Scheduling docs][C]

There is also a narrower saved-task path: **with feature-flag fetching off**, a task the user asked to keep across sessions is stored in project `.claude/scheduled_tasks.json`. The docs specify symlink refusal and binding to the original project folder. This prevents an absolute claim that Claude has *no* disk-backed scheduling, but it is not default, session-independent `/loop` service durability. [Scheduling docs][C]

### pi-loop’s persisted worker state

Our worker opens SQLite, restores the harness and resumes durable tasks (`src/worker.ts:26-27`; `src/scheduler.ts:92-98`). Its two phases preserve:

1. Due time and atomically created run-conversation ID.
2. Stable prompt request ID, result and next due time.

Creation retries use a stored request ID; run submissions use `loop:<schedule-id>:<due>` (`src/scheduler.ts:26-75,117-133`).

After downtime:

- A persisted **sleep** that is overdue admits one run.
- A persisted **run** resumes the saved conversation/submission.
- The following due time advances to a future grid slot.

The detached worker survives closing Pi (`src/client.ts:64-69`). Its exclusive SQLite ownership lock does not expire during sleep (`src/worker.ts:14-23`).

But **there is no automatic reboot/crash supervisor**. Recovery begins when the extension next loads with an existing database, `/loop start` is called, another worker request starts it, or an externally configured service launches it (`index.ts:16-21,82-85`; `src/client.ts:79-82`; `README.md:97`).

Neither durable checkpoints nor stable request IDs guarantee exactly-once external effects. Completed shell/network effects cannot be rolled back; interrupted operations require idempotent task design (`README.md:99`).

### Where Desktop/cloud clarify the comparison

Desktop local tasks start **fresh sessions**, persist independently of a manual conversation, support pause, and perform **one catch-up for the most recent miss within seven days** on app start/wake. They still require an open app and awake computer. That is closer to pi-loop’s lifecycle, though not its exact recovery algorithm. [Desktop docs][D]

Cloud routines—created through `/schedule`, backed by `RemoteTrigger`—also start a **new session per run**, but can run with the laptop closed. pi-loop does not provide that infrastructure. [Cloud docs][R]; [tools reference][T]

## 3.5 Management and safety differ in both directions

### Our management is direct, but `stop` is not a persistent disable

We expose direct commands:

```text
/loop list
/loop show <id>
/loop pause <id>
/loop resume <id>
/loop delete <id>
/loop start
/loop stop
```

Management does not require a model round-trip (`index.ts:81-94`). Pause/delete persist status before aborting and awaiting the task (`src/scheduler.ts:138-146`).

**Important:** `/loop stop` stops the worker, not the stored schedules. Subsequent `list/show/create/pause/resume/delete` requests call `ensureWorker`, and loading another Pi session also recovers an existing database. To keep a job disabled, **pause or delete it** (`src/client.ts:79-82`; `index.ts:16-21,86-93`).

Claude documents natural-language list/cancel via `CronList`/`CronDelete`, not equivalent `/loop list` or pause subcommands. Waiting self-paced loops have a model-free keyboard stop; fixed cron loops do not. In an attached background session on **v2.1.295+**, double Ctrl+C detaches without cancelling the wakeup; Esc stops it. [Scheduling docs][C]

Claude’s documented global kill switch is **`CLAUDE_CODE_DISABLE_CRON=1`**. It disables `/loop`, cron tools and scheduled firing, including mid-session. It can be set through shell environment or settings `env`. **`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` / `disableBundledSkills` is different:** it removes bundled skills, but is not documented as stopping existing cron jobs. [Environment variables][E]

We have no equivalent durable disable switch. `PI_LOOP_ALLOW_UNATTENDED` authorizes **new headless creation**; unsetting it does not stop existing jobs (`index.ts:43-55`).

### Ours confirms creation, then runs with broader unattended authority

Our UI confirmation shows the exact proposed prompt, frequency, cwd, model and warning that it will run unattended after Pi closes. Without UI, creation requires `PI_LOOP_ALLOW_UNATTENDED=1` (`index.ts:47-60`).

That gate is in the Pi integration—not a security boundary around the local control socket. The worker trusts access to its owner-protected directory/socket (`src/worker.ts:11-12,43-45,67`).

After admission, runs use ordinary host tools without the creator’s permission hooks or a per-job permission policy (`src/scheduler.ts:85-96`). The working directory is a default location, **not a file-access sandbox**. The worker also inherits the starter process’s environment, so credentials/PATH are worker-wide rather than separately captured per schedule (`src/client.ts:64-66`).

Claude’s cron/wakeup tools normally do **not** prompt in Manual mode; “confirms the cadence and ID” is informational, not a yes/no approval gate. But the fired work inherits session permissions. [Tools reference][T]; [scheduling docs][C]

Our absence of expiry, task-count limits and per-schedule cost limits increases the importance of trusted prompts and explicit pause/delete. A one-second interval can incur substantial unattended usage.

### README versus code

The README broadly matches the implementation. Two statements need qualification:

1. **Resume does not always reset the next run.** `README.md:39` says “next run is one interval from now.” Code does that for a paused/terminal task, but returns an already-active, nonterminal schedule unchanged (`src/scheduler.ts:148-157`).
2. **“Missed ticks coalesce” must not imply an extra run after a long run finishes.** `README.md:77` is broad. The code records the completed run and jumps directly to the next future grid slot (`src/scheduler.ts:62-74`; `src/protocol.ts:21-23`).

Also, the fixed-cadence description (`README.md:76`) holds within an active schedule period; resuming a paused/terminal task establishes a new grid.

## 3.6 Relevant Claude version history

| Version/date | Established change |
|---|---|
| **v2.1.71 — 2026-03-07** | `/loop` and in-session cron tools introduced. [Release][R71] |
| **v2.1.72 — 2026-03-10** | `CLAUDE_CODE_DISABLE_CRON` added for mid-session stopping. [Release][R72] |
| **v2.1.73 — 2026-03-11** | Fixed availability on Bedrock/Vertex/Foundry and with telemetry disabled. [Release][R73] |
| **v2.1.85 — 2026-03-26** | Transcript timestamp markers for scheduled fires. [Release][R85] |
| **Week of 2026-04-06–10** | Official weekly notes say `/loop` “now self-paces,” alongside Monitor v2.1.98. Exact self-pacing introduction build is not pinned there. [Weekly notes][W15] |
| **v2.1.105 — 2026-04-13** | `/proactive` alias; fix for one-shots repeatedly firing after missed cleanup. [Release][R105] |
| **v2.1.110 — 2026-04-15** | `--resume`/`--continue` resurrect unexpired scheduled tasks. [Release][R110] |
| **v2.1.113 — 2026-04-17**; **v2.1.143 — 2026-05-15** | Esc cancellation/clearer wakeup display; later fix for idle Esc/Ctrl+C cancellation. [v113][R113]; [v143][R143] |
| **v2.1.202 — 2026-07-06** | `ScheduleWakeup.stop` requires this version, according to the tools reference—not a matching release-note bullet. [Tools][TM]; [release/date][R202] |
| **v2.1.248 — 2026-08-27** | Self-paced mode and no-prompt default always available, including third-party providers. [Release][R248] |
| **v2.1.292 — 2026-10-06** | Background-loop restart/saved-task fixes; one-shot `claude -p` now waits for scheduled wakeups rather than dropping them. [Release][R292] |
| **v2.1.295 — 2026-10-08** | Background detach/stop behavior, missed-wakeup notice, and resume/rewind fixes. [Release][R295] |
| **v2.1.299 — 2026-10-14** | Actual next-run display; repeated-DST-hour firing fixes; wakeups during background tasks fixed for SDK/IDE/remote-control sessions. [Release][R299] |

# 4. Open questions and conflicting evidence

1. **Two official documentation surfaces disagree.** I fetched both. The [HTML scheduling page][C] includes later version gates and says self-paced loops are not restored, describes the `*/5` exception, and allows early jitter on dynamic wakeups. The [Markdown export][CM] retains task-ID-derived jitter, says dynamic loops are not jittered, and gives broader restore wording. I use the HTML as the more current account, not a merge of both.

2. **Three-day versus seven-day expiry remains an official-source conflict.** The current product documentation says **seven days**, but the [Help Center tips][H] still say “up to 3 days.” A [2026-03-23 issue][I37863] already documented three-day docs versus seven-day tool output. No verified release note dates a runtime TTL change. Seven days is the current product-doc contract; historical enforcement is unresolved.

3. **First `/loop` setup-turn execution and interval rounding are not fully specified.** The immediate-run transcript is useful evidence, not a current guarantee. There is no published complete interval-conversion table or tie-breaking rule.

4. **Claude timing behavior has historical counterexamples.** [#65576][I65576] reports stacked missed ticks on v2.1.153, contrary to today’s coalescing rule. [#56106][I56106] quotes older 10%/15-minute jitter documentation; [#83499][I83499] reports session-phase timing on v2.1.205/217/218. These reports do not prove current builds violate the newer contract, and the larger current jitter range explains some older “late” observations.

5. **`durable: true` is not a dependable public contract established here.** Current public tools docs do not list that input. [#72238][I72238] reports a silent session-only downgrade through v2.1.195. Current docs do establish the narrower feature-flag-fetching-off saved-file path. Neither justifies calling default `/loop` a durable service.

6. **Background lifecycle complicates “closing the terminal stops it.”** An Anthropic maintainer [confirmed in June 2026][I64744] that pending wakeups could keep workers armed and that the supervisor could respawn killed workers. Current docs explicitly support background continuation and later releases fix several lifecycle cases. Therefore “session-scoped” must not be read as “necessarily tied to this terminal window.”

7. **Sleep, simultaneous tasks and exact context details remain underspecified for Claude.** The `/loop` page does not separately define OS suspend/wake, ordering of multiple due tasks, per-fire model selection or exact context wrapper/reload behavior. Desktop’s explicit sleep/catch-up rules are not evidence for `/loop`.

8. **Headless claims need version qualification.** Older reports that `claude -p` simply exits and drops wakeups are no longer sufficient: v2.1.292 explicitly fixes that behavior. A complete current headless `/loop` contract is still absent from the scheduling guide. Our headless admission rule is explicit in code.

9. **Our durability analysis is code-based, not a new crash/sleep experiment.** There is no extension-level expiry, count cap, spending cap or clock-jump policy. The scheduler uses `Date.now()` timestamps, not calendar cron. Recovery guarantees for model/tool internals ultimately depend on pinned `pi-durable`; external effects remain outside exactly-once guarantees.

# 5. Sources

## Official Claude documentation

- [Session scheduling: current HTML][C] — main contract.
- [Session scheduling: Markdown export][CM] — checked for conflicts.
- [Tools reference][T] and [Markdown reference][TM] — tool roles, permissions and wakeup version gate.
- [Environment variables][E] — disable/configuration controls.
- [Prompt caching and context lifecycle][P] — general session context and compaction.
- [Week 15, April 6–10, 2026][W15] — self-pacing introduction.
- [Desktop scheduled tasks][D] and [cloud scheduled tasks/routines][R] — product boundaries.
- [Help Center power-user tips][H] — bundled-skill classification and conflicting three-day expiry.

Release-note URLs are linked in the version table.

## Issue evidence

These are user reports unless an Anthropic maintainer response is explicitly identified above:

- [#90883][I90883] — model can omit `CronCreate`.
- [#67967][I67967] — immediate setup execution and later scheduled fires.
- [#37863][I37863] — three-/seven-day mismatch.
- [#65576][I65576], [#56106][I56106], [#83499][I83499] — historical timing/coalescing discrepancies.
- [#72238][I72238] — reported `durable: true` downgrade.
- [#64744][I64744] — maintainer-confirmed background lifecycle problems.

No unofficial source reconstruction or leaked skill/tool prompt is treated as authoritative.

## Local implementation

- `index.ts:15-110` — integration, creation instructions, confirmation, direct management.
- `src/protocol.ts:1-59` — intervals, cadence arithmetic, request schema and limits.
- `src/scheduler.ts:14-179` — persisted schedules, fresh run conversations, recovery phases and management.
- `src/client.ts:9-82` — control socket and detached-worker startup.
- `src/worker.ts:10-75` — exclusive ownership, SQLite runtime and shutdown.
- `src/paths.ts:4-9` — storage configuration.
- `README.md:30-114` — documented behavior, checked against code.
- `package.json:2-3,31-34` — implementation/dependency versions.

[C]: https://code.claude.com/docs/en/scheduled-tasks
[CM]: https://code.claude.com/docs/en/scheduled-tasks.md
[T]: https://code.claude.com/docs/en/tools-reference
[TM]: https://code.claude.com/docs/en/tools-reference.md
[E]: https://code.claude.com/docs/en/env-vars.md
[P]: https://code.claude.com/docs/en/prompt-caching
[W15]: https://code.claude.com/docs/en/whats-new/2026-w15
[D]: https://code.claude.com/docs/en/desktop-scheduled-tasks
[R]: https://code.claude.com/docs/en/routines
[H]: https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
[R71]: https://github.com/anthropics/claude-code/releases/tag/v2.1.71
[R72]: https://github.com/anthropics/claude-code/releases/tag/v2.1.72
[R73]: https://github.com/anthropics/claude-code/releases/tag/v2.1.73
[R85]: https://github.com/anthropics/claude-code/releases/tag/v2.1.85
[R105]: https://github.com/anthropics/claude-code/releases/tag/v2.1.105
[R110]: https://github.com/anthropics/claude-code/releases/tag/v2.1.110
[R113]: https://github.com/anthropics/claude-code/releases/tag/v2.1.113
[R143]: https://github.com/anthropics/claude-code/releases/tag/v2.1.143
[R202]: https://github.com/anthropics/claude-code/releases/tag/v2.1.202
[R248]: https://github.com/anthropics/claude-code/releases/tag/v2.1.248
[R292]: https://github.com/anthropics/claude-code/releases/tag/v2.1.292
[R295]: https://github.com/anthropics/claude-code/releases/tag/v2.1.295
[R299]: https://github.com/anthropics/claude-code/releases/tag/v2.1.299
[I90883]: https://github.com/anthropics/claude-code/issues/90883
[I67967]: https://github.com/anthropics/claude-code/issues/67967
[I37863]: https://github.com/anthropics/claude-code/issues/37863
[I65576]: https://github.com/anthropics/claude-code/issues/65576
[I56106]: https://github.com/anthropics/claude-code/issues/56106
[I83499]: https://github.com/anthropics/claude-code/issues/83499
[I72238]: https://github.com/anthropics/claude-code/issues/72238
[I64744]: https://github.com/anthropics/claude-code/issues/64744
