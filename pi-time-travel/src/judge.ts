import type { JudgeApi } from "./config.ts";
import { clip, type Output } from "./matcher.ts";
import type { Rule } from "./rules.ts";

/** A yes/no question in the shape Pi's classifier API takes. */
export interface BoolQuestion {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}

export interface ClassifyResult {
	/** Probability of yes, by question id. Missing on error. */
	probabilities: Record<string, number>;
	error?: string;
	inputTokens?: number;
}

/** Runs one classification. Never rejects. */
export type Classify = (state: unknown, questions: Record<string, BoolQuestion>, signal?: AbortSignal) => Promise<ClassifyResult>;

export interface JudgeCandidate {
	rule: Rule;
	/** `question`: the rule's own question. `confirm`: is this regex match a real violation? */
	kind: "question" | "confirm";
	excerpt?: string;
}

export interface Verdict {
	candidate: JudgeCandidate;
	probability: number;
	flagged: boolean;
}

export interface JudgeOutcome {
	verdicts: Verdict[];
	error?: string;
	ms: number;
	inputTokens?: number;
}

/** Most output text sent to the judge. GPT-6 Luna and Jev both take far more; this bounds latency and cost. */
const MAX_STATE_TEXT = 24_000;

const NOT_A_VIOLATION =
	"Only an action the output takes, or an intention it states, counts as breaking the rule. Quoting, searching for, explaining, or discussing the subject is not a violation.";

function describeOutput(output: Output): string {
	if (output.source === "thinking") return "the agent's private reasoning";
	if (output.source === "text") return "the agent's message to the user";
	const tool = output.view?.tool ?? "tool";
	if (tool === "bash") return "a shell command the agent is about to run";
	if (tool === "edit" || tool === "write") return "text the agent is about to write into a file";
	return `arguments of a ${output.view?.rawTool ?? tool} tool call the agent is about to make`;
}

export function buildJudgeRequest(output: Output, candidates: JudgeCandidate[], facts?: unknown) {
	const questions: Record<string, BoolQuestion> = {};
	const ids = new Map<string, JudgeCandidate>();
	candidates.forEach((candidate, index) => {
		const id = `q${index}`;
		ids.set(id, candidate);
		const { rule } = candidate;
		const instructions =
			candidate.kind === "question"
				? `${rule.question}\n\nThe output to judge is state.output. state.facts, when present, describes the session so far. ${NOT_A_VIOLATION}`
				: `Does state.output break the project rule "${rule.name}"?\n\nThe rule:\n${clip(rule.body, 2000)}\n\nA pattern for this rule matched: ${candidate.excerpt ?? "(no excerpt)"}\n\n${NOT_A_VIOLATION}`;
		questions[id] = {
			type: "bool",
			instructions,
			criteria: { true: "state.output breaks the rule", false: "state.output does not break the rule" },
		};
	});
	const state = {
		output: {
			what: describeOutput(output),
			...(output.view ? { tool: output.view.rawTool, paths: output.view.paths } : {}),
			content: clip(output.text, MAX_STATE_TEXT),
		},
		...(facts === undefined ? {} : { facts }),
	};
	return { state, questions, ids };
}

/** Asks every candidate's question about one output in a single request. */
export async function judge(classify: Classify, output: Output, candidates: JudgeCandidate[], threshold: number, facts?: unknown): Promise<JudgeOutcome> {
	if (candidates.length === 0) return { verdicts: [], ms: 0 };
	const { state, questions, ids } = buildJudgeRequest(output, candidates, facts);
	const started = Date.now();
	const result = await classify(state, questions);
	const ms = Date.now() - started;
	if (result.error) return { verdicts: [], error: result.error, ms, inputTokens: result.inputTokens };
	const verdicts: Verdict[] = [];
	for (const [id, candidate] of ids) {
		const probability = result.probabilities[id];
		if (probability === undefined) return { verdicts: [], error: `no answer for ${candidate.rule.name}`, ms, inputTokens: result.inputTokens };
		verdicts.push({ candidate, probability, flagged: probability >= threshold });
	}
	return { verdicts, ms, inputTokens: result.inputTokens };
}

export interface HttpEndpoint {
	api: JudgeApi;
	baseUrl: string;
	apiKey: string;
	model: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A classifier over HTTP for the Claude Code hook: TypeSafe's System One protocol (also served by
 * Vercel AI Gateway and OpenRouter, including GPT-6 Luna) or OpenAI's Decisions API.
 */
export function httpClassifier(endpoint: HttpEndpoint, timeoutMs: number, fetchImpl: typeof fetch = fetch): Classify {
	const base = endpoint.baseUrl.replace(/\/+$/, "");
	return async (state, questions, signal) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		const body =
			endpoint.api === "system-one"
				? {
						model: endpoint.model,
						state,
						questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "noul", instructions: q.instructions, criteria: q.criteria }])),
					}
				: {
						model: endpoint.model,
						input: JSON.stringify(state),
						questions: Object.entries(questions).map(([id, q]) => ({
							type: "predicate",
							name: id,
							instructions: `${q.instructions}\n\nTrue means: ${q.criteria.true}\nFalse means: ${q.criteria.false}`,
						})),
					};
		try {
			const response = await fetchImpl(`${base}/${endpoint.api === "system-one" ? "systemone" : "decisions"}`, {
				method: "POST",
				headers: { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			const text = await response.text();
			if (!response.ok) return { probabilities: {}, error: `judge HTTP ${response.status}: ${text.slice(0, 300)}` };
			const json: unknown = JSON.parse(text);
			if (!isRecord(json)) return { probabilities: {}, error: "judge returned an unexpected response" };
			const usage = isRecord(json.usage) && typeof json.usage.input_tokens === "number" ? json.usage.input_tokens : undefined;
			const probabilities: Record<string, number> = {};
			if (endpoint.api === "system-one" && isRecord(json.answers)) {
				for (const [id, answer] of Object.entries(json.answers)) {
					if (isRecord(answer) && typeof answer.noul === "number") probabilities[id] = answer.noul;
				}
			} else if (Array.isArray(json.answers)) {
				for (const answer of json.answers) {
					if (isRecord(answer) && typeof answer.name === "string" && typeof answer.probability === "number") probabilities[answer.name] = answer.probability;
				}
			}
			return { probabilities, inputTokens: usage };
		} catch (error) {
			const message = timeout.aborted ? `judge timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
			return { probabilities: {}, error: message };
		}
	};
}
