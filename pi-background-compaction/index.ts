import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type BackgroundCompactionConfig, type CompactionControl, compactionSettings, readConfig } from "./src/config.ts";
import { BackgroundCompactor, limits, type Snapshot, type SummaryJob, type SummaryOutput, type SummaryRequest } from "./src/controller.ts";
import { JobQueue, PermanentError, type Recovered } from "./src/jobs.ts";
import { writeSummary } from "./src/summarize.ts";

const STATUS = "background-compaction";
const CONTROL = "background-compaction-settings";
const HELP = "/bg-compact model <provider/modelId> | on | off | status | start | cancel";
const BUILTIN = "Pi's built-in compaction is unchanged and may use the session model while this extension is off.";
const VIRTUAL_API = "pi-virtual";
const JOBS = "background-compaction.summary";
// Stored summaries of sessions not resumed for this long are deleted.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Longest a shutdown waits for the job queue to close.
const SHUTDOWN_MS = 2000;
// pi-ai's own provider APIs. Transcript requests stay on these: an extension provider such as a CLI
// bridge may treat a resent conversation as the next turn of its own session.
const TRANSCRIPT_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
]);

type Queue = JobQueue<SummaryRequest, SummaryOutput>;

/** The summary jobs of one session. Detached jobs are left to a later process instead of aborted. */
interface Jobs {
	queue: Promise<Queue>;
	detached: boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Summary jobs live under Pi's agent directory, one database per session file. */
const jobsDir = () => join(getAgentDir(), "background-compaction");

export default function backgroundCompaction(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let config: BackgroundCompactionConfig | undefined;
	let control: CompactionControl = {};
	let configError: string | undefined;
	let jobs: Jobs | undefined;
	/** A `/compact` deferred until its summary is ready. */
	let manual: { focus?: string } | undefined;
	const warned = new Set<string>();

	const warn = (message: string) => {
		if (warned.has(message)) return;
		warned.add(message);
		if (ctx?.hasUI) ctx.ui.notify(`Background compaction: ${message}`, "warning");
		else process.stderr.write(`pi-background-compaction: ${message}\n`);
	};

	const load = (context: ExtensionContext) => {
		// Controls are session-wide, not branch state: navigating the tree must not undo an explicit off.
		control = {};
		for (const entry of context.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CONTROL) continue;
			const data = entry.data as CompactionControl | undefined;
			if (data && typeof data.enabled === "boolean" && (data.model === undefined || typeof data.model === "string")) {
				control = { enabled: data.enabled, model: data.model };
			}
		}
		try {
			config = readConfig(pi.getSettings(), context.cwd, process.env, control);
			configError = undefined;
			if (config.enabled) summarizerModel(context);
		} catch (error) {
			configError = error instanceof Error ? error.message : String(error);
			if (config) config.enabled = false;
			warn(`off: ${configError}. ${BUILTIN}`);
		}
	};

	const current = (): BackgroundCompactionConfig => config ?? ({ enabled: false } as BackgroundCompactionConfig);

	const trace = (event: Record<string, unknown>) => {
		const path = config?.trace;
		if (!path) return;
		try {
			appendFileSync(path, `${JSON.stringify({ session: ctx?.sessionManager.getSessionId(), ...event })}\n`);
		} catch {
			// Tracing must never break compaction.
		}
	};

	/** The physical model behind the session, even when a virtual model routes it. */
	const sessionModel = (context: ExtensionContext): Model<Api> | undefined => {
		const model = context.model;
		if (!model || model.api !== VIRTUAL_API) return model;
		const branch = context.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.api === VIRTUAL_API) continue;
			return context.modelRegistry.find(entry.message.provider, entry.message.model);
		}
		return undefined;
	};

	const summarizerModel = (context: ExtensionContext, selector = current().model): Model<Api> => {
		if (!selector) throw new Error("set a compaction model with /bg-compact model <provider/modelId> before enabling");
		if (!/^[^/\s]+\/\S+$/.test(selector)) throw new Error("compaction model must be an explicit provider/modelId (not session)");
		const slash = selector.indexOf("/");
		const model = context.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
		if (!model) throw new Error(`${selector} is not available`);
		if (model.api === VIRTUAL_API) throw new Error(`${selector} is a virtual model; choose a concrete compaction model`);
		if (!context.modelRegistry.hasConfiguredAuth(model)) throw new Error(`${selector} is not signed in`);
		return model;
	};

	/** One attempt of a stored summary request, run by the job queue off Pi's path. */
	const attempt = async (request: SummaryRequest, signal: AbortSignal): Promise<SummaryOutput> => {
		const context = ctx;
		if (!context) throw new Error("no active session");
		if (!current().enabled) throw new PermanentError("background compaction is off");
		let model: Model<Api>;
		try {
			model = summarizerModel(context);
		} catch (error) {
			throw new PermanentError(message(error));
		}
		return writeSummary({ ...request, signal }, current(), {
			model,
			complete: (m, c, o) => context.modelRegistry.streamSimple(m, c, o).result(),
			sessionThinking: context.thinkingLevel ?? "off",
			sessionId: context.sessionManager.getSessionId(),
		});
	};

	/** This session's summary jobs; opened on first use, and stored when the session has a file. */
	const queue = (): Jobs => {
		if (jobs) return jobs;
		const file = ctx?.sessionManager.getSessionFile();
		const slot = { detached: false } as Jobs;
		slot.queue = JobQueue.open<SummaryRequest, SummaryOutput>({
				kind: JOBS,
				file: file ? join(jobsDir(), `${createHash("sha256").update(file).digest("hex")}.db`) : undefined,
				policy: () => {
					const { retries, retryDelayMs, timeoutMs } = current();
					return { attempts: retries + 1, backoffMs: retryDelayMs, maxBackoffMs: 8 * retryDelayMs, timeoutMs };
				},
				run: attempt,
				failed: (error, number, retryAt) => {
					if (retryAt !== undefined) trace({ event: "retry", attempt: number, error: message(error), retryAt: new Date(retryAt).toISOString() });
				},
				recover: (opened, found) => recover(slot, opened, found),
				report: (error) => trace({ event: "jobs", error: message(error) }),
			});
		slot.queue.catch(() => {
			if (jobs === slot) jobs = undefined;
		});
		jobs = slot;
		return slot;
	};

	/** Follow a job to its summary; aborting `signal` aborts the job unless its queue was detached. */
	const follow = async (slot: Jobs, queue: Queue, id: number, signal: AbortSignal): Promise<SummaryOutput> => {
		const stop = () => {
			if (!slot.detached) void queue.abort(id);
		};
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		try {
			const outcome = await queue.wait(id);
			if (outcome.status === "completed") return outcome.result;
			if (outcome.status === "aborted") throw new Error("summary stopped");
			if (!signal.aborted) warn(`summary with ${current().model} failed: ${outcome.error}. No session-model fallback.`);
			throw new Error(outcome.error);
		} finally {
			signal.removeEventListener("abort", stop);
		}
	};

	const summarize = async (job: SummaryJob): Promise<SummaryOutput> => {
		const { signal, ...request } = job;
		const slot = queue();
		const jobQueue = await slot.queue;
		signal.throwIfAborted();
		return follow(slot, jobQueue, await jobQueue.enqueue(request), signal);
	};

	/** Abort this session's jobs and delete what they stored, e.g. after a compaction or `/bg-compact off`. */
	const rotate = () => {
		const slot = jobs;
		jobs = undefined;
		void slot?.queue
			.then(async (queue) => {
				for (const job of await queue.live()) await queue.abort(job.id);
				await queue.close({ discard: true });
			})
			.catch((error: unknown) => trace({ event: "jobs", error: message(error) }));
	};

	/**
	 * Take over what an earlier process left in a queue being opened: its finished summary, and a summary
	 * still being written. Jobs that no longer apply, or that a newer request replaced, are aborted before they run.
	 */
	const recover = async (slot: Jobs, opened: Queue, { latest, live }: Recovered<SummaryRequest, SummaryOutput>) => {
		const snap = ctx && jobs === slot ? snapshot(ctx) : undefined;
		if (snap && latest) compactor.restore(snap, latest.input, latest.result);
		for (const job of live) {
			if (!snap || !compactor.adopt(snap, job.input, (signal) => follow(slot, opened, job.id, signal))) await opened.abort(job.id);
		}
		void prune(opened.file);
	};

	/** Open this session's jobs at session start, then plan as usual once recovered work is known. */
	const resume = async (context: ExtensionContext) => {
		try {
			await queue().queue;
		} catch (error) {
			trace({ event: "jobs", error: message(error) });
		} finally {
			if (ctx === context) observe(context, "resume");
		}
	};

	/** Delete the stored jobs of sessions untouched for a week: a database with its journal and lock files. */
	const prune = async (keep: string | undefined) => {
		const groups = new Map<string, { paths: string[]; newest: number }>();
		for (const name of await readdir(jobsDir()).catch(() => [] as string[])) {
			const id = /^([a-f0-9]{64})\.db/.exec(name)?.[1];
			const path = join(jobsDir(), name);
			const info = id && !(keep && path.startsWith(keep)) ? await stat(path).catch(() => undefined) : undefined;
			if (!id || !info) continue;
			const group = groups.get(id) ?? { paths: [], newest: 0 };
			group.paths.push(path);
			group.newest = Math.max(group.newest, info.mtimeMs);
			groups.set(id, group);
		}
		for (const { paths, newest } of groups.values()) {
			if (Date.now() - newest > KEEP_MS) for (const path of paths) await unlink(path).catch(() => undefined);
		}
	};

	const snapshot = (context: ExtensionContext): Snapshot | undefined => {
		const usage = context.getContextUsage();
		const model = context.model;
		if (!usage || !model || !config) return undefined;
		const session = sessionModel(context);
		const summarizer = config.model;
		return {
			branch: context.sessionManager.getBranch(),
			tokens: usage.tokens,
			contextWindow: usage.contextWindow,
			settings: compactionSettings(pi.getSettings(), model),
			transcript: !!session && TRANSCRIPT_APIS.has(session.api) && summarizer === `${session.provider}/${session.id}`,
		};
	};

	const updateStatus = () => {
		if (!ctx?.hasUI) return;
		const state = compactor.state;
		ctx.ui.setStatus(STATUS, current().enabled ? `compact: ${state} ${current().model}` : "compact: off");
	};

	/** Run a deferred `/compact` once its summary is ready and the agent is idle. */
	const applyManual = () => {
		const context = ctx;
		if (!manual || !context || compactor.state === "writing") return;
		if (compactor.state === "idle" || !current().enabled) {
			manual = undefined;
			return;
		}
		if (!context.isIdle()) return;
		const { focus } = manual;
		manual = undefined;
		context.compact({ customInstructions: focus, onError: (error) => warn(`compaction failed: ${error.message}`) });
	};

	const changed = () => {
		updateStatus();
		if (manual) queueMicrotask(applyManual);
	};

	const compactor = new BackgroundCompactor({ config: current, summarize, trace, changed });

	const resetWork = (reason: string) => {
		compactor.reset(reason);
		manual = undefined;
		rotate();
		updateStatus();
	};

	const observe = (context: ExtensionContext, reason: string) => {
		ctx = context;
		if (!current().enabled) return;
		try {
			summarizerModel(context);
		} catch (error) {
			warn(`${error instanceof Error ? error.message : String(error)}; no summary requested and no session-model fallback`);
			return;
		}
		const snap = snapshot(context);
		if (snap) compactor.observe(snap, reason);
	};

	const setControl = (next: CompactionControl, context: ExtensionContext) => {
		const settings = readConfig(pi.getSettings(), context.cwd, process.env, next);
		if (settings.enabled) summarizerModel(context, settings.model);
		control = next;
		config = settings;
		configError = undefined;
		resetWork("compaction settings changed");
		pi.appendEntry(CONTROL, control);
	};

	pi.on("session_start", (_event, context) => {
		ctx = context;
		config = undefined;
		load(context);
		compactor.reset("session start");
		manual = undefined;
		updateStatus();
		if (!current().enabled) return;
		const notice = `Background compaction on: ${current().model} (no session-model fallback)`;
		if (context.hasUI) context.ui.notify(notice, "info");
		else process.stderr.write(`${notice}\n`);
		// Opening the job queue loads pi-durable; session start does not wait for it.
		void resume(context);
	});

	pi.on("turn_end", (event, context) => {
		ctx = context;
		const snap = snapshot(context);
		if (!snap) return;
		if (!event.entries.some((entry) => entry.type === "compaction")) {
			const draft = compactor.ready(snap);
			if (draft) return { entries: [...event.entries, draft] };
		}
		observe(context, "turn");
	});

	pi.on("agent_settled", (_event, context) => {
		observe(context, "idle");
		applyManual();
	});

	// Never waits: the summary is used if ready, otherwise compaction is deferred while it is written.
	pi.on("session_before_compact", (event, context) => {
		ctx = context;
		if (!current().enabled) return undefined;
		const model = current().model;
		try {
			summarizerModel(context);
			const snap = snapshot(context);
			if (!snap) throw new Error("context limits are unavailable");
			// Pi passes the settings it resolved for this compaction; prefer them.
			snap.settings = event.preparation.settings;
			const decision = compactor.take(snap, {
				tokensBefore: event.preparation.tokensBefore,
				reason: event.reason,
				customInstructions: event.customInstructions,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
			});
			if (!decision) return undefined;
			if ("compaction" in decision) return { compaction: decision.compaction };
			if (event.reason === "manual") {
				const writing = compactor.state === "writing";
				manual = writing ? { focus: event.customInstructions } : undefined;
				const notice = writing
					? `Background compaction: writing the summary with ${model}; the session compacts when it is ready.`
					: `Background compaction: not compacted (${decision.deferred}).`;
				if (context.hasUI) context.ui.notify(notice, "info");
				else process.stderr.write(`${notice}\n`);
			}
			return { cancel: true };
		} catch (error) {
			warn(`compaction with ${model} cancelled: ${message(error)}. Use /bg-compact off to allow Pi's built-in compaction with the session model.`);
			return { cancel: true };
		}
	});

	pi.on("session_compact", (_event, context) => {
		ctx = context;
		resetWork("compacted");
	});

	pi.on("session_tree", (_event, context) => observe(context, "tree"));

	pi.on("session_shutdown", async () => {
		// Running and finished summaries stay stored for the next process that opens this session.
		const slot = jobs;
		const keep = compactor.state !== "idle";
		jobs = undefined;
		if (slot) slot.detached = true;
		compactor.reset("shutdown");
		manual = undefined;
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS, undefined);
		// Results are committed as they happen, so a slow close must not hold up Pi; the next open waits for it.
		const closed = slot?.queue.then((queue) => queue.close({ discard: !keep })).catch(() => undefined);
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_MS); })]);
		clearTimeout(timer);
	});

	pi.registerCommand("bg-compact", {
		description: "Background compaction: model <provider/modelId>, on, off, status, start, cancel (off by default)",
		getArgumentCompletions: (prefix) => {
			const values = prefix.startsWith("model ")
				? (ctx?.modelRegistry.getAvailable() ?? []).filter((model) => model.api !== VIRTUAL_API).map((model) => `model ${model.provider}/${model.id}`)
				: ["model", "on", "off", "status", "start", "cancel"];
			return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, context) => {
			ctx = context;
			const [command = "status", ...rest] = args.trim() ? args.trim().split(/\s+/) : [];
			if ((command === "model" ? rest.length > 1 : rest.length > 0) || !["model", "on", "off", "status", "start", "cancel"].includes(command)) {
				return context.ui.notify(`Usage: ${HELP}. Switching requires explicit on or off.`, "error");
			}
			if (command === "off") {
				// Always stop, even if a file setting is invalid. Keep the model for a later explicit on.
				control = { ...control, enabled: false };
				if (config) config.enabled = false;
				resetWork("disabled by user");
				pi.appendEntry(CONTROL, control);
				context.ui.notify(`Background compaction off for this session; pending work cancelled. ${BUILTIN}`, "info");
				return;
			}
			if (command === "model") {
				const selector = rest[0];
				if (!selector) return context.ui.notify(`Compaction model: ${current().model ?? "not set"}. Set it with /bg-compact model <provider/modelId>, then /bg-compact on.`, "info");
				try {
					summarizerModel(context, selector);
					setControl({ enabled: false, model: selector }, context);
					context.ui.notify(`Compaction model set to ${selector} for this session. Background compaction is off; run /bg-compact on to enable it.`, "info");
				} catch (error) {
					context.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (command === "on") {
				try {
					if (current().enabled) {
						summarizerModel(context);
						return context.ui.notify(`Background compaction is already on, using ${current().model}.`, "info");
					}
					setControl({ enabled: true, model: control.model ?? current().model }, context);
					context.ui.notify(`Background compaction on for this session, using ${current().model}. No session-model fallback. Summaries incur model usage even if never applied.`, "info");
					observe(context, "enabled");
				} catch (error) {
					context.ui.notify(`Cannot enable background compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (command === "start") {
				if (!current().enabled) return context.ui.notify("Background compaction is off. Set /bg-compact model <provider/modelId>, then explicitly run /bg-compact on first.", "error");
				try {
					summarizerModel(context);
					const snap = snapshot(context);
					if (!snap) return context.ui.notify("Background compaction is unavailable for this session", "warning");
					compactor.observe(snap, "command", true);
					context.ui.notify(compactor.state === "writing" ? `Writing a background summary with ${current().model}` : "Nothing to summarize yet", "info");
				} catch (error) {
					context.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (command === "cancel") {
				resetWork("cancelled by user");
				context.ui.notify(`Background summary dropped; background compaction remains ${current().enabled ? `on (${current().model})` : "off"}. Use /bg-compact off to disable it.`, "info");
				return;
			}
			const settings = current();
			const snap = snapshot(context);
			const limit = snap ? limits(settings, snap) : undefined;
			const held = compactor.heldSummary;
			const stats = compactor.stats;
			const lines = [
				`Background compaction ${settings.enabled ? "on" : "off"}: ${compactor.state}`,
				limit && snap
					? `context ${snap.tokens ?? "?"} tokens; starts at ${Math.round(limit.start)}, Pi compacts at ${limit.threshold}`
					: "context limits unknown",
				`Compaction model: ${settings.model ?? "not set"} (no session-model fallback)`,
				configError ? `Configuration error: ${configError}` : `prompt ${settings.promptName}, ${settings.request === "auto" ? `auto (${snap?.transcript ? "transcript" : "serialized"})` : settings.request} requests, swap at ${settings.swap}`,
				`Usage: ${HELP}`,
				"Command changes are saved for this session (including reload/resume), not to global or project settings.",
				settings.enabled ? "Compaction never waits for a summary: until one is ready it is deferred, and a failed summary is retried rather than written by another model." : BUILTIN,
				held ? `held summary by ${held.model} from ${new Date(held.readyAt).toLocaleTimeString()}, ${held.requests} request(s), keeps from ${held.plan.firstKeptEntryId}` : "",
				`started ${stats.started}, ready ${stats.ready}, failed ${stats.failed}, swapped ${stats.swapped}, deferred ${stats.deferred}, discarded ${stats.discarded}`,
			].filter(Boolean);
			context.ui.notify(lines.join("\n"), "info");
		},
	});
}
