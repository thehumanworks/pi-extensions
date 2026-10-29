import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig } from "../src/config.ts";
import { BackgroundCompactor, type Decision, type Snapshot, type SummaryJob, type SummaryOutput } from "../src/controller.ts";
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
	const clock = { now: 1_000_000 };
	const compactor = new BackgroundCompactor({
		config: () => settings,
		summarize: (job) => {
			const result = deferred<SummaryOutput>();
			jobs.push({ job, result });
			return result.promise;
		},
		trace: (event) => events.push(event),
		now: () => clock.now,
	});
	const finish = async (index: number, text = `summary ${index}`) => {
		jobs[index]!.result.resolve({ text, usage: usage(100), model: "test/summarizer" });
		await tick();
	};
	const fail = async (index: number, error = "provider down") => {
		jobs[index]!.result.reject(new Error(error));
		await tick();
	};
	const take = (manager: SessionManager, tokens: number, reason = "threshold", customInstructions?: string) =>
		compactor.take(snapshot(manager, tokens), { tokensBefore: tokens, reason, customInstructions });
	return { compactor, jobs, events, finish, fail, take, clock };
}

function swapped(decision: Decision | undefined): CompactionResult {
	assert.ok(decision && "compaction" in decision, `expected a swap, got ${JSON.stringify(decision)}`);
	return decision.compaction;
}

function deferredBecause(decision: Decision | undefined): string {
	assert.ok(decision && "deferred" in decision, `expected a deferral, got ${JSON.stringify(decision)}`);
	return decision.deferred;
}

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
	const { compactor, jobs, finish, events, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const plan = jobs[0]!.job.plan;
	await finish(0);
	assert.equal(compactor.state, "ready");
	// The conversation continues; the held summary keeps everything since verbatim.
	manager.appendMessage({ role: "user", content: words(1500), timestamp: Date.now() });
	manager.appendMessage(assistant(words(1500)));
	const result = swapped(take(manager, 33_000));
	assert.equal(jobs.length, 1);
	assert.equal(result.firstKeptEntryId, plan.firstKeptEntryId);
	assert.equal(result.summary, "summary 0");
	assert.equal(result.tokensBefore, 33_000);
	assert.equal(result.usage!.totalTokens, 100);
	assert.deepEqual((result.details as { backgroundCompaction: { stale: boolean; deferrals: number } }).backgroundCompaction, {
		...(result.details as { backgroundCompaction: object }).backgroundCompaction,
		stale: false,
		deferrals: 0,
	});
	assert.equal(compactor.state, "idle");
	assert.equal(events.at(-1)!.event, "swap");
});

test("compaction never waits: it defers while the summary is written, then swaps it at a later check", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take, events } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	// take() is synchronous: it returns while the request is still unanswered.
	assert.equal(deferredBecause(take(manager, 33_000)), "writing");
	assert.equal(deferredBecause(take(manager, 33_500)), "writing");
	assert.equal(jobs.length, 1, "deferring does not start another request");
	assert.equal(jobs[0]!.job.signal.aborted, false, "deferring keeps the background request");
	await finish(0, "late summary");
	const result = swapped(take(manager, 34_000));
	assert.equal(result.summary, "late summary");
	assert.equal((result.details as { backgroundCompaction: { deferrals: number } }).backgroundCompaction.deferrals, 2);
	assert.equal(compactor.stats.deferred, 2);
	assert.deepEqual(events.map((event) => event.event), ["start", "deferred", "deferred", "ready", "swap"]);
});

test("a summary that fell behind is caught up in the background with only the new messages", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	const first = jobs[0]!.job.plan;
	await finish(0, "summary of the start");
	// 14k tokens arrive at once: swapping now would leave 18k, over half the 32k threshold.
	manager.appendMessage({ role: "user", content: words(7000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(7000)));
	assert.equal(deferredBecause(take(manager, 34_000)), "catching up");
	assert.equal(jobs.length, 2);
	const catchUp = jobs[1]!.job;
	assert.equal(catchUp.mode, "serialized");
	assert.equal(catchUp.reason, "catch-up");
	assert.equal(catchUp.plan.previousSummary, "summary of the start");
	assert.equal(catchUp.plan.entryIds[0], first.firstKeptEntryId);
	assert.equal(deferredBecause(take(manager, 34_500)), "catching up");
	await finish(1, "caught up");
	const result = swapped(take(manager, 35_000));
	assert.equal(result.summary, "caught up");
	assert.equal(result.usage!.totalTokens, 200);
	assert.notEqual(result.firstKeptEntryId, first.firstKeptEntryId);
});

test("a failed catch-up still swaps the held summary when it gets under the threshold", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, fail, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "held");
	manager.appendMessage({ role: "user", content: words(7000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(7000)));
	deferredBecause(take(manager, 34_000));
	await fail(1, "overloaded");
	const result = swapped(take(manager, 34_000));
	assert.equal(result.summary, "held");
	assert.equal((result.details as { backgroundCompaction: { stale: boolean } }).backgroundCompaction.stale, true);
	assert.equal(jobs.length, 2);
});

test("overflow swaps a held summary that frees room instead of waiting for a catch-up", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "held");
	manager.appendMessage({ role: "user", content: words(7000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(7000)));
	const result = swapped(take(manager, 41_000, "overflow"));
	assert.equal(result.summary, "held");
	assert.equal(jobs.length, 1);
});

test("a held summary that frees nothing is caught up in the background", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "held");
	// 30k arrive: summary plus kept tail would be over the 32k threshold.
	manager.appendMessage({ role: "user", content: words(15_000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(15_000)));
	assert.equal(deferredBecause(take(manager, 50_000, "overflow")), "catching up");
	assert.equal(jobs.length, 2);
	assert.equal(jobs[1]!.job.plan.previousSummary, "held");
	await finish(1, "caught up");
	assert.equal(swapped(take(manager, 50_000, "overflow")).summary, "caught up");
});

test("a held summary is refreshed in the background when it falls behind early", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "first");
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	compactor.observe(snapshot(manager, 30_000), "turn");
	assert.equal(jobs.length, 2);
	assert.equal(jobs[1]!.job.plan.previousSummary, "first");
	await finish(1, "refreshed");
	assert.equal(swapped(take(manager, 33_000)).summary, "refreshed");
	assert.equal(jobs.length, 2);
});

test("compaction does not wait for a refresh when the held summary still fits", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "first");
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	compactor.observe(snapshot(manager, 30_000), "turn");
	assert.equal(jobs.length, 2);
	assert.equal(swapped(take(manager, 33_000)).summary, "first");
	assert.equal(jobs[1]!.job.signal.aborted, true);
});

test("without a usable summary, compaction starts one in the background and defers", async () => {
	const { manager, ids } = session(14, 1000);
	const { compactor, jobs, finish, events, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	// Moving to another branch discards the held summary.
	manager.branch(ids[20]!);
	manager.appendMessage({ role: "user", content: words(500), timestamp: Date.now() });
	assert.equal(deferredBecause(take(manager, 33_000)), "writing");
	assert.equal(jobs.length, 2);
	assert.equal(jobs[1]!.job.plan.previousSummary, undefined);
	assert.equal(jobs[1]!.job.reason, "compaction");
	await finish(1, "fresh");
	assert.equal(swapped(take(manager, 33_500)).summary, "fresh");
	assert.ok(events.some((event) => event.event === "discarded"));
	assert.equal(compactor.state, "idle");
});

test("a stale summary that still frees enough room is swapped in without blocking", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0);
	// 10k arrived since: past the 8k refresh bound, but the swap leaves ~14k of the 32k threshold.
	manager.appendMessage({ role: "user", content: words(5000), timestamp: Date.now() });
	manager.appendMessage(assistant(words(5000)));
	const result = swapped(take(manager, 33_000));
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

test("summaries started at compaction use transcript requests, except for overflow", async () => {
	const { manager } = session(14, 1000);
	for (const [reason, mode] of [["threshold", "transcript"], ["overflow", "serialized"]] as const) {
		const { jobs, finish, take } = harness({ request: "auto" });
		deferredBecause(take(manager, 33_000, reason));
		assert.equal(jobs[0]!.job.mode, mode);
		await finish(0);
		swapped(take(manager, 33_000, reason));
	}
});

test("compaction instructions get a focused summary and keep the held one for automatic compaction", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, finish, take } = harness();
	compactor.observe(snapshot(manager, 26_000), "turn");
	await finish(0, "unfocused");
	deferredBecause(take(manager, 20_000, "manual", "focus on tests"));
	assert.equal(jobs[1]!.job.focus, "focus on tests");
	await finish(1, "focused");
	assert.equal(swapped(take(manager, 20_000, "manual", "focus on tests")).summary, "focused");
	// Automatic compaction takes whichever summary is held; other instructions need their own.
	const other = harness();
	other.compactor.observe(snapshot(manager, 26_000), "turn");
	await other.finish(0, "unfocused");
	deferredBecause(other.take(manager, 20_000, "manual", "focus on docs"));
	assert.equal(swapped(other.take(manager, 33_000)).summary, "unfocused");
	assert.equal(other.jobs[1]!.job.signal.aborted, true);
	assert.equal(compactor.state, "idle");
});

test("after a failed summary, compaction starts another only after a backoff", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, fail, take, clock } = harness();
	deferredBecause(take(manager, 33_000));
	await fail(0, "provider down");
	assert.equal(compactor.stats.failed, 1);
	assert.match(deferredBecause(take(manager, 33_000)), /summarizer failed/);
	assert.equal(jobs.length, 1, "no request during the backoff");
	clock.now += 60_000;
	assert.equal(deferredBecause(take(manager, 33_000)), "writing");
	assert.equal(jobs.length, 2);
	await fail(1, "provider down");
	clock.now += 60_000;
	deferredBecause(take(manager, 33_000));
	assert.equal(jobs.length, 2, "the backoff doubles after each failure");
	clock.now += 60_000;
	deferredBecause(take(manager, 33_000));
	assert.equal(jobs.length, 3);
});

test("two failures in a row stop background summaries until the next compaction", async () => {
	const { manager } = session(14, 1000);
	const { compactor, jobs, clock } = harness();
	for (let i = 0; i < 2; i++) {
		compactor.observe(snapshot(manager, 26_000), "turn");
		jobs[i]!.result.reject(new Error("rate limited"));
		await tick();
		// Not even within the backoff after a failure.
		compactor.observe(snapshot(manager, 26_500), "turn");
		assert.equal(jobs.length, i + 1);
		clock.now += 600_000;
	}
	compactor.observe(snapshot(manager, 27_000), "turn");
	assert.equal(jobs.length, 2);
	compactor.reset("compacted");
	compactor.observe(snapshot(manager, 27_000), "turn");
	assert.equal(jobs.length, 3);
});

test("a request from an earlier process is adopted, and its finished summary restored, only while it applies", async () => {
	const { manager, ids } = session(14, 1000);
	const first = harness();
	first.compactor.observe(snapshot(manager, 26_000), "turn");
	const { signal: _signal, ...request } = first.jobs[0]!.job;
	const stored = JSON.parse(JSON.stringify(request));
	// A restarted process follows the stored request to its result.
	const next = harness();
	const result = deferred<SummaryOutput>();
	assert.equal(next.compactor.adopt(snapshot(manager, 27_000), stored, () => result.promise), true);
	assert.equal(next.compactor.state, "writing");
	assert.equal(deferredBecause(next.take(manager, 33_000)), "writing");
	result.resolve({ text: "resumed", usage: usage(100), model: "test/summarizer" });
	await tick();
	assert.equal(swapped(next.take(manager, 33_000)).summary, "resumed");
	// A finished summary is held again, but not on another branch.
	const restored = harness();
	assert.equal(restored.compactor.restore(snapshot(manager, 27_000), stored, { text: "stored", usage: usage(100), model: "test/summarizer" }), true);
	assert.equal(swapped(restored.take(manager, 33_000)).summary, "stored");
	manager.branch(ids[20]!);
	const elsewhere = harness();
	assert.equal(elsewhere.compactor.restore(snapshot(manager, 27_000), stored, { text: "stored", usage: usage(100), model: "test/summarizer" }), false);
	assert.equal(elsewhere.compactor.adopt(snapshot(manager, 27_000), stored, () => result.promise), false);
	assert.equal(elsewhere.compactor.state, "idle");
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
