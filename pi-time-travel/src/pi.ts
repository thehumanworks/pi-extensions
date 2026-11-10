import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { type JudgeConfig, judgeModel } from "./config.ts";
import { type Evaluation, type Finding, FiredState, interrupts, reminders } from "./engine.ts";
import type { Classify } from "./judge.ts";
import { fileLogger, type Logger } from "./log.ts";
import { clip, type Output } from "./matcher.ts";
import { blockReason, correctionText, reminderText, upfrontText, withdrawnText } from "./prompts.ts";
import { loadRuntime, type Runtime } from "./runtime.ts";
import { NewFiles, viewToolCall } from "./tools.ts";

/** Persisted record of each action; also the source of the repeat policy after a reload. */
export const ENTRY_TYPE = "time-travel";
/** The hidden correction the agent resumes with. */
export const MESSAGE_TYPE = "time-travel";

export interface TimeTravelEntry {
	/** `withdraw`: response removed from context and resumed. `block`: tool calls blocked, response kept. `correct`: message kept, correction added. `remind`: warned only. */
	action: "withdraw" | "block" | "correct" | "remind";
	rules: string[];
	excerpt?: string;
	how?: "regex" | "judge";
	turn: number;
}

export function describe(entry: TimeTravelEntry): string {
	const rules = entry.rules.join(", ");
	const excerpt = entry.excerpt ? ` (${entry.excerpt.length > 80 ? `${entry.excerpt.slice(0, 80)}…` : entry.excerpt})` : "";
	switch (entry.action) {
		case "withdraw":
			return `⟲ Time travel · ${rules}${excerpt}: withdrew the response before it took effect and resumed with the rule.`;
		case "block":
			return `⟲ Time travel · ${rules}${excerpt}: blocked the response's tool calls and told the agent why.`;
		case "correct":
			return `⟲ Time travel · ${rules}${excerpt}: corrected the agent after its message.`;
		case "remind":
			return `⟲ Time travel · ${rules}${excerpt}: reminded the agent of the rule.`;
	}
}

interface Decision {
	evaluation: Evaluation;
	interrupts: Finding[];
	reminders: Finding[];
}

function outputsOf(message: AssistantMessage, cwd: string, files: NewFiles): Output[] {
	const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const thinking = message.content.flatMap((block) => (block.type === "thinking" && !block.redacted ? [block.thinking] : [])).join("\n");
	const outputs: Output[] = [];
	if (text) outputs.push({ source: "text", text });
	if (thinking) outputs.push({ source: "thinking", text: thinking });
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const view = viewToolCall(block.name, block.arguments, cwd);
		files.mark(view, cwd);
		outputs.push({ source: "tool", text: view.text, view, id: block.id });
	}
	return outputs;
}

/** Shell commands the agent ran on this branch, as facts for judged rules. */
function recentCommands(ctx: ExtensionContext, limit = 30): string[] {
	const commands: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && block.name === "bash" && typeof block.arguments.command === "string") commands.push(block.arguments.command);
		}
	}
	return commands.slice(-limit);
}

function piClassifier(ctx: ExtensionContext, judge: JudgeConfig): Classify | { error: string } {
	const chosen = judgeModel(judge);
	if ("error" in chosen) return chosen;
	const { provider, model: modelId } = chosen;
	const { timeoutMs } = judge;
	const model = ctx.modelRegistry.findOfType("classifier", provider, modelId);
	if (!model) return { error: `classifier ${provider}/${modelId} is not in Pi's model registry` };
	if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) return { error: `no credentials for ${provider}` };
	return async (state, questions, signal) => {
		const result = await ctx.modelRegistry.classify(model, { state: state as JsonObject, questions }, { signal, timeoutMs, maxRetries: 1 });
		if (result.stopReason !== "stop") return { probabilities: {}, error: result.errorMessage ?? result.stopReason, inputTokens: result.usage?.input };
		const probabilities: Record<string, number> = {};
		for (const [id, answer] of Object.entries(result.answers)) if (answer.type === "bool") probabilities[id] = answer.probability;
		return { probabilities, inputTokens: result.usage?.input };
	};
}

/**
 * Pi adapter. Each finished assistant message is checked before its tool calls run. A violation
 * blocks the message's tool calls; at the end of the turn the message and its tool results are
 * withdrawn from the model's context (`context_edit`) and the agent resumes with the rule as a
 * hidden message, as if the mistake had never been made.
 */
export default function timeTravel(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	let fired = new FiredState();
	/** Files the agent created on this branch. Forgotten on reload, which only makes ignoreNewFiles rules stricter. */
	let files = new NewFiles();
	let log: Logger = () => {};
	let rewinds = 0;
	let warned = "";
	const decisions = new Map<string, Promise<Decision>>();
	const byMessage = new WeakMap<object, Promise<Decision>>();
	/** Reminders for tool calls that run anyway, delivered with their results. */
	const toolReminders = new Map<string, Finding[]>();

	function load(ctx: ExtensionContext): Runtime {
		runtime = loadRuntime({
			cwd: ctx.cwd,
			home: homedir(),
			env: process.env,
			project: ctx.isProjectTrusted(),
			judge: (config) => piClassifier(ctx, config.judge),
			log: (config) => fileLogger(config.logFile, { harness: "pi", session: ctx.sessionManager.getSessionId() }),
		});
		log = fileLogger(runtime.config.logFile, { harness: "pi", session: ctx.sessionManager.getSessionId() });
		const warnings = runtime.warnings.join("\n");
		if (warnings && warnings !== warned && ctx.hasUI) ctx.ui.notify(`Time travel:\n${warnings}`, "warning");
		warned = warnings;
		return runtime;
	}

	/** Rebuilds the repeat policy from the branch: turns are completed assistant messages. */
	function restore(ctx: ExtensionContext): void {
		fired = new FiredState();
		files = new NewFiles();
		decisions.clear();
		toolReminders.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") fired.turn++;
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as Partial<TimeTravelEntry> | undefined;
				for (const rule of data?.rules ?? []) fired.fired.set(rule, typeof data?.turn === "number" ? data.turn : fired.turn);
			}
		}
	}

	const record = (entry: Omit<TimeTravelEntry, "turn">): SessionBoundaryDraft => ({ type: "custom", customType: ENTRY_TYPE, data: { ...entry, turn: fired.turn } });

	function logFindings(findings: Finding[], extra: Record<string, unknown>): void {
		for (const finding of findings) {
			log({
				event: finding.action === "interrupt" ? "interrupt" : "remind",
				rule: finding.rule.name,
				how: finding.how,
				probability: finding.probability,
				source: finding.output.source,
				tool: finding.output.view?.rawTool,
				paths: finding.output.view?.paths,
				excerpt: finding.excerpt,
				text: clip(finding.output.text, 4000),
				...extra,
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		load(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const current = runtime ?? load(ctx);
		rewinds = 0;
		const upfront = current.config.enabled ? current.rules.filter((rule) => rule.alwaysApply) : [];
		// Our own section name, so another extension's rules section is never overwritten.
		if (upfront.length > 0) event.systemPromptOptions.sections.time_travel_rules = upfrontText(upfront);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const engine = (runtime ?? load(ctx)).engine;
		if (!engine.active || message.stopReason === "aborted" || message.stopReason === "error") return;
		const outputs = outputsOf(message, ctx.cwd, files);
		const decision = engine.evaluate(outputs, fired, () => ({ commandsRunThisSession: recentCommands(ctx) })).then((evaluation): Decision => {
			log({ event: "check", hook: "message_end", outputs: outputs.length, ms: Math.round(evaluation.ms), findings: evaluation.findings.length, cleared: evaluation.cleared });
			return { evaluation, interrupts: interrupts(evaluation.findings), reminders: reminders(evaluation.findings) };
		});
		byMessage.set(message, decision);
		for (const output of outputs) if (output.id) decisions.set(output.id, decision);
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = runtime ?? load(ctx);
		if (!current.engine.active) return;
		const { showExcerpt } = current.config;
		const pending = decisions.get(event.toolCallId);
		if (pending) {
			decisions.delete(event.toolCallId);
			const decision = await pending;
			const own = (findings: Finding[]) => findings.filter((finding) => finding.output.id === event.toolCallId);
			if (decision.interrupts.length > 0) return { block: true, reason: blockReason(own(decision.interrupts), decision.interrupts, showExcerpt) };
			const remind = own(decision.reminders);
			if (remind.length > 0) toolReminders.set(event.toolCallId, remind);
			return;
		}
		// Calls a tool made itself (codemode scripts) have no transcript entry to withdraw: block or remind only.
		const view = viewToolCall(event.toolName, event.input, ctx.cwd);
		files.mark(view, ctx.cwd);
		const evaluation = await current.engine.evaluate([{ source: "tool", text: view.text, view, id: event.toolCallId }], fired, () => ({ commandsRunThisSession: recentCommands(ctx) }));
		log({ event: "check", hook: "tool_call", tool: event.toolName, nested: event.parentToolCallId !== undefined, ms: Math.round(evaluation.ms), findings: evaluation.findings.length, cleared: evaluation.cleared });
		const stop = interrupts(evaluation.findings);
		const remind = reminders(evaluation.findings);
		if (stop.length > 0) {
			fired.mark(stop.map((finding) => finding.rule.name));
			pi.appendEntry<TimeTravelEntry>(ENTRY_TYPE, { action: "block", rules: stop.map((finding) => finding.rule.name), excerpt: stop[0]!.excerpt, how: stop[0]!.how, turn: fired.turn });
			logFindings(stop, { hook: "tool_call", outcome: "block" });
			return { block: true, reason: blockReason(stop, stop, showExcerpt) };
		}
		if (remind.length > 0) toolReminders.set(event.toolCallId, remind);
	});

	pi.on("tool_result", (event) => {
		const remind = toolReminders.get(event.toolCallId);
		if (!remind || !runtime) return;
		toolReminders.delete(event.toolCallId);
		fired.mark(remind.map((finding) => finding.rule.name));
		pi.appendEntry<TimeTravelEntry>(ENTRY_TYPE, { action: "remind", rules: remind.map((finding) => finding.rule.name), excerpt: remind[0]!.excerpt, how: remind[0]!.how, turn: fired.turn });
		logFindings(remind, { hook: "tool_result", outcome: "remind" });
		return { content: [...event.content, { type: "text" as const, text: reminderText(remind, runtime.config.showExcerpt) }], structuredContent: event.structuredContent };
	});

	pi.on("turn_end", async (event) => {
		const pending = byMessage.get(event.message);
		if (event.message.role === "assistant") fired.turn++;
		if (!pending || !runtime) return;
		const decision = await pending;
		if (event.outcome !== "completed") return;
		const { config } = runtime;
		const entries: SessionBoundaryDraft[] = [...event.entries];
		let resume = false;
		const stop = decision.interrupts;
		const names = (findings: Finding[]) => [...new Set(findings.map((finding) => finding.rule.name))];

		if (stop.length > 0) {
			fired.mark(names(stop));
			const meta = { rules: names(stop), excerpt: stop[0]!.excerpt, how: stop[0]!.how };
			const canResume = rewinds < config.maxRewindsPerRun;
			if (config.contextMode === "discard" && canResume) {
				rewinds++;
				// Tool results without their call make an invalid request, so they go too.
				for (const targetId of [event.messageEntryId, ...event.toolResultEntryIds]) entries.push({ type: "context_edit", targetId, replacement: null });
				entries.push(record({ action: "withdraw", ...meta }));
				entries.push({ type: "custom_message", customType: MESSAGE_TYPE, content: withdrawnText(stop, config.showExcerpt), display: false, details: meta });
				resume = true;
				logFindings(stop, { hook: "turn_end", outcome: "withdraw" });
			} else if (event.toolResults.length === 0 && canResume) {
				rewinds++;
				entries.push(record({ action: "correct", ...meta }));
				entries.push({ type: "custom_message", customType: MESSAGE_TYPE, content: correctionText(stop, config.showExcerpt), display: false, details: meta });
				resume = true;
				logFindings(stop, { hook: "turn_end", outcome: "correct" });
			} else {
				// The block reasons in the tool results already carry the rule.
				entries.push(record({ action: "block", ...meta }));
				logFindings(stop, { hook: "turn_end", outcome: "block" });
			}
		}

		// Tool reminders travel with their results; prose reminders follow the message.
		const prose = decision.reminders.filter((finding) => finding.output.source !== "tool");
		if (prose.length > 0) {
			fired.mark(names(prose));
			const meta = { rules: names(prose), excerpt: prose[0]!.excerpt, how: prose[0]!.how };
			entries.push(record({ action: "remind", ...meta }));
			entries.push({ type: "custom_message", customType: MESSAGE_TYPE, content: reminderText(prose, config.showExcerpt), display: false, details: meta });
			if (event.toolResults.length === 0 && stop.length === 0 && rewinds < config.maxRewindsPerRun) {
				rewinds++;
				resume = true;
			}
			logFindings(prose, { hook: "turn_end", outcome: "remind" });
		}
		if (entries.length === event.entries.length) return;
		return resume ? { entries, continue: true } : { entries };
	});

	pi.registerEntryRenderer<TimeTravelEntry>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? new Text(theme.fg("dim", theme.italic(describe(entry.data))), 1, 0) : undefined,
	);

	pi.registerCommand("time-travel", {
		description: "Show time-travel rules and status; `/time-travel reload` re-reads rules and settings",
		handler: async (args, ctx) => {
			const current = args.trim() === "reload" ? load(ctx) : (runtime ?? load(ctx));
			const lines = [
				`Time travel ${current.config.enabled ? "on" : "off"} · contextMode ${current.config.contextMode} · repeat ${current.config.repeatMode} · judge ${current.judgeStatus}`,
				...current.rules.map((rule) => `• ${rule.name}${rule.question ? " (judged)" : ""}${rule.alwaysApply ? " (up front)" : ""}${fired.fired.has(rule.name) ? " · fired" : ""}`),
				...(current.rules.length === 0 ? ["No rules. Add Markdown rule files to .agents/ttsr/ or ~/.agents/ttsr/."] : []),
				...current.warnings.map((warning) => `⚠ ${warning}`),
			];
			ctx.ui.notify(lines.join("\n"), current.warnings.length ? "warning" : "info");
		},
	});
}
