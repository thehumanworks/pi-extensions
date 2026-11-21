import type { Config } from "./config.ts";
import { type Classify, type JudgeCandidate, judge } from "./judge.ts";
import type { Logger } from "./log.ts";
import { conditionMatch, inScope, type Output } from "./matcher.ts";
import { isTriggered, type Rule } from "./rules.ts";

/** A rule broken by one output. */
export interface Finding {
	rule: Rule;
	output: Output;
	excerpt: string;
	how: "regex" | "judge";
	probability?: number;
	/** `interrupt` stops the output before it takes effect; `remind` lets it through with a warning. */
	action: "interrupt" | "remind";
}

export interface Evaluation {
	findings: Finding[];
	/** Regex matches the judge cleared as not violations. */
	cleared: Array<{ rule: string; excerpt: string; probability: number }>;
	/** Every judge answer, flagged or not. */
	verdicts: Array<{ rule: string; kind: JudgeCandidate["kind"]; probability: number }>;
	judgeErrors: string[];
	ms: number;
}

/** Which rules may act again, per the repeat policy. Turns count completed agent turns. */
export class FiredState {
	readonly fired = new Map<string, number>();
	turn = 0;

	eligible(rule: string, config: Pick<Config, "repeatMode" | "repeatGap">): boolean {
		const last = this.fired.get(rule);
		if (last === undefined || config.repeatMode === "always") return true;
		if (config.repeatMode === "once") return false;
		return this.turn - last >= config.repeatGap;
	}

	mark(rules: Iterable<string>): void {
		for (const rule of rules) this.fired.set(rule, this.turn);
	}

	toJSON(): { turn: number; fired: Record<string, number> } {
		return { turn: this.turn, fired: Object.fromEntries(this.fired) };
	}

	static from(data: unknown): FiredState {
		const state = new FiredState();
		if (typeof data === "object" && data !== null) {
			const { turn, fired } = data as { turn?: unknown; fired?: unknown };
			if (typeof turn === "number") state.turn = turn;
			if (typeof fired === "object" && fired !== null) {
				for (const [rule, at] of Object.entries(fired)) if (typeof at === "number") state.fired.set(rule, at);
			}
		}
		return state;
	}
}

function actionFor(rule: Rule, output: Output, config: Config): Finding["action"] {
	const mode = rule.interruptMode ?? config.interruptMode;
	const prose = output.source !== "tool";
	if (mode === "always" || (mode === "prose-only" && prose) || (mode === "tool-only" && !prose)) return "interrupt";
	return "remind";
}

export interface EngineOptions {
	config: Config;
	rules: Rule[];
	/** Absent when no judge is configured or reachable. */
	classify?: Classify;
	log?: Logger;
}

/** Harness-independent checking: regex triggers first, then the judge for `question` rules and confirmations. */
export class Engine {
	readonly config: Config;
	readonly rules: Rule[];
	readonly triggered: Rule[];
	readonly classify?: Classify;
	private readonly log: Logger;

	constructor(options: EngineOptions) {
		this.config = options.config;
		this.rules = options.rules;
		this.triggered = options.rules.filter(isTriggered);
		this.classify = options.classify;
		this.log = options.log ?? (() => {});
	}

	get active(): boolean {
		return this.config.enabled && this.triggered.length > 0;
	}

	async evaluate(outputs: Output[], state: FiredState, facts?: () => unknown): Promise<Evaluation> {
		const started = performance.now();
		const evaluation: Evaluation = { findings: [], cleared: [], verdicts: [], judgeErrors: [], ms: 0 };
		if (!this.active) return evaluation;
		const { config } = this;
		const jobs: Array<Promise<void>> = [];

		for (const output of outputs) {
			const candidates: JudgeCandidate[] = [];
			for (const rule of this.triggered) {
				if (!inScope(rule, output) || !state.eligible(rule.name, config)) continue;
				const excerpt = rule.conditions.length > 0 ? conditionMatch(rule, output) : undefined;
				if (rule.question) {
					// Conditions on a question rule only decide what is worth judging.
					if (this.classify && (rule.conditions.length === 0 || excerpt !== undefined)) candidates.push({ rule, kind: "question", excerpt });
				} else if (excerpt !== undefined) {
					if (this.classify && config.judge.confirm) candidates.push({ rule, kind: "confirm", excerpt });
					else evaluation.findings.push({ rule, output, excerpt, how: "regex", action: actionFor(rule, output, config) });
				}
			}
			if (candidates.length === 0 || !this.classify) continue;
			const classify = this.classify;
			jobs.push(
				judge(classify, output, candidates, config.judge.threshold, candidates.some((c) => c.kind === "question") ? facts?.() : undefined).then((outcome) => {
					this.log({ event: "judge", source: output.source, tool: output.view?.rawTool, ms: outcome.ms, inputTokens: outcome.inputTokens, error: outcome.error, verdicts: outcome.verdicts.map((v) => ({ rule: v.candidate.rule.name, kind: v.candidate.kind, p: v.probability })) });
					if (outcome.error) {
						evaluation.judgeErrors.push(outcome.error);
						// Without a verdict, a regex match stands and a question goes unanswered.
						for (const candidate of candidates) {
							if (candidate.kind === "confirm") evaluation.findings.push({ rule: candidate.rule, output, excerpt: candidate.excerpt ?? "", how: "regex", action: actionFor(candidate.rule, output, config) });
						}
						return;
					}
					for (const verdict of outcome.verdicts) {
						const { rule, kind, excerpt } = verdict.candidate;
						evaluation.verdicts.push({ rule: rule.name, kind, probability: verdict.probability });
						if (kind === "confirm") {
							if (verdict.flagged) evaluation.findings.push({ rule, output, excerpt: excerpt ?? "", how: "regex", probability: verdict.probability, action: actionFor(rule, output, config) });
							else evaluation.cleared.push({ rule: rule.name, excerpt: excerpt ?? "", probability: verdict.probability });
						} else if (verdict.flagged) {
							const action = config.judge.blocking ? actionFor(rule, output, config) : "remind";
							evaluation.findings.push({ rule, output, excerpt: excerpt ?? "", how: "judge", probability: verdict.probability, action });
						}
					}
				}),
			);
		}
		await Promise.all(jobs);
		evaluation.ms = performance.now() - started;
		return evaluation;
	}
}

export const interrupts = (findings: Finding[]) => findings.filter((finding) => finding.action === "interrupt");
export const reminders = (findings: Finding[]) => findings.filter((finding) => finding.action === "remind");
