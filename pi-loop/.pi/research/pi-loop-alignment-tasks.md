# pi-loop: tasks to align with Claude Code's `/loop`

Compiled 2026-10-30 from workflow run `ae4be3a6` (full report: `claude-code-loop-vs-pi-loop.md` in this folder) and these Claude Code pages, read the same day: [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) ("CC docs"), [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks), [cloud scheduled tasks](https://code.claude.com/docs/en/routines), [tools reference](https://code.claude.com/docs/en/tools-reference).

**Direction.** Claude Code splits scheduling in two. `/loop` is session-scoped: each fire is another turn in the open session, and it stops when the session exits. `/schedule` (alias `/routines`) creates durable tasks that start a new session per run. pi-loop is a durable host worker with a fresh conversation per run, so it corresponds to `/schedule` and Desktop scheduled tasks, not `/loop`. The tasks below align pi-loop's syntax and guardrails with `/loop` and keep its durability. Where `/loop` has nothing equivalent for a durable worker, they follow Desktop scheduled tasks.

Priorities: **P0** fix first · **P1** guardrails Claude has and we lack · **P2** scheduling features · **P3** context and results.

---

## P0: fix first

### 1. Resolve the `/loop` name collision
- **Found:** the global extension `~/.pi/agent/extensions/loop` also registers a `loop` tool (`index.ts:150`) and a `/loop` command (`index.ts:224`), as pi-loop does (`index.ts:25`, `index.ts:75`). Installing both clashes. That extension is session-scoped, posts results into the conversation, and already supports calendar schedules, one-offs, time zones, run-now and read-only default tools. It is the closer match to Claude's `/loop`.
- **Recommendation:** mirror Claude's split. The session-scoped extension keeps `/loop`; pi-loop becomes `/schedule` with a `schedule` tool. Claude uses `/schedule list`, `/schedule update` and `/schedule run`, so the same subcommand names carry over.
- **Done when:** both extensions install in one Pi without a clash, and each README says when to use which.

### 2. Make the README match the code
- `README.md:77` says a long-running task is followed by one overdue run. The code skips straight to the next future slot (due :05, finished :22, next run :25; `src/protocol.ts:21-23`). Only sleep or downtime produces an overdue run. **Recommendation:** keep the skip and fix the wording. Desktop tasks also skip a slot while the previous run is still in progress. Task 9 makes skipped slots visible.
- `README.md:39` says resume sets the next run one interval from now. On an already-active schedule, resume does nothing (`src/scheduler.ts:149`).
- The README presents `/loop stop` as stopping the worker. It doesn't stay stopped: the next request or Pi session restarts it (`src/client.ts:81`, `index.ts:16-21`).
- **Done when:** the README matches the code, and a test covers a run that overruns its next slot.

## P1: guardrails

### 3. Expire recurring schedules after 7 days by default
- **Claude:** recurring tasks expire 7 days after creation; the task fires one final time, then deletes itself, so a forgotten loop has a bounded life (CC docs). A Help Center page still says 3 days; the docs and tool output say 7.
- **Ours:** no expiry.
- **Change:** default `expiresAt = createdAt + 7d`; the last due run fires, then the schedule ends as `expired`. Allow a longer expiry or none at creation, since durable jobs are the point (Desktop tasks don't expire). Show the expiry in the confirmation and in `list`.
- **Done when:** tests cover the final run, the expired state and the opt-out.

### 4. Raise the minimum interval to 1 minute
- **Claude:** 1 minute minimum; seconds round up to whole minutes (CC docs).
- **Ours:** 1 second (`src/protocol.ts:9`). A full agent run every second is a cost hazard.
- **Change:** reject anything under 1 minute with a clear message. `test/scheduler.test.ts:19` relies on `1s`, so give tests an injectable clock rather than a production bypass.
- **Done when:** `30s` is rejected and the scheduler tests still run fast.

### 5. Cap active schedules
- **Claude:** at most 50 scheduled tasks per session (CC docs).
- **Ours:** unlimited per worker.
- **Change:** cap active schedules at 50 per worker; refuse further creates with an error that names the cap.

### 6. Add a global off switch
- **Claude:** `CLAUDE_CODE_DISABLE_CRON=1` turns the scheduler off; `/loop` and the cron tools become unavailable and already-scheduled tasks stop firing (CC docs).
- **Ours:** `PI_LOOP_ALLOW_UNATTENDED` only gates headless creation, and `/loop stop` doesn't stay stopped (task 2).
- **Change:** `PI_LOOP_DISABLE=1` makes the extension skip tool and command registration and worker recovery. Make `/loop stop` record a disabled flag in the store that holds until `/loop start`.
- **Done when:** with either control set, no schedule fires and nothing restarts the worker.

### 7. Per-schedule tool permissions
- **Claude:** `/loop` runs inherit the session's permission prompts. Desktop tasks have a per-task permission mode and an always-allow list.
- **Ours:** every run gets read, write, edit and bash, with no hooks (`src/scheduler.ts:87`).
- **Change:** save an allowed-tools list per schedule and show it in the confirmation. Unattended runs cannot answer prompts, so default to read-only and require an explicit opt-in for write, edit and bash; the global loop extension already defaults to read-only. First check whether pi-durable's `configure()` can restrict tools per conversation.
- **Done when:** a read-only schedule cannot write or run shell commands, which a test proves.

## P2: scheduling features

### 8. Show the next run in local time; accept short IDs
- **Claude:** shows `next run 10:21 AM` after creating a task and in task lists (v2.1.299+); task IDs are 8 characters (CC docs).
- **Ours:** `nextRunAt` is epoch milliseconds in raw JSON, and commands need the full UUID.
- **Change:** create, list and show print the next run in local time plus relative time. Accept any unique ID prefix of at least 8 characters.

### 9. Record skipped runs
- **Desktop:** run history includes skipped runs, with the reason: computer asleep, previous run still in progress, or other tasks already running.
- **Ours:** skipped slots vanish without trace (`nextDue`).
- **Change:** store the number of skipped slots and the reason on each run record, and show them in `show`.

### 10. One-off schedules
- **Claude:** "remind me at 3pm…" or "in 45 minutes…" creates a single-fire task that deletes itself; `CronCreate` takes a recurring/once flag (CC docs).
- **Ours:** recurring only.
- **Change:** support `at <time>` and `in <duration>` one-offs that end after their run.

### 11. Cron schedules and trailing intervals
- **Claude:** `CronCreate` takes 5-field cron in local time with vixie-cron semantics (day-of-month OR day-of-week; no names, `L`, `W` or `?`). v2.1.299 fixed double fires in a repeated DST hour. `/loop` accepts the interval as a leading token (`30m`) or a trailing clause (`every 2 hours`) (CC docs).
- **Ours:** elapsed-time intervals only (`src/protocol.ts:4-23`), and the interval must lead (`src/protocol.ts:14-18`).
- **Change:** add a cron schedule type with a saved IANA time zone, and test DST forward and back. Keep exact elapsed intervals; Claude rounds `7m` and `90m` to cron steps, and we needn't. Since the model writes the schedule anyway, pass `/loop` text without a leading interval to the model instead of rejecting it.

### 12. Self-paced schedules
- **Claude:** `/loop <prompt>` with no interval lets Claude pick the next delay (1 minute to 1 hour) after each iteration, printing the delay and its reason, via `ScheduleWakeup`. `stop: true` ends the loop. If an iteration neither reschedules nor stops, one fallback wakeup fires about 20 minutes later, and the loop ends if that one doesn't reschedule either. The 7-day expiry applies (CC docs; tools reference).
- **Ours:** a missing interval is an error.
- **Change:** give self-paced runs a worker-side `schedule_next` tool (delay of 1 minute to 1 hour, or stop), and commit the next due time from its result. Add the 20-minute fallback and record each chosen delay and reason in run history. This depends on task 13: a fresh conversation can't judge whether anything is pending without the previous result.

## P3: context and results

### 13. Optionally give each run the previous run's result
- **Claude:** runs are turns in one session, so each one sees earlier iterations.
- **Ours:** each run sees only the saved prompt (`src/scheduler.ts:59-60`).
- **Change:** an opt-in flag adds the previous run's stored summary (up to 16,000 characters) to the submitted prompt. Polls like "tell me what changed" then work, and runs stay fresh conversations.

### 14. Show results in Pi sessions
- **Claude:** results appear in the session transcript. Desktop shows a notification and links each run's session from history.
- **Ours:** results are visible only through list and show.
- **Change:** on `session_start` in a schedule's working directory, post runs completed since last seen. Optionally notify open sessions live through the worker socket. Keep the "last seen" marker in the worker store: Pi doesn't write custom session entries until the session has a conversation message.

### 15. Run now
- **Claude/Desktop:** Desktop has **Run now**; `/schedule run` starts a cloud task immediately. The global loop extension has `/loop run <id>`.
- **Ours:** none.
- **Change:** `run <id>` starts one run immediately without moving the schedule's timing, and respects the no-overlap rule.

### 16. Default prompt for bare `/loop`
- **Claude:** bare `/loop` runs a built-in maintenance prompt (continue unfinished work, tend the branch PR, then cleanup), or `.claude/loop.md`, falling back to `~/.claude/loop.md`. The file is re-read every iteration and truncated at 25,000 bytes (CC docs).
- **Ours:** bare `/loop` shows help (`index.ts:79`).
- **Change:** read `.pi/loop.md`, falling back to `~/.pi/agent/loop.md`, at each run, truncated at 25,000 bytes. "Continue unfinished work from the conversation" makes no sense for fresh runs, so the built-in prompt must be rewritten for our model, or `loop.md` made mandatory. Keep `help` for help.

### 17. Skills and project instructions in runs
- **Claude:** a scheduled prompt can be a skill (`/loop 20m /review-pr 1234`), and MCP servers are inherited from the session (CC docs).
- **Ours:** the worker has no skills, extensions, MCP servers or AGENTS.md (README "Scheduling and execution").
- **Change:** either expand prompt templates and skills into the saved prompt at creation, or load the project's AGENTS.md and skills in the worker. Investigate what pi-durable's registry supports first. This is the largest task here.

---

## Not aligning, on purpose

- **Session-scoped lifetime.** Durability is why pi-loop exists; the global loop extension covers the session-scoped case.
- **Same-session runs.** Fresh conversations are a deliberate choice; task 13 adds the useful part.
- **Dropping the creation confirmation.** Claude's cron tools need no permission prompt, but its runs inherit the session's prompts. Ours run unattended with no prompts, so the confirmation stays.
- **Jitter.** Claude starts recurring runs late, by up to half the gap and at most 30 minutes, to spread API load across all users; `*/5` runs at 4m45s to stay inside the prompt cache. For one user's local worker this only makes timing less predictable. Revisit if same-instant schedules hit rate limits.
- **Esc or Ctrl+C to stop.** A detached worker has no foreground wait to interrupt.
- **Running immediately on creation.** One Claude user report shows this, but it isn't documented. Keep the first run after one interval; task 15 gives an explicit run-now.
