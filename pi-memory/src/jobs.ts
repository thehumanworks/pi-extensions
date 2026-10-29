// Vendored in pi-background-compaction and pi-memory, which publish separately: keep both copies identical.
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness, SessionDocToken, SetTimer, Storage, Task, TaskId } from "@earendil-works/pi-durable";

/** How a job is retried. */
export interface RetryPolicy {
	/** Attempts per job, including the first. */
	attempts: number;
	/** Wait before the second attempt; it doubles for each later one, up to `maxBackoffMs`. */
	backoffMs: number;
	maxBackoffMs: number;
	/** Each attempt is aborted after this long. */
	timeoutMs: number;
}

/** A failure that another attempt cannot fix, such as a missing model: the job fails at once. */
export class PermanentError extends Error {}

export type JobOutcome<R> = { status: "completed"; result: R } | { status: "failed"; error: string } | { status: "aborted" };

export interface JobOptions<I, R> {
	/** Durable task name, unique to the extension. */
	kind: string;
	/** SQLite file for the jobs. Without one, or while another process holds it, jobs are kept in memory. */
	file?: string;
	policy(): RetryPolicy;
	/** One attempt. Input and result are JSON; an attempt may run again after a restart, so it must be safe to repeat. */
	run(input: I, signal: AbortSignal, attempt: number): Promise<R>;
	/** An attempt failed: `retryAt` is when the next one starts, or undefined when the job has failed. */
	failed?(error: unknown, attempt: number, retryAt: number | undefined): void;
	/**
	 * Called once on opening, before any job runs, with what an earlier process left: its unsettled jobs
	 * and its last completed one. Abort the jobs that are no longer wanted; the rest resume.
	 */
	recover?(queue: JobQueue<I, R>, found: Recovered<I, R>): Promise<void> | void;
	/** Failures outside a job's own attempts, such as storage errors. */
	report?(error: unknown): void;
	now?: () => number;
	setTimer?: SetTimer;
}

export interface Recovered<I, R> {
	live: { id: number; input: I; status: string }[];
	latest?: { id: number; input: I; result: R };
}

type Checkpoint = { phase: "run"; attempt: number } | { phase: "backoff"; attempt: number; until: number };

interface Runtime {
	durable: typeof import("@earendil-works/pi-durable");
	createModels: typeof import("@earendil-works/pi-ai").createModels;
	openSqlite: typeof import("@earendil-works/pi-durable/storage/sqlite/node").openNodeSqliteStorage;
	context: Context;
}

// Shared by every extension in the process that uses this pinned pi-durable version.
const RUNTIME = Symbol.for("@nothumanwork/pi-durable-runtime@1.4.0");
// Files still being closed, across reloads of the extension: a file opens only once its last close is done.
const CLOSING = Symbol.for("@nothumanwork/pi-durable-closing");

function closing(): Map<string, Promise<void>> {
	const shared = globalThis as { [CLOSING]?: Map<string, Promise<void>> };
	shared[CLOSING] ??= new Map();
	return shared[CLOSING];
}

/**
 * pi-durable, loaded once per process and shared by every extension that vendors this file. A cold
 * load holds the event loop for about 0.2 s, so it never runs on a caller's stack: hooks that start a
 * job return first.
 */
function runtime(): Promise<Runtime> {
	const shared = globalThis as { [RUNTIME]?: Promise<Runtime> };
	shared[RUNTIME] ??= (async () => {
		await new Promise((resolve) => setImmediate(resolve));
		const [durable, ai, sqlite, chord] = await Promise.all([
			import("@earendil-works/pi-durable"),
			import("@earendil-works/pi-ai"),
			import("@earendil-works/pi-durable/storage/sqlite/node"),
			import("@earendil-works/chord/context"),
		]);
		return { durable, createModels: ai.createModels, openSqlite: sqlite.openNodeSqliteStorage, context: chord.BACKGROUND_CONTEXT };
	})().catch((error: unknown) => {
		delete shared[RUNTIME];
		throw error;
	});
	return shared[RUNTIME];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Timers that never keep the process alive: a pending retry must not delay Pi's exit. */
const unrefTimer: SetTimer = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/** Holds `file` for this process until released; undefined when another process holds it. */
async function claim(file: string): Promise<(() => void) | undefined> {
	const { DatabaseSync } = await import("node:sqlite");
	const owner = new DatabaseSync(`${file}.owner`);
	try {
		owner.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
	} catch (error) {
		owner.close();
		if ((error as { errcode?: number }).errcode === 5) return undefined;
		throw error;
	}
	return () => owner.close();
}

/**
 * Background jobs on pi-durable. Each attempt runs off the caller's path, failures are retried
 * with backoff, and with a file the jobs and their results survive a restart.
 */
export class JobQueue<I, R> {
	private readonly attempts = new Set<Promise<unknown>>();
	private closing?: Promise<void>;

	private constructor(
		private readonly harness: Harness,
		private readonly root: Conversation,
		private readonly task: Task<I, Checkpoint, R, object>,
		private readonly last: SessionDocToken<{ last: number | null }>,
		private readonly context: Context,
		private readonly options: JobOptions<I, R>,
		private readonly release: (() => void) | undefined,
		/** The SQLite file, when the jobs survive a restart. */
		readonly file: string | undefined,
	) {}

	static async open<I, R>(options: JobOptions<I, R>): Promise<JobQueue<I, R>> {
		const { durable, createModels, openSqlite, context } = await runtime();
		let storage: Storage | undefined;
		let release: (() => void) | undefined;
		if (options.file) {
			try {
				await closing().get(options.file);
				await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
				release = await claim(options.file);
				if (release) storage = await openSqlite(options.file);
			} catch (error) {
				release?.();
				release = undefined;
				options.report?.(error);
			}
		}
		const last = durable.defineDoc<{ last: number | null }>({
			kind: `${options.kind}.last`,
			version: 1,
			scope: "session",
			initial: () => ({ last: null }),
			checkpointWhen: () => true,
		});
		let queue: JobQueue<I, R> | undefined;
		const task = durable.defineTask<I, Checkpoint, R>({
			name: options.kind,
			version: 1,
			initial: () => ({ phase: "run", attempt: 1 }),
			phases: {
				backoff: (job, runtime, ctx) =>
					runtime.sleepUntil(job.state.checkpoint.until, { phase: "run", attempt: job.state.checkpoint.attempt }, ctx),
				run: async (job, runtime, ctx) => {
					const { attempt } = job.state.checkpoint;
					const policy = options.policy();
					const timeout = new AbortController();
					const disarm = runtime.setTimer(() => timeout.abort(new Error(`timed out after ${policy.timeoutMs} ms`)), policy.timeoutMs);
					const signal = AbortSignal.any([runtime.signal, timeout.signal]);
					// An attempt that ignores its signal still ends at an abort or its timeout; its late result is dropped.
					const stopped = new Promise<never>((_resolve, reject) => {
						if (signal.aborted) reject(signal.reason);
						else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
					const work = Promise.race([Promise.resolve().then(() => options.run(job.input, signal, attempt)), stopped]);
					const tracked = work.catch(() => undefined);
					queue?.attempts.add(tracked);
					try {
						const result = await work;
						await runtime.commit(async (tx) => {
							(await tx.doc(last)).last = Number(job.id);
							return { status: "terminal", outcome: { status: "completed", result } };
						}, ctx);
					} catch (error) {
						// Closing or an explicit abort: the abort phase, or the next process, takes over.
						if (runtime.signal.aborted) throw error;
						const retry = !(error instanceof PermanentError) && attempt < policy.attempts;
						const until = retry ? runtime.now() + Math.min(policy.backoffMs * 2 ** (attempt - 1), policy.maxBackoffMs) : undefined;
						options.failed?.(error, attempt, until);
						await runtime.commit(
							() =>
								until === undefined
									? { status: "terminal", outcome: { status: "failed", error: { message: message(error) } } }
									: { status: "running", checkpoint: { phase: "backoff", attempt: attempt + 1, until } },
							ctx,
						);
					} finally {
						disarm();
						queue?.attempts.delete(tracked);
					}
				},
			},
			abort: (_job, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const registry = durable.createRegistry();
		registry.install(durable.defineExtension({ name: options.kind, tasks: [task] }));
		let harness: Harness | undefined;
		harness = await durable.Harness.open(
			storage ?? new durable.MemoryStorage(),
			{
				models: createModels(),
				registry,
				now: options.now,
				setTimer: options.setTimer ?? unrefTimer,
				onReport: (error, info) => {
					// A job interrupted by too many restarts is given up rather than left parked.
					if (info.type === "task_parked") void harness?.abortTask(info.task.id, context).catch(() => undefined);
					options.report?.(error);
				},
			},
			context,
		);
		const root = await harness.root(context);
		queue = new JobQueue<I, R>(harness, root, task, last, context, options, release, storage ? options.file : undefined);
		if (options.recover) {
			try {
				await options.recover(queue, { live: await queue.live(), latest: await queue.latest() });
			} catch (error) {
				options.report?.(error);
			}
		}
		harness.resume();
		return queue;
	}

	/** Start a job; it runs in the background. */
	async enqueue(input: I): Promise<number> {
		// Stored input is JSON: drop undefined fields rather than fail the commit.
		const json = JSON.parse(JSON.stringify(input)) as I;
		const id = await this.root.commit((tx) => tx.createTask(this.task, json, { ownership: { kind: "conversation" }, background: true }), this.context);
		this.harness.resume();
		return Number(id);
	}

	/** The job's outcome once it settles. A job left unsettled by closing the queue reports aborted. */
	async wait(id: number): Promise<JobOutcome<R>> {
		try {
			const settled = await this.harness.waitForTask(id as TaskId<R>, this.context);
			const outcome = settled.state.outcome;
			if (outcome.status === "completed") return { status: "completed", result: outcome.result };
			if (outcome.status === "failed" || outcome.status === "faulted") return { status: "failed", error: outcome.error.message };
			return { status: "aborted" };
		} catch {
			return { status: "aborted" };
		}
	}

	/** Stop a job: a running attempt is aborted and no retry follows. */
	async abort(id: number): Promise<void> {
		await this.harness.abortTask(id as TaskId, this.context).catch(() => undefined);
	}

	/** Jobs not yet settled, including those an earlier process left. */
	async live(): Promise<{ id: number; input: I; status: string }[]> {
		const { tasks } = await this.harness.inspect(this.context);
		return tasks
			.filter((item) => item.record.kind === this.options.kind && !item.record.abortRequested)
			.map((item) => ({ id: Number(item.record.id), input: item.record.input as I, status: item.record.state.status }));
	}

	/** The most recently completed job, with its result. */
	async latest(): Promise<{ id: number; input: I; result: R } | undefined> {
		const id = (await this.harness.snapshot(this.last, this.context))?.last;
		if (id === null || id === undefined) return undefined;
		const record = await this.harness.getTask(id as TaskId<R>, this.context);
		if (record?.state.status !== "terminal" || record.state.outcome.status !== "completed") return undefined;
		return { id, input: record.input as I, result: record.state.outcome.result };
	}

	/** Resolves when no attempt is running in this process; jobs waiting to retry do not count. */
	async idle(): Promise<void> {
		while (this.attempts.size) await Promise.all([...this.attempts]);
	}

	/**
	 * Stop running attempts. Unsettled jobs stay stored and resume when the file is opened again;
	 * `discard` deletes the file when none is left.
	 */
	close(options: { discard?: boolean } = {}): Promise<void> {
		if (this.closing) return this.closing;
		const file = this.file;
		const done = (async () => {
			let live = 1;
			try {
				live = (await this.live()).length;
			} catch (error) {
				this.options.report?.(error);
			}
			await this.harness.close(this.context).catch((error: unknown) => this.options.report?.(error));
			this.release?.();
			if (!options.discard || !file || live > 0) return;
			for (const suffix of ["", "-wal", "-shm", "-journal", ".owner"]) await rm(file + suffix, { force: true });
		})();
		const closed = done.finally(() => {
			if (file && closing().get(file) === closed) closing().delete(file);
		});
		this.closing = closed;
		if (file) closing().set(file, closed);
		return closed;
	}
}
