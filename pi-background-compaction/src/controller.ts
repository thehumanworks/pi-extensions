import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionEntryDraft, CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig, CompactionSettings } from "./config.ts";
import { type AgentMessage, type Checkpoint, keptTokens, misfit, type Plan, planCompaction, projectedMessages } from "./plan.ts";
import { addUsage, formatFiles, stripFiles } from "./summarize.ts";

export type RequestMode = "serialized" | "transcript";

/** Usage and request count of the summaries a new summary extends. */
export type Lineage = Pick<Held, "usage" | "requests" | "startedAt">;

/** One summary request. JSON, so it can be stored and resumed after a restart. */
export interface SummaryRequest {
	plan: Plan;
	mode: RequestMode;
	/** The whole projected conversation, for transcript requests. */
	transcript?: AgentMessage[];
	/** Extra focus, e.g. `/compact` instructions. */
	focus?: string;
	base?: Lineage;
	reason: string;
	startedAt: number;
}

export interface SummaryJob extends SummaryRequest {
	signal: AbortSignal;
}

export interface SummaryOutput {
	text: string;
	usage: Usage;
	model: string;
}

export type Summarizer = (job: SummaryJob) => Promise<SummaryOutput>;

/** The session as Pi would send it next, with the limits that decide when Pi compacts. */
export interface Snapshot {
	branch: SessionEntry[];
	/** Estimated context tokens; null right after a compaction, until the next response. */
	tokens: number | null;
	contextWindow: number;
	settings: CompactionSettings;
	/** Whether the summarizer is the session model on a direct provider API, so transcript requests reuse its prompt cache. */
	transcript: boolean;
}

/** A finished summary that can replace the entries before `plan.firstKeptEntryId`. */
export interface Held {
	plan: Plan;
	/** Summary text with the file-list tags. */
	summary: string;
	/** Usage of every request behind this summary, including summaries it extended. */
	usage: Usage;
	requests: number;
	model: string;
	mode: RequestMode;
	focus?: string;
	startedAt: number;
	readyAt: number;
}

interface Running {
	request: SummaryRequest;
	abort: AbortController;
	promise: Promise<Held | undefined>;
}

export interface Limits {
	threshold: number;
	start: number;
	keep: number;
	/** Tail growth after which a held summary is refreshed in the background. */
	maxStale: number;
	/** Largest context a swap should leave; a held summary that would leave more is caught up first. */
	maxAfter: number;
}

export interface Stats {
	started: number;
	ready: number;
	failed: number;
	discarded: number;
	swapped: number;
	/** Compactions put off because no usable summary was ready. */
	deferred: number;
	/** Usage of summaries that were written but never used. */
	unused?: Usage;
}

/** What Pi's compaction gets: a summary to append now, or why compaction waits for a later check. */
export type Decision = { compaction: CompactionResult } | { deferred: string };

export interface CompactorDeps {
	config(): BackgroundCompactionConfig;
	summarize: Summarizer;
	trace?(event: Record<string, unknown>): void;
	now?(): number;
	/** Called whenever the background state changes, e.g. to update a status line. */
	changed?(): void;
}

const estimate = (text: string) => Math.ceil(text.length / 4);

/** After a failed summary, compaction starts another only after this backoff, doubling per failure. */
const RETRY_MS = 60_000;
const MAX_RETRY_MS = 600_000;

export function limits(config: BackgroundCompactionConfig, snapshot: Pick<Snapshot, "contextWindow" | "settings">): Limits {
	const threshold = snapshot.contextWindow - snapshot.settings.reserveTokens;
	const keep = config.keepRecentTokens ?? snapshot.settings.keepRecentTokens;
	// OpenCode's staleness bound: tokens appended since the snapshot that may stay verbatim beside the summary.
	const maxStale = config.maxStaleTokens ?? Math.min(Math.max(2 * keep, 30_000), Math.floor(threshold / 4));
	return { threshold, start: Math.max(config.trigger * threshold, config.minTokens), keep, maxStale, maxAfter: config.maxSwapRatio * threshold };
}

/**
 * Writes the compaction summary before Pi needs it. `observe()` starts a background summary once the
 * context passes the trigger; `take()` hands it to Pi's compaction. `take()` never waits: without a
 * usable summary it starts one in the background and defers, and Pi checks again before its next request.
 */
export class BackgroundCompactor {
	private running?: Running;
	private held?: Held;
	private failures = 0;
	/** No summary starts at compaction before this time, after a failure. */
	private retryAt = 0;
	/** Compaction checks deferred since the last swap. */
	private deferrals = 0;
	readonly stats: Stats = { started: 0, ready: 0, failed: 0, discarded: 0, swapped: 0, deferred: 0 };
	private readonly now: () => number;

	constructor(private readonly deps: CompactorDeps) {
		this.now = deps.now ?? Date.now;
	}

	get state(): "idle" | "writing" | "ready" {
		return this.running ? "writing" : this.held ? "ready" : "idle";
	}

	get heldSummary(): Held | undefined {
		return this.held;
	}

	private trace(event: string, data: Record<string, unknown> = {}): void {
		this.deps.trace?.({ event, at: new Date(this.now()).toISOString(), ...data });
	}

	/** Start, refresh, or drop the background summary for the session as it stands. */
	observe(snapshot: Snapshot, reason: string, force = false): void {
		const config = this.deps.config();
		if (!config.enabled || (!snapshot.settings.enabled && config.swap === "threshold" && !force)) return;
		const limit = limits(config, snapshot);
		if (limit.threshold <= 0) return;
		if (this.running) {
			const why = misfit(snapshot.branch, this.running.request.plan);
			if (!why) return;
			this.cancelRunning(why);
		}
		if (this.held) {
			const why = misfit(snapshot.branch, this.held.plan);
			if (why) this.discard(why);
		}
		if (!force && (snapshot.tokens === null || snapshot.tokens < limit.start)) return;
		if (!force && (this.failures >= 2 || this.now() < this.retryAt)) return;
		if (this.held) {
			// Pi compacts right after this boundary; the held summary is used or caught up then.
			if (!force && (snapshot.tokens ?? 0) > limit.threshold) return;
			const kept = keptTokens(snapshot.branch, this.held.plan.firstKeptEntryId) ?? Number.POSITIVE_INFINITY;
			if (kept - this.held.plan.keptTokens <= limit.maxStale) return;
			// The held summary fell behind; extend it with what arrived since rather than start over.
			const plan = planCompaction(snapshot.branch, limit.keep, checkpoint(this.held));
			if (plan) this.launch(plan, "serialized", snapshot, "refresh", this.held);
			return;
		}
		const plan = planCompaction(snapshot.branch, limit.keep);
		if (!plan) return;
		// Right after a large tool result the cut must keep the result with its call. Wait for the next
		// boundary, where the cut can fall after it, rather than hold a summary that leaves it verbatim.
		if (!force && plan.keptTokens > 2 * limit.keep) {
			this.trace("postponed", { reason: "oversized tail", keptTokens: plan.keptTokens });
			return;
		}
		this.launch(plan, requestMode(config, snapshot), snapshot, reason);
	}

	private launch(plan: Plan, mode: RequestMode, snapshot: Snapshot, reason: string, base?: Held, focus?: string): void {
		const request: SummaryRequest = {
			plan,
			mode,
			transcript: mode === "transcript" ? projectedMessages(snapshot.branch) : undefined,
			focus,
			base: base && { usage: base.usage, requests: base.requests, startedAt: base.startedAt },
			reason,
			startedAt: this.now(),
		};
		this.stats.started++;
		this.trace("start", {
			reason,
			mode,
			tokens: snapshot.tokens,
			summarizedTokens: plan.summarizedTokens,
			keptTokens: plan.keptTokens,
			extends: base !== undefined,
		});
		this.track(request, (signal) => this.deps.summarize({ ...request, signal }));
	}

	/**
	 * Take over a summary request still running from an earlier process, when it applies to the branch.
	 * `attach` follows the request to its result.
	 */
	adopt(snapshot: Snapshot, request: SummaryRequest, attach: (signal: AbortSignal) => Promise<SummaryOutput>): boolean {
		if (this.running || !this.deps.config().enabled || misfit(snapshot.branch, request.plan)) return false;
		this.trace("resumed", { reason: request.reason, mode: request.mode, summarizedTokens: request.plan.summarizedTokens });
		this.track(request, attach);
		return true;
	}

	/** Hold a summary an earlier process finished, when it still applies to the branch. */
	restore(snapshot: Snapshot, request: SummaryRequest, output: SummaryOutput): boolean {
		if (this.held || !this.deps.config().enabled || misfit(snapshot.branch, request.plan)) return false;
		this.held = this.toHeld(request, output);
		this.trace("restored", { reason: request.reason, mode: request.mode, summaryTokens: estimate(this.held.summary) });
		this.deps.changed?.();
		return true;
	}

	private track(request: SummaryRequest, run: (signal: AbortSignal) => Promise<SummaryOutput>): void {
		const abort = new AbortController();
		const { reason, mode, startedAt } = request;
		const promise: Promise<Held | undefined> = run(abort.signal).then(
			(output) => {
				const held = this.toHeld(request, output);
				if (this.running?.promise !== promise) return held;
				this.running = undefined;
				this.held = held;
				this.failures = 0;
				this.retryAt = 0;
				this.stats.ready++;
				this.trace("ready", { reason, mode, model: output.model, ms: held.readyAt - startedAt, summaryTokens: estimate(held.summary), usage: output.usage });
				this.deps.changed?.();
				return held;
			},
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (this.running?.promise === promise) {
					this.running = undefined;
					this.failures++;
					this.retryAt = this.now() + Math.min(RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS);
					this.stats.failed++;
					this.trace("failed", { reason, mode, error: message, ms: this.now() - startedAt });
					this.deps.changed?.();
				}
				return undefined;
			},
		);
		this.running = { request, abort, promise };
		this.deps.changed?.();
	}

	private toHeld(request: SummaryRequest, output: SummaryOutput): Held {
		const { plan, base } = request;
		return {
			plan,
			summary: stripFiles(output.text) + formatFiles(plan.files),
			usage: addUsage(base?.usage, output.usage),
			requests: (base?.requests ?? 0) + 1,
			model: output.model,
			mode: request.mode,
			focus: request.focus,
			startedAt: base?.startedAt ?? request.startedAt,
			readyAt: this.now(),
		};
	}

	private cancelRunning(why: string): void {
		if (!this.running) return;
		this.running.abort.abort(new Error(why));
		this.trace("cancelled", { reason: why });
		this.running = undefined;
		this.deps.changed?.();
	}

	private discard(why: string): void {
		if (!this.held) return;
		this.stats.discarded++;
		this.stats.unused = addUsage(this.stats.unused, this.held.usage);
		this.trace("discarded", { reason: why, requests: this.held.requests });
		this.held = undefined;
		this.deps.changed?.();
	}

	/**
	 * Pi is compacting: return the summary to append now, or defer. Never waits. A held summary that
	 * leaves too much verbatim is caught up in the background first; without a usable one, a summary
	 * starts in the background. Pi checks the threshold again before its next request.
	 */
	take(snapshot: Snapshot, options: { tokensBefore: number; reason: string; customInstructions?: string; firstKeptEntryId?: string }): Decision | undefined {
		const config = this.deps.config();
		if (!config.enabled) return undefined;
		const limit = limits(config, snapshot);
		const focus = options.customInstructions?.trim() || undefined;
		if (this.held) {
			const why = misfit(snapshot.branch, this.held.plan);
			if (why) this.discard(why);
		}
		const held = this.held && (focus === undefined || this.held.focus === focus) ? this.held : undefined;
		if (held) {
			const kept = keptTokens(snapshot.branch, held.plan.firstKeptEntryId) ?? Number.POSITIVE_INFINITY;
			const after = estimate(held.summary) + kept;
			if (after <= limit.maxAfter) return this.swap(held, snapshot, options, false);
			// Catching up costs about as much as a fresh summary, so only do it when the swap would barely
			// shrink the context (the stale-summary failure in anthropics/claude-code#70459). Once the catch-up
			// was given its chance, swap what frees room rather than let the context grow.
			const frees = after < limit.threshold;
			const tried = this.deferrals > 0 && !this.running;
			if (frees && (options.reason === "overflow" || tried || this.now() < this.retryAt)) return this.swap(held, snapshot, options, true);
			if (this.running) return this.defer(options.reason, "catching up");
			if (this.now() < this.retryAt) return this.defer(options.reason, "the summarizer failed; retrying later");
			// Cut where Pi would, which also handles its overflow-recovery omissions.
			const plan =
				planCompaction(snapshot.branch, limit.keep, checkpoint(held), options.firstKeptEntryId) ??
				planCompaction(snapshot.branch, limit.keep, checkpoint(held));
			if (plan) {
				this.launch(plan, "serialized", snapshot, "catch-up", held, focus);
				return this.defer(options.reason, "catching up");
			}
			if (frees) return this.swap(held, snapshot, options, true);
			return this.defer(options.reason, "nothing to summarize");
		}
		if (this.running && this.running.request.focus !== focus && focus !== undefined) this.cancelRunning("compaction has other instructions");
		if (this.running) return this.defer(options.reason, "writing");
		if (this.now() < this.retryAt) return this.defer(options.reason, "the summarizer failed; retrying later");
		const plan = planCompaction(snapshot.branch, limit.keep, undefined, options.firstKeptEntryId);
		if (!plan) return this.defer(options.reason, "nothing to summarize");
		// An overflowing context cannot be resent whole, so overflow recovery summarizes it as text.
		const mode = options.reason === "overflow" ? "serialized" : requestMode(config, snapshot);
		this.launch(plan, mode, snapshot, "compaction", undefined, focus);
		return this.defer(options.reason, "writing");
	}

	private defer(reason: string, why: string): Decision {
		this.deferrals++;
		this.stats.deferred++;
		this.trace("deferred", { reason, why, deferrals: this.deferrals });
		return { deferred: why };
	}

	private swap(held: Held, snapshot: Snapshot, options: { tokensBefore: number; reason: string }, stale: boolean): Decision {
		if (this.running) this.cancelRunning("compacting now");
		const kept = keptTokens(snapshot.branch, held.plan.firstKeptEntryId);
		this.held = undefined;
		this.failures = 0;
		this.retryAt = 0;
		this.stats.swapped++;
		const swap = { stale, deferrals: this.deferrals };
		this.deferrals = 0;
		this.trace("swap", {
			reason: options.reason,
			...swap,
			requests: held.requests,
			ageMs: this.now() - held.readyAt,
			summaryTokens: estimate(held.summary),
			keptTokens: kept,
			usage: held.usage,
		});
		this.deps.changed?.();
		return {
			compaction: {
				summary: held.summary,
				firstKeptEntryId: held.plan.firstKeptEntryId,
				tokensBefore: options.tokensBefore,
				usage: held.usage,
				details: details(held, swap),
			},
		};
	}

	/** For `swap: "ready"`: the held summary as a compaction entry, when it can be applied now. */
	ready(snapshot: Snapshot): CompactionEntryDraft | undefined {
		const config = this.deps.config();
		if (!config.enabled || config.swap !== "ready" || !this.held) return undefined;
		const why = misfit(snapshot.branch, this.held.plan);
		if (why) {
			this.discard(why);
			return undefined;
		}
		const kept = keptTokens(snapshot.branch, this.held.plan.firstKeptEntryId) ?? Number.POSITIVE_INFINITY;
		if (estimate(this.held.summary) + kept > limits(config, snapshot).maxAfter) return undefined;
		const held = this.held;
		this.held = undefined;
		this.stats.swapped++;
		this.deferrals = 0;
		this.trace("swap", { reason: "ready", stale: false, deferrals: 0, requests: held.requests, ageMs: this.now() - held.readyAt, summaryTokens: estimate(held.summary), keptTokens: kept, usage: held.usage });
		this.deps.changed?.();
		return { type: "compaction", summary: held.summary, firstKeptEntryId: held.plan.firstKeptEntryId, details: details(held, { stale: false, deferrals: 0 }), usage: held.usage };
	}

	/** Forget everything, e.g. after a compaction or on shutdown. */
	reset(reason: string): void {
		this.cancelRunning(reason);
		this.discard(reason);
		this.failures = 0;
		this.retryAt = 0;
		this.deferrals = 0;
	}
}

function requestMode(config: BackgroundCompactionConfig, snapshot: Snapshot): RequestMode {
	return config.request === "transcript" || (config.request === "auto" && snapshot.transcript) ? "transcript" : "serialized";
}

function checkpoint(held: Held): Checkpoint {
	return { summary: held.summary, firstKeptEntryId: held.plan.firstKeptEntryId, files: held.plan.files };
}

function details(held: Held, swap: { stale: boolean; deferrals: number }) {
	return {
		readFiles: held.plan.files.readFiles,
		modifiedFiles: held.plan.files.modifiedFiles,
		backgroundCompaction: {
			model: held.model,
			mode: held.mode,
			requests: held.requests,
			startedAt: new Date(held.startedAt).toISOString(),
			readyAt: new Date(held.readyAt).toISOString(),
			stale: swap.stale,
			deferrals: swap.deferrals,
		},
	};
}
