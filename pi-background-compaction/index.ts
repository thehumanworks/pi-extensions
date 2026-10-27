import { appendFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BackgroundCompactionConfig, type CompactionControl, compactionSettings, readConfig } from "./src/config.ts";
import { BackgroundCompactor, limits, type Snapshot, type SummaryJob, type SummaryOutput } from "./src/controller.ts";
import { writeSummary } from "./src/summarize.ts";

const STATUS = "background-compaction";
const CONTROL = "background-compaction-settings";
const HELP = "/bg-compact model <provider/modelId> | on | off | status | start | cancel";
const BUILTIN = "Pi's built-in compaction is unchanged and may use the session model while this extension is off.";
const VIRTUAL_API = "pi-virtual";
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

export default function backgroundCompaction(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let config: BackgroundCompactionConfig | undefined;
	let control: CompactionControl = {};
	let configError: string | undefined;
	let work = new AbortController();
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

	const summarize = async (job: SummaryJob): Promise<SummaryOutput> => {
		const context = ctx;
		if (!context) throw new Error("no active session");
		if (!current().enabled) throw new Error("background compaction is off");
		const signal = AbortSignal.any([job.signal, work.signal]);
		signal.throwIfAborted();
		const model = summarizerModel(context);
		try {
			return await writeSummary({ ...job, signal }, current(), {
				model,
				complete: (m, c, o) => context.modelRegistry.streamSimple(m, c, o).result(),
				sessionThinking: context.thinkingLevel ?? "off",
				sessionId: context.sessionManager.getSessionId(),
			});
		} catch (error) {
			if (!signal.aborted) warn(`summary with ${model.provider}/${model.id} failed: ${error instanceof Error ? error.message : String(error)}. No session-model fallback.`);
			throw error;
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

	const compactor = new BackgroundCompactor({ config: current, summarize, trace, changed: updateStatus });

	const resetWork = (reason: string) => {
		work.abort(new Error(reason));
		work = new AbortController();
		compactor.reset(reason);
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
		resetWork("session start");
		if (current().enabled) {
			const message = `Background compaction on: ${current().model} (no session-model fallback)`;
			if (context.hasUI) context.ui.notify(message, "info");
			else process.stderr.write(`${message}\n`);
		}
		observe(context, "resume");
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

	pi.on("agent_settled", (_event, context) => observe(context, "idle"));

	pi.on("session_before_compact", async (event, context) => {
		ctx = context;
		if (!current().enabled) return undefined;
		const model = current().model;
		const signal = AbortSignal.any([event.signal, work.signal]);
		try {
			summarizerModel(context);
			const snap = snapshot(context);
			if (!snap) throw new Error("context limits are unavailable");
			// Pi passes the settings it resolved for this compaction; prefer them.
			snap.settings = event.preparation.settings;
			const compaction = await compactor.take(snap, signal, {
				tokensBefore: event.preparation.tokensBefore,
				reason: event.reason,
				customInstructions: event.customInstructions,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
			});
			if (signal.aborted) return { cancel: true };
			if (compaction) return { compaction };
			throw new Error("no usable summary");
		} catch (error) {
			if (!signal.aborted) warn(`compaction with ${model} cancelled: ${error instanceof Error ? error.message : String(error)}. Retry, or use /bg-compact off to allow Pi's built-in compaction with the session model.`);
			return { cancel: true };
		}
	});

	pi.on("session_compact", (_event, context) => {
		ctx = context;
		resetWork("compacted");
	});

	pi.on("session_tree", (_event, context) => observe(context, "tree"));

	pi.on("session_shutdown", () => {
		resetWork("shutdown");
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS, undefined);
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
				settings.enabled ? "If the configured summarizer fails, compaction is cancelled rather than using another model." : BUILTIN,
				held ? `held summary by ${held.model} from ${new Date(held.readyAt).toLocaleTimeString()}, ${held.requests} request(s), keeps from ${held.plan.firstKeptEntryId}` : "",
				`started ${stats.started}, ready ${stats.ready}, failed ${stats.failed}, swapped ${stats.swapped}, caught up ${stats.caughtUp}, foreground ${stats.foreground}, discarded ${stats.discarded}`,
			].filter(Boolean);
			context.ui.notify(lines.join("\n"), "info");
		},
	});
}
