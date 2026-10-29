import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type JobOptions, JobQueue, PermanentError, type RetryPolicy } from "../src/jobs.ts";
import { deferred } from "./helpers.ts";

type Input = { n: number };
type Result = { n: number; attempt: number };

const FAST: RetryPolicy = { attempts: 3, backoffMs: 5, maxBackoffMs: 20, timeoutMs: 5000 };

async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 200 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function directory(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "pi-jobs-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function open(t: TestContext, options: Partial<JobOptions<Input, Result>> & Pick<JobOptions<Input, Result>, "run">) {
	return JobQueue.open<Input, Result>({ kind: "test.job", policy: () => FAST, ...options }).then((queue) => {
		t.after(() => queue.close());
		return queue;
	});
}

test("a failed attempt is retried after a backoff, then the job completes", async (t) => {
	const failures: [number, number | undefined][] = [];
	const queue = await open(t, {
		run: async (input, _signal, attempt) => {
			if (attempt < 3) throw new Error(`attempt ${attempt} failed`);
			return { n: input.n, attempt };
		},
		failed: (_error, attempt, retryAt) => failures.push([attempt, retryAt]),
	});
	const id = await queue.enqueue({ n: 7 });
	assert.deepEqual(await queue.wait(id), { status: "completed", result: { n: 7, attempt: 3 } });
	assert.deepEqual(failures.map(([attempt]) => attempt), [1, 2]);
	assert.ok(failures.every(([, retryAt]) => typeof retryAt === "number"));
	assert.deepEqual((await queue.latest())?.result, { n: 7, attempt: 3 });
	assert.deepEqual(await queue.live(), []);
});

test("the last allowed failure fails the job; a permanent error fails it at once", async (t) => {
	let calls = 0;
	const queue = await open(t, {
		run: async (input) => {
			calls++;
			throw input.n === 1 ? new PermanentError("model missing") : new Error("overloaded");
		},
	});
	assert.deepEqual(await queue.wait(await queue.enqueue({ n: 1 })), { status: "failed", error: "model missing" });
	assert.equal(calls, 1);
	assert.deepEqual(await queue.wait(await queue.enqueue({ n: 2 })), { status: "failed", error: "overloaded" });
	assert.equal(calls, 1 + FAST.attempts);
	assert.equal(await queue.latest(), undefined);
});

test("an attempt that hangs is aborted at its timeout and retried", async (t) => {
	const signals: AbortSignal[] = [];
	const queue = await open(t, {
		policy: () => ({ ...FAST, timeoutMs: 30 }),
		run: (input, signal, attempt) => {
			signals.push(signal);
			if (attempt > 1) return Promise.resolve({ n: input.n, attempt });
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		},
	});
	const outcome = await queue.wait(await queue.enqueue({ n: 3 }));
	assert.deepEqual(outcome, { status: "completed", result: { n: 3, attempt: 2 } });
	assert.equal(signals[0]!.aborted, true);
	assert.match(String(signals[0]!.reason), /timed out after 30 ms/);
});

test("enqueue returns at once while the attempt never settles; abort stops it without a retry", async (t) => {
	const started = deferred<AbortSignal>();
	let calls = 0;
	const queue = await open(t, {
		run: (_input, signal) => {
			calls++;
			started.resolve(signal);
			return new Promise(() => {});
		},
	});
	const before = performance.now();
	const id = await queue.enqueue({ n: 1 });
	assert.ok(performance.now() - before < 50, "enqueue does not wait for the attempt");
	const signal = await started.promise;
	await queue.abort(id);
	assert.deepEqual(await queue.wait(id), { status: "aborted" });
	assert.equal(signal.aborted, true);
	assert.equal(calls, 1);
});

test("a job waiting to retry survives a restart and completes in the next process", async (t) => {
	const file = join(await directory(t), "jobs.db");
	let calls = 0;
	const run = async (input: Input, _signal: AbortSignal, attempt: number) => {
		calls++;
		if (attempt === 1) throw new Error("provider down");
		return { n: input.n, attempt };
	};
	const first = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => ({ ...FAST, backoffMs: 60_000, maxBackoffMs: 60_000 }), run });
	assert.equal(first.file, file);
	const id = await first.enqueue({ n: 5 });
	await until(async () => (await first.live())[0]?.status === "sleeping");
	assert.deepEqual((await first.live()).map((job) => [job.id, job.status]), [[id, "sleeping"]]);
	await first.close({ discard: true });
	assert.ok((await readdir(join(file, ".."))).includes("jobs.db"), "an unsettled job keeps its file");
	// The next process uses a short backoff: the stored deadline still applies, so move the clock past it.
	const second = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => FAST, run, now: () => Date.now() + 120_000 });
	t.after(() => second.close());
	assert.deepEqual((await second.live()).map((job) => job.input), [{ n: 5 }]);
	assert.deepEqual(await second.wait(id), { status: "completed", result: { n: 5, attempt: 2 } });
	assert.equal(calls, 2);
	assert.deepEqual((await second.latest())?.input, { n: 5 });
	await second.close({ discard: true });
	assert.deepEqual(await readdir(join(file, "..")), [], "a settled queue deletes its file");
});

test("an attempt interrupted by closing reruns after a restart", async (t) => {
	const file = join(await directory(t), "jobs.db");
	const started = deferred<AbortSignal>();
	const first = await JobQueue.open<Input, Result>({
		kind: "test.job",
		file,
		policy: () => FAST,
		run: (_input, signal) => {
			started.resolve(signal);
			return new Promise(() => {});
		},
	});
	const id = await first.enqueue({ n: 9 });
	const signal = await started.promise;
	await first.close();
	assert.equal(signal.aborted, true);
	const second = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => FAST, run: async (input, _signal, attempt) => ({ n: input.n, attempt }) });
	t.after(() => second.close());
	assert.deepEqual(await second.wait(id), { status: "completed", result: { n: 9, attempt: 1 } });
});

test("recovered jobs are offered before they run: an aborted one never reruns, a kept one resumes", async (t) => {
	const file = join(await directory(t), "jobs.db");
	const first = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => FAST, run: () => new Promise(() => {}) });
	const done = await first.enqueue({ n: 0 });
	await first.close();
	// The second process finishes the first job, then leaves two more.
	const second = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => FAST, run: async (input, _signal, attempt) => ({ n: input.n, attempt }) });
	await second.wait(done);
	await second.close();
	const third = await JobQueue.open<Input, Result>({ kind: "test.job", file, policy: () => FAST, run: () => new Promise(() => {}) });
	const unwanted = await third.enqueue({ n: 1 });
	const wanted = await third.enqueue({ n: 2 });
	await until(async () => (await third.live()).every((job) => job.status === "running"));
	await third.close();
	const runs: number[] = [];
	const found: unknown[] = [];
	const fourth = await open(t, {
		file,
		run: async (input, _signal, attempt) => {
			runs.push(input.n);
			return { n: input.n, attempt };
		},
		recover: async (queue, recovered) => {
			found.push(recovered.latest?.input, recovered.live.map((job) => job.input));
			await queue.abort(unwanted);
		},
	});
	assert.deepEqual(found, [{ n: 0 }, [{ n: 1 }, { n: 2 }]]);
	assert.deepEqual(await fourth.wait(unwanted), { status: "aborted" });
	assert.deepEqual(await fourth.wait(wanted), { status: "completed", result: { n: 2, attempt: 1 } });
	assert.deepEqual(runs, [2], "the aborted job never started an attempt");
});

test("a file another process holds falls back to jobs in memory", async (t) => {
	const file = join(await directory(t), "jobs.db");
	const run = async (input: Input, _signal: AbortSignal, attempt: number) => ({ n: input.n, attempt });
	const owner = await open(t, { file, run });
	assert.equal(owner.file, file);
	const reports: unknown[] = [];
	const other = await open(t, { file, run, report: (error) => reports.push(error) });
	assert.equal(other.file, undefined);
	assert.deepEqual(reports, []);
	assert.equal((await other.wait(await other.enqueue({ n: 1 }))).status, "completed");
});

test("idle waits for running attempts only", async (t) => {
	const release = deferred<void>();
	const queue = await open(t, {
		run: async (input, _signal, attempt) => {
			if (input.n === 1) await release.promise;
			if (input.n === 2) throw new Error("retry later");
			return { n: input.n, attempt };
		},
		policy: () => ({ ...FAST, backoffMs: 60_000, maxBackoffMs: 60_000 }),
	});
	const sleeping = await queue.enqueue({ n: 2 });
	await until(async () => (await queue.live())[0]?.status === "sleeping");
	const running = await queue.enqueue({ n: 1 });
	await new Promise((resolve) => setTimeout(resolve, 20));
	let idle = false;
	const waiting = queue.idle().then(() => {
		idle = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(idle, false);
	release.resolve();
	await waiting;
	assert.equal((await queue.wait(running)).status, "completed");
	assert.deepEqual((await queue.live()).map((job) => [job.id, job.status]), [[sleeping, "sleeping"]]);
});
