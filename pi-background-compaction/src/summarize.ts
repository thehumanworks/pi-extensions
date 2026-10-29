import {
	type Api,
	type AssistantMessage,
	type Context,
	contentText,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type Usage,
	uuidv7,
} from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig } from "./config.ts";
import type { SummaryJob, SummaryOutput } from "./controller.ts";
import { PermanentError } from "./jobs.ts";
import type { AgentMessage, FileLists, Plan } from "./plan.ts";
import type { PromptSet } from "./prompts.ts";

export type Complete = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

export interface SummaryStyle {
	prompts: PromptSet;
	/** Extra instructions appended to the summary request. */
	focus?: string;
	/** Characters of each tool result kept when serializing; Pi keeps 2000. */
	toolResultChars: number;
}

export interface SummaryText {
	text: string;
	usage: Usage;
}

/**
 * Shorten a tool result for the summary transcript. The marker says the cut is the transcript's, not
 * the tool's: Pi's own wording ("N more characters truncated") leads summarizers to report that the
 * agent never saw the whole output and must read it again.
 */
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters omitted from this transcript only; the assistant received the complete output]`;
}

/** Pi's summary serialization, with a configurable tool-result limit. Thinking is omitted. */
export function serializeConversation(messages: Message[], toolResultChars: number): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const calls = message.content.flatMap((block) =>
				block.type === "toolCall"
					? [`${block.name}(${Object.entries(block.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`]
					: [],
			);
			if (message.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(message.content)}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[Tool result]: ${truncate(text, toolResultChars)}`);
		}
	}
	return parts.join("\n\n");
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

/** A standalone request: the summarized messages as text, so any model can write the summary. */
export function serializedRequest(plan: Pick<Plan, "messages" | "previousSummary">, style: SummaryStyle): Context {
	let text = `<conversation>\n${serializeConversation(convertToLlm(plan.messages), style.toolResultChars)}\n</conversation>\n\n`;
	if (plan.previousSummary) text += `<previous-summary>\n${plan.previousSummary}\n</previous-summary>\n\n`;
	text += plan.previousSummary ? style.prompts.update : style.prompts.initial;
	if (style.focus) text += `\n\nAdditional focus: ${style.focus}`;
	return { systemPrompt: style.prompts.system, messages: [userText(text)] };
}

/**
 * The conversation as the session model last received it, prompt and tool declarations included, plus
 * one instruction. Providers serve the shared prefix from the prompt cache.
 */
export function transcriptRequest(messages: AgentMessage[], style: SummaryStyle): Context {
	let text = style.prompts.transcript;
	if (style.focus) text += `\n\nAdditional focus: ${style.focus}`;
	return { messages: [...convertToLlm(messages), userText(text)] };
}

/** Pi's file-list tags, appended to every summary so later compactions keep tracking files. */
export function formatFiles(files: FileLists): string {
	const sections: string[] = [];
	if (files.readFiles.length > 0) sections.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
	if (files.modifiedFiles.length > 0) sections.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Strip file-list tags a model copied from a previous summary; the plan's lists replace them. */
export function stripFiles(summary: string): string {
	return summary.replace(/\n*<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
}

/** Run one summary request. Provider errors are retried `retries` times; truncated or tool-calling replies fail. */
export async function requestSummary(complete: Complete, model: Model<Api>, context: Context, options: SimpleStreamOptions, retries = 1): Promise<SummaryText> {
	for (let attempt = 0; ; attempt++) {
		const response = await complete(model, context, options);
		const text = contentText(response.content.filter((block) => block.type === "text")).trim();
		let failure: string | undefined;
		if (response.stopReason === "error") failure = response.errorMessage || "the provider returned an error";
		else if (response.stopReason === "aborted") failure = "aborted";
		else if (response.stopReason === "length") failure = "the summary hit the output token limit";
		else if (response.content.some((block) => block.type === "toolCall")) failure = "the summarizer called a tool";
		else if (!text) failure = "the summary was empty";
		if (!failure) return { text, usage: response.usage };
		// Another attempt hits the same output limit.
		if (response.stopReason === "length") throw new PermanentError(failure);
		if (response.stopReason !== "error" || attempt >= retries || options.signal?.aborted) throw new Error(failure);
	}
}

/** What a summary request runs on: the resolved summarizer model and the session it serves. */
export interface SummaryHost {
	model: Model<Api>;
	complete: Complete;
	/** The session's thinking level, used when `thinking` is `session`. */
	sessionThinking: ThinkingLevel | "off";
	/** Session ID for cache routing of transcript requests. */
	sessionId: string;
}

/** Build and send one summary request for `job` with the configured prompts, focus, and limits. */
export async function writeSummary(job: SummaryJob, config: BackgroundCompactionConfig, host: SummaryHost): Promise<SummaryOutput> {
	const { model } = host;
	const style = { prompts: config.prompts, focus: [config.focus, job.focus].filter(Boolean).join("\n\n") || undefined, toolResultChars: config.toolResultChars };
	const transcript = job.mode === "transcript" ? job.transcript : undefined;
	const request = transcript ? transcriptRequest(transcript, style) : serializedRequest(job.plan, style);
	const thinking = config.thinking === "session" ? host.sessionThinking : config.thinking;
	// The request and its summary must fit the summarizer's context window.
	const input = request.messages.reduce((sum, message) => sum + estimateTokens(message), Math.ceil((request.systemPrompt?.length ?? 0) / 4));
	const room = model.contextWindow > 0 ? model.contextWindow - input - 1024 : Number.POSITIVE_INFINITY;
	// Reasoning counts against the cap, so leave room for a high session thinking level.
	const maxTokens = Math.min(config.maxTokens ?? Math.min(model.maxTokens || 16384, 65536), room);
	if (maxTokens < 1024) throw new PermanentError(`the summary request does not fit ${model.provider}/${model.id}'s context window`);
	const options: SimpleStreamOptions = {
		signal: job.signal,
		maxTokens,
		reasoning: model.reasoning && thinking !== "off" ? (thinking as ThinkingLevel) : undefined,
		// Transcript requests share the session's cache routing. Standalone summaries skip cache writes,
		// which is also how bridge providers recognize a one-off summary.
		...(transcript ? { sessionId: host.sessionId, toolChoice: "none" as const } : { sessionId: uuidv7(), cacheRetention: "none" as const }),
	};
	const result = await requestSummary(host.complete, model, request, options);
	return { ...result, model: `${model.provider}/${model.id}` };
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
	if (!a) return b;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		...(a.reasoning !== undefined || b.reasoning !== undefined ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}),
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}
