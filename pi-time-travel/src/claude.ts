import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeEndpoint } from "./config.ts";
import { type Finding, FiredState, interrupts, reminders } from "./engine.ts";
import { httpClassifier } from "./judge.ts";
import { fileLogger } from "./log.ts";
import { clip, type Output } from "./matcher.ts";
import { blockReason, correctionText, reminderText, upfrontText } from "./prompts.ts";
import { loadRuntime } from "./runtime.ts";
import { NewFiles, viewToolCall } from "./tools.ts";

/** The fields of Claude Code's hook input this hook reads. */
export interface ClaudeHookInput {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
	stop_hook_active?: boolean;
	last_assistant_message?: string;
}

export interface ClaudeHookDeps {
	home: string;
	env: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

interface SessionState {
	turn: number;
	fired: Record<string, number>;
	/** Rules behind the last Stop block, to avoid blocking the same correction twice in a row. */
	lastStopBlock?: string[];
	/** Whether each path the agent touched existed at the time (NewFiles). */
	files?: Record<string, boolean>;
}

export function stateDirectory(home: string, env: NodeJS.ProcessEnv): string {
	return env.PI_TIME_TRAVEL_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi-time-travel", "claude");
}

/**
 * Per-session state in a JSON file. Claude Code runs hooks for parallel tool calls at once,
 * so updates take a directory lock; on contention the hook proceeds unlocked rather than stall.
 */
async function withState<T>(dir: string, session: string, update: (state: SessionState) => Promise<T>): Promise<T> {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${session.replace(/[^\w.-]/g, "_")}.json`);
	const lock = `${file}.lock`;
	let locked = false;
	for (let attempt = 0; attempt < 40 && !locked; attempt++) {
		try {
			mkdirSync(lock);
			locked = true;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		let state: SessionState = { turn: 0, fired: {} };
		try {
			state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
		} catch {}
		const result = await update(state);
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(state));
		renameSync(temp, file);
		return result;
	} finally {
		if (locked) rmSync(lock, { recursive: true, force: true });
	}
}

/** Shell commands Claude ran this session, newest last, as facts for judged rules. */
export function recentCommands(transcriptPath: string | undefined, limit = 30): string[] {
	if (!transcriptPath) return [];
	let text: string;
	try {
		const size = statSync(transcriptPath).size;
		const length = Math.min(size, 4 * 1024 * 1024);
		const buffer = Buffer.alloc(length);
		const fd = openSync(transcriptPath, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		text = buffer.toString("utf8");
	} catch {
		return [];
	}
	const commands: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.includes('"tool_use"')) continue;
		try {
			const entry = JSON.parse(line);
			for (const block of entry?.message?.content ?? []) {
				if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") commands.push(block.input.command);
			}
		} catch {}
	}
	return commands.slice(-limit);
}

const json = (value: unknown) => JSON.stringify(value);

/** Handles one Claude Code hook event. Returns the JSON to print, or nothing to stay silent. */
export async function handleClaudeHook(input: ClaudeHookInput, deps: ClaudeHookDeps): Promise<string | undefined> {
	const cwd = input.cwd ?? process.cwd();
	const session = input.session_id ?? "unknown";
	const runtime = loadRuntime({
		cwd,
		home: deps.home,
		env: deps.env,
		project: true,
		judge: (config) => {
			const endpoint = judgeEndpoint(config.judge, deps.env, deps.home);
			return "error" in endpoint ? endpoint : httpClassifier(endpoint, config.judge.timeoutMs, deps.fetch);
		},
		log: (config) => fileLogger(config.logFile, { harness: "claude", session }),
	});
	const { config, engine } = runtime;
	if (!config.enabled) return undefined;
	const log = fileLogger(config.logFile, { harness: "claude", session });
	const event = input.hook_event_name;

	if (event === "SessionStart") {
		const upfront = runtime.rules.filter((rule) => rule.alwaysApply);
		const thinkingOnly = runtime.rules.filter((rule) => rule.scope.thinking && !rule.scope.text && rule.scope.tools.size === 0);
		const warnings = [...runtime.warnings, ...thinkingOnly.map((rule) => `${rule.name}: watches only thinking, which Claude Code hooks cannot see`)];
		if (upfront.length === 0 && warnings.length === 0) return undefined;
		return json({
			...(warnings.length ? { systemMessage: `pi-time-travel: ${warnings.join("; ")}` } : {}),
			...(upfront.length ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: upfrontText(upfront) } } : {}),
		});
	}
	if (!engine.active) return undefined;
	const stateDir = stateDirectory(deps.home, deps.env);

	if (event === "PreToolUse" && input.tool_name) {
		const output: Output = { source: "tool", text: "", view: viewToolCall(input.tool_name, input.tool_input, cwd), id: input.tool_use_id };
		output.text = output.view!.text;
		return withState(stateDir, session, async (state) => {
			const files = new NewFiles(state.files);
			files.mark(output.view!, cwd);
			state.files = files.toJSON();
			const fired = FiredState.from(state);
			const evaluation = await engine.evaluate([output], fired, () => ({ commandsRunThisSession: recentCommands(input.transcript_path) }));
			log({ event: "check", hook: "PreToolUse", tool: input.tool_name, ms: Math.round(evaluation.ms), processMs: Math.round(process.uptime() * 1000), findings: evaluation.findings.length, cleared: evaluation.cleared });
			const stop = interrupts(evaluation.findings);
			const warn = reminders(evaluation.findings);
			if (stop.length === 0 && warn.length === 0) return undefined;
			act(fired, state, [...stop, ...warn]);
			record(log, "PreToolUse", stop, warn);
			if (stop.length > 0) {
				return json({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: blockReason(stop, stop, config.showExcerpt),
						...(warn.length ? { additionalContext: reminderText(warn, config.showExcerpt) } : {}),
					},
				});
			}
			return json({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: reminderText(warn, config.showExcerpt) } });
		});
	}

	if (event === "Stop") {
		const text = input.last_assistant_message ?? "";
		return withState(stateDir, session, async (state) => {
			const fired = FiredState.from(state);
			const evaluation = text ? await engine.evaluate([{ source: "text", text }], fired, () => ({ commandsRunThisSession: recentCommands(input.transcript_path) })) : undefined;
			if (evaluation) log({ event: "check", hook: "Stop", ms: Math.round(evaluation.ms), processMs: Math.round(process.uptime() * 1000), findings: evaluation.findings.length, cleared: evaluation.cleared });
			let stop = interrupts(evaluation?.findings ?? []);
			const warn = reminders(evaluation?.findings ?? []);
			// Claude already continued once for these rules; blocking again would loop on the same correction.
			if (input.stop_hook_active && stop.length > 0 && stop.every((finding) => state.lastStopBlock?.includes(finding.rule.name))) {
				log({ event: "loop-guard", rules: stop.map((finding) => finding.rule.name) });
				stop = [];
			}
			if (stop.length === 0) {
				state.turn += 1;
				state.lastStopBlock = undefined;
			}
			if (stop.length === 0 && warn.length === 0) return undefined;
			act(fired, state, [...stop, ...warn]);
			record(log, "Stop", stop, warn);
			if (stop.length > 0) {
				state.lastStopBlock = stop.map((finding) => finding.rule.name);
				const reason = [correctionText(stop, config.showExcerpt), warn.length ? reminderText(warn, config.showExcerpt) : ""].filter(Boolean).join("\n\n");
				return json({ decision: "block", reason });
			}
			return json({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: reminderText(warn, config.showExcerpt) } });
		});
	}
	return undefined;
}

function act(fired: FiredState, state: SessionState, findings: Finding[]): void {
	fired.turn = state.turn;
	fired.mark(findings.map((finding) => finding.rule.name));
	state.fired = fired.toJSON().fired;
}

function record(log: ReturnType<typeof fileLogger>, hook: string, stop: Finding[], warn: Finding[]): void {
	for (const finding of [...stop, ...warn]) {
		log({
			event: finding.action === "interrupt" ? "interrupt" : "remind",
			hook,
			rule: finding.rule.name,
			how: finding.how,
			probability: finding.probability,
			source: finding.output.source,
			tool: finding.output.view?.rawTool,
			paths: finding.output.view?.paths,
			excerpt: finding.excerpt,
			text: clip(finding.output.text, 4000),
		});
	}
}
