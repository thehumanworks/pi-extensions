# loop — durable scheduled Pi runs

A Pi extension with a **`/loop` command** and a model-callable **`loop` tool**. Schedule a recurring task once; a detached worker runs it on the host using **`@earendil-works/pi-durable`**.

```text
/loop 5m check whether the latest CI build has finished
/loop 2h summarize new entries in ./events.log
/loop 1d check the status of the issue we discussed
```

The command asks the current agent to turn your request into a self-contained prompt. Its instructions explicitly require preserving your goal and constraints, resolving references only from known facts, and **not adding requirements or scope**. It does not run the task immediately. You confirm the exact prompt, interval, working directory, and model before the schedule is saved.

## Install

Requires **Pi 1.3.0+**, **Node.js 22.19+** on PATH, and macOS or Linux.

From this directory:

```sh
npm ci --ignore-scripts
pi install .
# Or try it for one session:
pi -e ./index.ts
```

For an npm/git distribution, install it with Pi's usual `pi install` command. Compiled worker files in `dist/` are included, so installed packages do not need a TypeScript runtime or lifecycle scripts. Set `PI_LOOP_NODE=/absolute/path/to/node` if Node is not on Pi's PATH. The standalone Pi executable is **not** a Node executable.

This project is not published to npm by these instructions.

## Commands

| Command | Action |
| --- | --- |
| `/loop <interval> <task>` | Have the agent prepare and create a schedule |
| `/loop` or `/loop help` | Help |
| `/loop list` | Show schedules, recent results and task state |
| `/loop show <id>` | Show one schedule, its exact prompt and results |
| `/loop pause <id>` | Pause and abort an in-flight run |
| `/loop resume <id>` | Resume; next run is one interval from now |
| `/loop delete <id>` | Cancel and remove from the active list |
| `/loop start` | Start the worker and recover unfinished work |
| `/loop stop` | Stop the worker without deleting schedules |

Use the full schedule ID returned at creation. Commands other than creation act directly, without spending a model turn.

Intervals are positive numbers followed by `s`, `m`, `h`, `d`, or `w`, such as `30s`, `5m`, `1.5h`, or `1d`. Supported range: one second to 365 days, at whole-millisecond precision. These are elapsed-time intervals, not calendar/cron schedules. Natural-language requests made to the agent can be translated to these intervals; ambiguous requests should be clarified.

## Agent tool

The `loop` tool accepts:

```json
{
  "action": "create",
  "frequency": "5m",
  "prompt": "Check whether the latest CI build has finished."
}
```

Other actions:

```json
{ "action": "list" }
{ "action": "show", "id": "<schedule-id>" }
{ "action": "pause", "id": "<schedule-id>" }
{ "action": "resume", "id": "<schedule-id>" }
{ "action": "delete", "id": "<schedule-id>" }
```

Creation uses the calling session's current working directory, model and thinking level. The tool works in interactive/RPC sessions with confirmation support. In headless sessions, creation requires **`PI_LOOP_ALLOW_UNATTENDED=1`**, explicitly authorizing persistent unattended jobs. Listing and managing existing jobs do not require that variable.

## Scheduling and execution

- **First run:** one interval after creation, not immediately.
- **No overlap within a schedule:** its next run is not admitted until the current run settles. Different schedules may run concurrently.
- **Fixed cadence:** run times stay on the schedule's original interval grid.
- **Missed ticks coalesce:** after sleep, downtime, or a long-running task, execute one overdue run, then use the next future slot. No catch-up storm.
- **Fresh conversation per run:** every run receives the same saved prompt. It does not inherit the creator's conversation history.
- **Actual host tools:** durable `read`, `write`, `edit`, and `bash`, in the saved directory.
- **Model configuration:** standard Pi credentials, environment-based credentials and `models.json`, via Pi's model runtime. Session-only custom/virtual providers are not inherited and unavailable model IDs are rejected.
- **Results:** the last 20 summaries per schedule (up to 16,000 characters each) are returned by list/show. Full durable conversations remain in SQLite.
- Ordinary unanswered/model-error runs are recorded and the schedule continues. A faulted scheduler task is visible in `taskState`; `/loop resume <id>` can replace its terminal task.

Scheduled runs **do not load the interactive session's extensions, MCP servers, skills, project instructions or permission hooks**. Include task-specific facts in the saved prompt, or make the required information available through the host tools. Do not schedule a task that relies on a tool the worker does not have.

## Durability and lifecycle

The worker owns one SQLite-backed durable harness. Each schedule is a versioned durable task with two phases:

1. Sleep until the persisted due time; atomically create a run conversation and checkpoint its ID.
2. Submit the saved prompt with a stable request ID, wait for its result, and atomically save the result and next due time.

The schedule document, task checkpoints, model turns, tool intents/results and conversations are all stored through `pi-durable`. They are **not** reconstructed from an in-memory timer or an ad hoc JSON job list. A repeated create request is idempotent; repeating a deleted request does not resurrect it.

The worker is detached from the terminal, so **closing Pi does not stop schedules**. One OS-held exclusive SQLite lock protects the store from multiple workers; the kernel releases it on process death, and it does not expire while the laptop sleeps.

**There is no OS startup service installed automatically.** If the host reboots or the worker crashes, work is recovered when Pi next loads this extension or when you run `/loop start`. To recover without reopening Pi, supervise the absolute command `/path/to/node /path/to/pi-loop/dist/worker.js` with launchd/systemd, using the same environment and data directory. The computer must be awake and able to reach the model provider to execute tasks.

Durability is **not exactly-once execution of external effects**. Pi-durable does not blindly replay an interrupted unsafe tool; it reports the interruption to the recovering model. A shell subprocess may outlive a killed worker, and effects completed before a crash cannot be undone. Use idempotent task operations when this matters. Pausing/deleting also cannot undo completed effects.

## Data, credentials and security

Defaults to `~/.pi/agent/loop/` (or `$PI_CODING_AGENT_DIR/loop/`):

- `loop.sqlite`: schedule metadata, prompts, run history and durable execution state.
- `loop.sqlite.owner`: worker ownership lock.
- `worker.sock`: local control socket.
- `worker.log`: diagnostics.

Use **`PI_LOOP_HOME`** for a different, dedicated directory. The directory is made owner-only, the socket is owner-only, and only the worker opens the harness. Anyone with access to this directory can read prompts/results and control schedules.

The worker runs with your permissions and can spend model/API credits. Confirm only tasks you trust. It inherits the environment from the Pi process that starts it, including API credentials, PATH and project environment variables. The cwd and model are stored per schedule, but the environment is worker-wide. Restart the worker after changing credentials in the environment or model configuration. Do not use one worker to mix mutually untrusted project environments.

Deleted schedules are retained as tombstones for idempotency and audit; old full conversations are also retained. There is currently no automatic database/log pruning. Stop the worker before backing up or removing its directory. Removing the directory permanently removes all schedules and results.

## Development

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm pack --dry-run
```

`index.ts` is the Pi integration; `src/scheduler.ts` owns durable scheduling; `src/worker.ts` is the single-writer host process; `src/client.ts` is the socket/startup client. Rebuild and include `dist/` whenever changing worker code. The checked-in generated files also support git installs that disable lifecycle scripts.

Tests use Pi's faux model provider, not paid API calls. They cover interval parsing, scope-preserving command dispatch, confirmations, idempotency, host file tools, isolated runs, pause/resume/delete, SQLite recovery, socket request/reply lifecycle, competing worker processes, and SIGKILL in the middle of a shell tool without replaying its side effect.

To also test recovery in fresh sessions of an installed Pi executable (including Bun-based standalone builds), run `PI_LOOP_TEST_PI="$(command -v pi)" npm test`. This starts isolated RPC sessions without making model calls or touching existing schedules.

`pi-durable` is experimental, so the worker runtime and durable library are pinned to 1.3.0. `pi-loop-runtime` is an npm alias for the coding-agent runtime used **only in the separate worker process**. The extension itself imports host APIs as peer dependencies; it does not instantiate a second coding-agent runtime inside Pi.
