import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionEntryDraft, CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig, CompactionSettings } from "./config.ts";
import { type AgentMessage, type Checkpoint, keptTokens, misfit, type Plan, planCompaction, projectedMessages } from "./plan.ts";
import { addUsage, formatFiles, stripFiles } from "./summarize.ts";

export type RequestMode = "serialized" | "transcript";

export interface SummaryJob {
	plan: Plan;
	mode: RequestMode;
	/** The whole projected conversation, for transcript requests. */
	transcript?: AgentMessage[];
	/** Extra focus, e.g. `/compact` instructions. */
	focus?: string;
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
	startedAt: number;
	readyAt: number;
}

interface Running {
	plan: Plan;
	base?: Held;
	reason: string;
	abort: AbortController;
	promise: Promise<Held | undefined>;
	startedAt: number;
}

export interface Limits {
	threshold: number;
	start: number;
	keep: number;
	/** Tail growth after which a held summary is refreshed in the background. */
	maxStale: number;
	/** Largest context a swap may leave; a held summary that would leave more is caught up first. */
	maxAfter: number;
}

export interface Stats {
	started: number;
	ready: number;
	failed: number;
	discarded: number;
	swapped: number;
	caughtUp: number;
	foreground: number;
	deferred: number;
	waitedMs: number;
	/** Usage of summaries that were written but never used. */
	unused?: Usage;
}

export interface CompactorDeps {
	config(): BackgroundCompactionConfig;
	summarize: Summarizer;
	trace?(event: Record<string, unknown>): void;
	now?(): number;
	/** Called whenever the background state changes, e.g. to update a status line. */
	changed?(): void;
}

const estimate = (text: string) => Math.ceil(text.length / 4);

/** Abort-aware wait: resolves when `promise` settles or `signal` aborts. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(undefined);
			},
		);
	});
}

export function limits(config: BackgroundCompactionConfig, snapshot: Pick<Snapshot, "contextWindow" | "settings">): Limits {
	const threshold = snapshot.contextWindow - snapshot.settings.reserveTokens;
	const keep = config.keepRecentTokens ?? snapshot.settings.keepRecentTokens;
	// OpenCode's staleness bound: tokens appended since the snapshot that may stay verbatim beside the summary.
	const maxStale = config.maxStaleTokens ?? Math.min(Math.max(2 * keep, 30_000), Math.floor(threshold / 4));
	return { threshold, start: Math.max(config.trigger * threshold, config.minTokens), keep, maxStale, maxAfter: config.maxSwapRatio * threshold };
}

/**
 * Writes the compaction summary before Pi needs it. `observe()` starts a background summary once the
 * context passes the trigger; `take()` hands it to Pi's compaction, waiting for it if it is still
 * being written and catching it up if too much arrived since. Summaries are held in memory only.
 */
export class BackgroundCompactor {
	private running?: Running;
	private held?: Held;
	private failures = 0;
	readonly stats: Stats = { started: 0, ready: 0, failed: 0, discarded: 0, swapped: 0, caughtUp: 0, foreground: 0, deferred: 0, waitedMs: 0 };
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
			const why = misfit(snapshot.branch, this.running.plan);
			if (!why) return;
			this.cancelRunning(why);
		}
		if (this.held) {
			const why = misfit(snapshot.branch, this.held.plan);
			if (why) this.discard(why);
		}
		if (!force && (snapshot.tokens === null || snapshot.tokens < limit.start)) return;
		if (!force && this.failures >= 2) return;
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

	private launch(plan: Plan, mode: RequestMode, snapshot: Snapshot, reason: string, base?: Held): void {
		const config = this.deps.config();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(new Error("timed out")), config.timeoutMs);
		timer.unref?.();
		const startedAt = this.now();
		this.stats.started++;
		this.trace("start", {
			reason,
			mode,
			tokens: snapshot.tokens,
			summarizedTokens: plan.summarizedTokens,
			keptTokens: plan.keptTokens,
			extends: base !== undefined,
		});
		const transcript = mode === "transcript" ? projectedMessages(snapshot.branch) : undefined;
		const promise: Promise<Held | undefined> = this.deps
			.summarize({ plan, mode, transcript, signal: abort.signal })
			.then(
				(output) => {
					const held = this.toHeld(plan, output, mode, startedAt, base);
					if (this.running?.promise !== promise) return held;
					this.running = undefined;
					this.held = held;
					this.failures = 0;
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
						this.stats.failed++;
						this.trace("failed", { reason, mode, error: message, ms: this.now() - startedAt });
						this.deps.changed?.();
					}
					return undefined;
				},
			)
			.finally(() => clearTimeout(timer));
		this.running = { plan, base, reason, abort, promise, startedAt };
		this.deps.changed?.();
	}

	private toHeld(plan: Plan, output: SummaryOutput, mode: RequestMode, startedAt: number, base?: Held): Held {
		return {
			plan,
			summary: stripFiles(output.text) + formatFiles(plan.files),
			usage: addUsage(base?.usage, output.usage),
			requests: (base?.requests ?? 0) + 1,
			model: output.model,
			mode,
			startedAt: base?.startedAt ?? startedAt,
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
	 * Pi is compacting: return the summary to append, or undefined to let Pi write its own. Waits for a
	 * summary still being written. A held summary whose verbatim tail grew too long to free enough room
	 * is caught up first; without a usable one the configured summarizer writes one now.
	 */
	async take(
		snapshot: Snapshot,
		signal: AbortSignal,
		options: { tokensBefore: number; reason: string; customInstructions?: string; firstKeptEntryId?: string },
	): Promise<CompactionResult | undefined> {
		const config = this.deps.config();
		if (!config.enabled) return undefined;
		const limit = limits(config, snapshot);
		const started = this.now();
		// A refresh only improves on a held summary; when that summary already frees enough room, use it
		// now rather than wait. Wait when nothing usable is held, which still beats writing one now.
		if (this.running && !options.customInstructions && !(this.running.base && this.fits(snapshot, this.held, limit))) {
			this.trace("wait", { reason: options.reason });
			await until(this.running.promise, signal);
			if (signal.aborted) return undefined;
		}
		if (this.running) this.cancelRunning("compacting now");
		const waitedMs = this.now() - started;
		this.stats.waitedMs += waitedMs;
		let held = options.customInstructions ? undefined : this.held;
		const why = held ? misfit(snapshot.branch, held.plan) : options.customInstructions ? "compaction has instructions" : "no background summary";
		if (held && why) {
			this.discard(why);
			held = undefined;
		}
		let caughtUp = false;
		const source = held ? "background" : "foreground";
		if (held) {
			const kept = keptTokens(snapshot.branch, held.plan.firstKeptEntryId) ?? Number.POSITIVE_INFINITY;
			const stale = kept - held.plan.keptTokens;
			// Catching up blocks about as long as a fresh summary, so only do it when the swap would
			// barely shrink the context (the stale-summary failure in anthropics/claude-code#70459).
			if (estimate(held.summary) + kept > limit.maxAfter) {
				// Cut where Pi would, which also handles its overflow-recovery omissions.
				const plan =
					planCompaction(snapshot.branch, limit.keep, checkpoint(held), options.firstKeptEntryId) ??
					planCompaction(snapshot.branch, limit.keep, checkpoint(held));
				if (plan) {
					this.trace("catch-up", { staleTokens: stale, summarizedTokens: plan.summarizedTokens });
					const next = await this.write(plan, signal, held);
					if (next) {
						held = next;
						caughtUp = true;
						this.stats.caughtUp++;
					} else if (estimate(held.summary) + kept >= limit.threshold) {
						// Pi's own summary would most likely fail the same way, but this one frees nothing.
						this.discard("catch-up failed");
						this.stats.deferred++;
						return undefined;
					}
					// Otherwise a swap that frees less than intended still beats a blocking retry.
				}
			}
		} else {
			// No usable background summary: write one now with the configured model and prompt.
			const plan = planCompaction(snapshot.branch, limit.keep, undefined, options.firstKeptEntryId);
			if (!plan) return undefined;
			// An overflowing context cannot be resent whole, so overflow recovery summarizes it as text.
			const mode = options.reason === "overflow" ? "serialized" : requestMode(config, snapshot);
			this.trace("foreground", { reason: why, mode, summarizedTokens: plan.summarizedTokens });
			held = await this.write(plan, signal, undefined, options.customInstructions, mode === "transcript" ? snapshot : undefined);
			if (!held) {
				this.stats.deferred++;
				return undefined;
			}
			this.stats.foreground++;
		}
		if (signal.aborted) return undefined;
		this.held = undefined;
		this.failures = 0;
		this.stats.swapped++;
		this.trace("swap", {
			reason: options.reason,
			source,
			caughtUp,
			waitedMs,
			blockedMs: this.now() - started,
			requests: held.requests,
			ageMs: this.now() - held.readyAt,
			summaryTokens: estimate(held.summary),
			keptTokens: keptTokens(snapshot.branch, held.plan.firstKeptEntryId),
			usage: held.usage,
		});
		this.deps.changed?.();
		return {
			summary: held.summary,
			firstKeptEntryId: held.plan.firstKeptEntryId,
			tokensBefore: options.tokensBefore,
			usage: held.usage,
			details: details(held, { source, waitedMs, caughtUp }),
		};
	}

	/** Whether `held` still applies to the branch and swapping it in would leave at most `limit.maxAfter`. */
	private fits(snapshot: Snapshot, held: Held | undefined, limit: Limits): boolean {
		if (!held || misfit(snapshot.branch, held.plan)) return false;
		const kept = keptTokens(snapshot.branch, held.plan.firstKeptEntryId);
		return kept !== undefined && estimate(held.summary) + kept <= limit.maxAfter;
	}

	/** A blocking summary request, for catch-up and foreground compaction; a snapshot makes it a transcript request. */
	private async write(plan: Plan, signal: AbortSignal, base?: Held, focus?: string, transcriptOf?: Snapshot): Promise<Held | undefined> {
		const startedAt = this.now();
		const mode: RequestMode = transcriptOf ? "transcript" : "serialized";
		try {
			const transcript = transcriptOf ? projectedMessages(transcriptOf.branch) : undefined;
			const output = await this.deps.summarize({ plan, mode, transcript, focus, signal });
			return this.toHeld(plan, output, mode, startedAt, base);
		} catch (error) {
			this.trace("failed", { reason: base ? "catch-up" : "foreground", error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
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
		this.trace("swap", { reason: "ready", source: "background", caughtUp: false, waitedMs: 0, blockedMs: 0, requests: held.requests, ageMs: this.now() - held.readyAt, summaryTokens: estimate(held.summary), keptTokens: kept, usage: held.usage });
		this.deps.changed?.();
		return { type: "compaction", summary: held.summary, firstKeptEntryId: held.plan.firstKeptEntryId, details: details(held, { source: "background", waitedMs: 0, caughtUp: false }), usage: held.usage };
	}

	/** Forget everything, e.g. after a compaction or on shutdown. */
	reset(reason: string): void {
		this.cancelRunning(reason);
		this.discard(reason);
		this.failures = 0;
	}
}

function requestMode(config: BackgroundCompactionConfig, snapshot: Snapshot): RequestMode {
	return config.request === "transcript" || (config.request === "auto" && snapshot.transcript) ? "transcript" : "serialized";
}

function checkpoint(held: Held): Checkpoint {
	return { summary: held.summary, firstKeptEntryId: held.plan.firstKeptEntryId, files: held.plan.files };
}

function details(held: Held, swap: { source: string; waitedMs: number; caughtUp: boolean }) {
	return {
		readFiles: held.plan.files.readFiles,
		modifiedFiles: held.plan.files.modifiedFiles,
		backgroundCompaction: {
			source: swap.source,
			model: held.model,
			mode: held.mode,
			requests: held.requests,
			startedAt: new Date(held.startedAt).toISOString(),
			readyAt: new Date(held.readyAt).toISOString(),
			waitedMs: swap.waitedMs,
			caughtUp: swap.caughtUp,
		},
	};
}
