import { appendFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BackgroundCompactionConfig, compactionSettings, readConfig } from "./src/config.ts";
import { BackgroundCompactor, limits, type Snapshot, type SummaryJob, type SummaryOutput } from "./src/controller.ts";
import { writeSummary } from "./src/summarize.ts";

const STATUS = "background-compaction";
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
	const warned = new Set<string>();

	const warn = (message: string) => {
		if (warned.has(message)) return;
		warned.add(message);
		if (ctx?.hasUI) ctx.ui.notify(`Background compaction: ${message}`, "warning");
		else process.stderr.write(`pi-background-compaction: ${message}\n`);
	};

	const load = (cwd: string) => {
		try {
			config = readConfig(pi.getSettings(), cwd);
		} catch (error) {
			config = undefined;
			warn(`disabled, ${error instanceof Error ? error.message : String(error)}`);
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

	const summarizerModel = (context: ExtensionContext): Model<Api> | undefined => {
		const selector = current().model;
		if (selector) {
			const slash = selector.indexOf("/");
			const model = context.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
			if (model && context.modelRegistry.hasConfiguredAuth(model)) return model;
			warn(`${selector} is ${model ? "not signed in" : "not available"}; summarizing with the session model`);
		}
		return sessionModel(context);
	};

	const summarize = async (job: SummaryJob): Promise<SummaryOutput> => {
		const context = ctx;
		if (!context) throw new Error("no active session");
		const model = summarizerModel(context);
		if (!model) throw new Error("no model to summarize with");
		return writeSummary(job, current(), {
			model,
			complete: (m, c, o) => context.modelRegistry.streamSimple(m, c, o).result(),
			sessionThinking: context.thinkingLevel ?? "off",
			sessionId: context.sessionManager.getSessionId(),
		});
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
			transcript: !!session && TRANSCRIPT_APIS.has(session.api) && (!summarizer || summarizer === `${session.provider}/${session.id}`),
		};
	};

	const updateStatus = () => {
		if (!ctx?.hasUI) return;
		const state = compactor.state;
		ctx.ui.setStatus(STATUS, state === "writing" ? "compact: writing" : state === "ready" ? "compact: ready" : undefined);
	};

	const compactor = new BackgroundCompactor({ config: current, summarize, trace, changed: updateStatus });

	const observe = (context: ExtensionContext, reason: string) => {
		ctx = context;
		const snap = snapshot(context);
		if (snap) compactor.observe(snap, reason);
	};

	pi.on("session_start", (_event, context) => {
		ctx = context;
		load(context.cwd);
		compactor.reset("session start");
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
		compactor.observe(snap, "turn");
	});

	pi.on("agent_settled", (_event, context) => observe(context, "idle"));

	pi.on("session_before_compact", async (event, context) => {
		ctx = context;
		const snap = snapshot(context);
		if (!snap) return undefined;
		// Pi passes the settings it resolved for this compaction; prefer them.
		snap.settings = event.preparation.settings;
		const compaction = await compactor.take(snap, event.signal, {
			tokensBefore: event.preparation.tokensBefore,
			reason: event.reason,
			customInstructions: event.customInstructions,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
		});
		return compaction ? { compaction } : undefined;
	});

	pi.on("session_compact", (_event, context) => {
		ctx = context;
		compactor.reset("compacted");
	});

	pi.on("session_tree", (_event, context) => observe(context, "tree"));

	pi.on("session_shutdown", () => {
		compactor.reset("shutdown");
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS, undefined);
	});

	pi.registerCommand("bg-compact", {
		description: "Background compaction: status, start (summarize now in the background), cancel",
		getArgumentCompletions: (prefix) =>
			["status", "start", "cancel"].filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, context) => {
			ctx = context;
			const command = args.trim() || "status";
			if (command === "start") {
				const snap = snapshot(context);
				if (!snap) return context.ui.notify("Background compaction is unavailable for this session", "warning");
				compactor.observe(snap, "command", true);
				context.ui.notify(compactor.state === "writing" ? "Writing a background summary" : "Nothing to summarize yet", "info");
				return;
			}
			if (command === "cancel") {
				compactor.reset("cancelled by user");
				context.ui.notify("Background summary dropped", "info");
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
				`summarizer ${settings.model ?? "session model"}, prompt ${settings.promptName}, ${settings.request === "auto" ? `auto (${snap?.transcript ? "transcript" : "serialized"})` : settings.request} requests, swap at ${settings.swap}`,
				held ? `held summary from ${new Date(held.readyAt).toLocaleTimeString()}, ${held.requests} request(s), keeps from ${held.plan.firstKeptEntryId}` : "",
				`started ${stats.started}, ready ${stats.ready}, failed ${stats.failed}, swapped ${stats.swapped}, caught up ${stats.caughtUp}, foreground ${stats.foreground}, discarded ${stats.discarded}`,
			].filter(Boolean);
			context.ui.notify(lines.join("\n"), "info");
		},
	});
}
