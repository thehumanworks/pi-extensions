import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig } from "../src/config.ts";
import { BackgroundCompactor, type Snapshot, type SummaryJob, type SummaryOutput } from "../src/controller.ts";
import { assistant, config, deferred, session, tick, usage, words } from "./helpers.ts";

// A 40k-token window that compacts at 32k: the background summary starts at 80% of that, 25.6k.
const SETTINGS = { enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 };

function snapshot(manager: SessionManager, tokens: number | null): Snapshot {
	return { branch: manager.getBranch(), tokens, contextWindow: 40_000, settings: SETTINGS, transcript: true };
}

function harness(overrides: Partial<BackgroundCompactionConfig> = {}) {
	const jobs: { job: SummaryJob; result: ReturnType<typeof deferred<SummaryOutput>> }[] = [];
	const events: Record<string, unknown>[] = [];
	const settings = config(overrides);
	const compactor = new BackgroundCompactor({
		config: () => settings,
		summarize: (job) => {
			const result = deferred<SummaryOutput>();
			jobs.push({ job, result });
			return result.promise;
		},
		trace: (event) => events.push(event),
	});
	const finish = async (index: number, text = `summary ${index}`) => {
		jobs[index]!.result.resolve({ text, usage: usage(100), model: "test/summarizer" });
		await tick();
	};
	return { compactor, jobs, events, finish };
}

const signal = () => new AbortController().signal;

test("starts a background summary only past the trigger", () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness();
	compactor.observe(snapshot(manager, 20_000), "turn");
	assert.equal(jobs.length, 0);
	compactor.observe(snapshot(manager, 26_000), "turn");
	assert.equal(jobs.length, 1);
	assert.equal(compactor.state, "writing");
	// One summary at a time.
	compactor.observe(snapshot(manager, 27_000), "turn");
	assert.equal(jobs.length, 1);
});

test("swaps the held summary in without another request", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, events } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const plan = jobs[0]!.job.plan;
	await finish(0);
	assert.equal(compactor.state, "ready");
	// The conversation continues; the held summary keeps everything since verbatim.
	manager.appendMessage({ role: "user", content: words(1500), timestamp: Date.now() });
	manager.appendMessage(assistant(words(1500)));
	const result = (await compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" }))!;
	assert.equal(jobs.length, 1);
	assert.equal(result.firstKeptEntryId, plan.firstKeptEntryId);
	assert.equal(result.summary, "summary 0");
	assert.equal(result.tokensBefore, 33_000);
	assert.equal(result.usage!.totalTokens, 100);
	assert.equal(compactor.state, "idle");
	assert.equal(events.at(-1)!.event, "swap");
	assert.equal(events.at(-1)!.source, "background");
});

test("compaction waits for a summary still being written", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const taking = compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" });
	await tick();
	assert.equal(jobs.length, 1);
	await finish(0, "late summary");
	const result = await taking;
	assert.equal(result!.summary, "late summary");
	assert.equal(jobs.length, 1);
});

test("aborting compaction stops waiting but keeps the background summary", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const abort = new AbortController();
	const taking = compactor.take(snapshot(manager, 33_000), abort.signal, { tokensBefore: 33_000, reason: "threshold" });
	abort.abort();
	assert.equal(await taking, undefined);
	assert.equal(jobs[0]!.job.signal.aborted, false);
	await finish(0);
	assert.equal(compactor.state, "ready");
});

test("a summary that fell behind is caught up with only the new messages", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const first = jobs[0]!.job.plan;
	await finish(0, "summary of the start");
	// 14k tokens arrive at once: swapping now would leave 18k, over half the 32k threshold.
	manager.appendMessage({ role: "user", content: words(7000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(7000)));
	const taking = compactor.take(snapshot(manager, 34_000), signal(), { tokensBefore: 34_000, reason: "threshold" });
	await tick();
	assert.equal(jobs.length, 2);
	const catchUp = jobs[1]!.job;
	assert.equal(catchUp.mode, "serialized");
	assert.equal(catchUp.plan.previousSummary, "summary of the start");
	assert.equal(catchUp.plan.entryIds[0], first.firstKeptEntryId);
	await finish(1, "caught up");
	const result = (await taking)!;
	assert.equal(result.summary, "caught up");
	assert.equal(result.usage!.totalTokens, 200);
	assert.notEqual(result.firstKeptEntryId, first.firstKeptEntryId);
});

test("a failed catch-up still swaps the held summary when it gets under the threshold", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "held");
	manager.appendMessage({ role: "user", content: words(7000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(7000)));
	const taking = compactor.take(snapshot(manager, 34_000), signal(), { tokensBefore: 34_000, reason: "threshold" });
	await tick();
	jobs[1]!.result.reject(new Error("overloaded"));
	const result = (await taking)!;
	assert.equal(result.summary, "held");
	assert.equal((result.details as { backgroundCompaction: { caughtUp: boolean } }).backgroundCompaction.caughtUp, false);
});

test("a held summary is refreshed in the background when it falls behind early", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "first");
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	compactor.observe(snapshot(manager, 30_000), "turn");
	assert.equal(jobs.length, 2);
	assert.equal(jobs[1]!.job.plan.previousSummary, "first");
	await finish(1, "refreshed");
	const result = (await compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" }))!;
	assert.equal(result.summary, "refreshed");
	assert.equal(jobs.length, 2);
});

test("compaction does not wait for a refresh when the held summary still fits", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "first");
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	compactor.observe(snapshot(manager, 30_000), "turn");
	assert.equal(jobs.length, 2);
	const result = (await compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" }))!;
	assert.equal(result.summary, "first");
	assert.equal(jobs[1]!.job.signal.aborted, true);
});

test("without a usable summary, compaction writes one now", async () => {
	const { manager, ids } = session(14, 1000);
	const { compactor, jobs, finish, events } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	// Moving to another branch discards the held summary.
	manager.branch(ids[20]!);
	manager.appendMessage({ role: "user", content: words(500), timestamp: Date.now() });
	const taking = compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" });
	await tick();
	assert.equal(jobs.length, 2);
	assert.equal(jobs[1]!.job.plan.previousSummary, undefined);
	await finish(1, "fresh");
	assert.equal((await taking)!.summary, "fresh");
	assert.ok(events.some((event) => event.event === "discarded"));
	assert.equal(events.at(-1)!.source, "foreground");
});

test("a stale summary that still frees enough room is swapped in without blocking", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	// 10k arrived since: past the 8k refresh bound, but the swap leaves ~14k of the 32k threshold.
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	const result = (await compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" }))!;
	assert.equal(jobs.length, 1);
	assert.equal(result.summary, "summary 0");
});

test("no refresh starts at the boundary where Pi compacts", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	compactor.observe(snapshot(manager, 33_000), "turn");
	assert.equal(jobs.length, 1);
});

test("foreground summaries use transcript requests, except for overflow", async () => {
	const { manager } = session(14, 1000);
	for (const [reason, mode] of [["threshold", "transcript"], ["overflow", "serialized"]] as const) {
		const { compactor, jobs, finish } = harness({ request: "auto" });
		const taking = compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason });
		await tick();
		assert.equal(jobs[0]!.job.mode, mode);
		await finish(0);
		assert.ok(await taking);
	}
});

test("compaction instructions bypass the held summary", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	const taking = compactor.take(snapshot(manager, 20_000), signal(), { tokensBefore: 20_000, reason: "manual", customInstructions: "focus on tests" });
	await tick();
	assert.equal(jobs[1]!.job.focus, "focus on tests");
	await finish(1, "focused");
	assert.equal((await taking)!.summary, "focused");
});

test("a failed foreground summary defers to Pi", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness();
	const taking = compactor.take(snapshot(manager, 33_000), signal(), { tokensBefore: 33_000, reason: "threshold" });
	await tick();
	jobs[0]!.result.reject(new Error("provider down"));
	assert.equal(await taking, undefined);
	assert.equal(compactor.stats.deferred, 1);
});

test("two failures in a row stop background summaries until the next compaction", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness();
	for (let i = 0; i < 2; i++) {
		compactor.observe(snapshot(manager, 26_000), "turn");
		jobs[i]!.result.reject(new Error("rate limited"));
		await tick();
	}
	compactor.observe(snapshot(manager, 27_000), "turn");
	assert.equal(jobs.length, 2);
	compactor.reset("compacted");
	compactor.observe(snapshot(manager, 27_000), "turn");
	assert.equal(jobs.length, 3);
});

test("transcript requests send the whole conversation", () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness({ request: "auto" });
	compactor.observe(snapshot(manager, 26_000), "turn");
	assert.equal(jobs[0]!.job.mode, "transcript");
	assert.equal(jobs[0]!.job.transcript!.length, 28);
	const other = harness({ request: "auto" });
	other.compactor.observe({ ...snapshot(manager, 26_000), transcript: false }, "turn");
	assert.equal(other.jobs[0]!.job.mode, "serialized");
});

test("swap: ready applies the summary at the next turn", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish } = harness({ swap: "ready" });
	compactor.observe(snapshot(manager, 26_000), "turn");
	assert.equal(compactor.ready(snapshot(manager, 26_000)), undefined);
	await finish(0);
	const draft = compactor.ready(snapshot(manager, 27_000))!;
	assert.equal(draft.type, "compaction");
	assert.equal(draft.firstKeptEntryId, jobs[0]!.job.plan.firstKeptEntryId);
	assert.equal(compactor.state, "idle");
});

test("waits for a boundary where the cut can fall after a large tool result", () => {
	const { manager } = session(14, 1000);
	manager.appendMessage(assistant("", { content: [{ type: "toolCall", id: "big", name: "read", arguments: { path: "log.txt" } }], stopReason: "toolUse" }));
	manager.appendMessage({ role: "toolResult", toolCallId: "big", toolName: "read", content: [{ type: "text", text: words(12_000) }], isError: false, timestamp: Date.now() });
	const { compactor, jobs, events } = harness();
	compactor.observe(snapshot(manager, 40_000), "turn");
	assert.equal(jobs.length, 0);
	assert.equal(events.at(-1)!.event, "postponed");
	manager.appendMessage(assistant("the log shows a crash"));
	compactor.observe(snapshot(manager, 40_100), "turn");
	assert.equal(jobs.length, 1);
	assert.ok(jobs[0]!.job.plan.keptTokens < 100);
});

test("disabled Pi auto-compaction leaves the session alone", () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness();
	compactor.observe({ ...snapshot(manager, 30_000), settings: { ...SETTINGS, enabled: false } }, "turn");
	assert.equal(jobs.length, 0);
});

test("the minimum size wins over the trigger", () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs } = harness({ minTokens: 28_000 });
	compactor.observe(snapshot(manager, 26_000), "turn");
	assert.equal(jobs.length, 0);
	compactor.observe(snapshot(manager, 28_500), "turn");
	assert.equal(jobs.length, 1);
});
