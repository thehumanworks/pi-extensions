import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { PRESETS, type PromptSet } from "./prompts.ts";

export type ThinkingSetting = "session" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING: readonly ThinkingSetting[] = ["session", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface BackgroundCompactionConfig {
	enabled: boolean;
	/** Fraction of Pi's compaction threshold at which a background summary starts. */
	trigger: number;
	/** Contexts smaller than this are not summarized in the background. */
	minTokens: number;
	/** `threshold`: hold the summary until Pi compacts. `ready`: swap it in as soon as it is written. */
	swap: "threshold" | "ready";
	/** Summarizer as `provider/modelId`; undefined uses the session model. */
	model?: string;
	thinking: ThinkingSetting;
	/**
	 * `transcript` resends the native conversation so the session model reads it from the prompt cache;
	 * `serialized` sends a text rendering any model can summarize; `auto` picks transcript when it can.
	 */
	request: "serialized" | "transcript" | "auto";
	prompts: PromptSet;
	promptName: string;
	focus?: string;
	/** Overrides Pi's `compaction.keepRecentTokens` for background summaries. */
	keepRecentTokens?: number;
	/** Growth of the verbatim tail after which a held summary is refreshed in the background. */
	maxStaleTokens?: number;
	/** Largest share of the compaction threshold a swap may leave in context before it is caught up. */
	maxSwapRatio: number;
	/** Characters of each tool result kept in serialized requests (Pi keeps 2000). */
	toolResultChars: number;
	maxTokens?: number;
	timeoutMs: number;
	/** JSONL file receiving one line per lifecycle event. */
	trace?: string;
}

type Raw = Record<string, unknown>;

function object(value: unknown, name: string): Raw {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Raw;
}

function number(value: unknown, name: string, min: number, max: number, integer = true): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
		throw new Error(`backgroundCompaction.${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
	}
	return parsed;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`backgroundCompaction.${name} must be one of ${allowed.join(", ")}`);
	return value as T;
}

function bool(value: unknown, name: string): boolean | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && /^(1|true|on|yes)$/i.test(value)) return true;
	if (typeof value === "string" && /^(0|false|off|no)$/i.test(value)) return false;
	throw new Error(`backgroundCompaction.${name} must be a boolean`);
}

/** A string, or the contents of the file named after a leading `@`. */
function text(value: unknown, name: string, cwd: string): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`backgroundCompaction.${name} must be a string`);
	if (!value.startsWith("@")) return value;
	const path = value.slice(1).replace(/^~(?=\/|$)/, homedir());
	return readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8").trim();
}

const ENV = "PI_BACKGROUND_COMPACTION";

/** Merge `backgroundCompaction` settings with `PI_BACKGROUND_COMPACTION_*` environment overrides. */
export function readConfig(settings: unknown, cwd: string, env: NodeJS.ProcessEnv = process.env): BackgroundCompactionConfig {
	const raw = object(object(settings, "settings").backgroundCompaction, "backgroundCompaction");
	const pick = (key: string, envKey: string) => env[`${ENV}_${envKey}`] ?? raw[key];
	const promptName = oneOf(pick("prompt", "PROMPT"), "prompt", Object.keys(PRESETS)) ?? "coding";
	const preset = PRESETS[promptName]!;
	const prompts: PromptSet = {
		system: text(pick("systemPrompt", "SYSTEM_PROMPT"), "systemPrompt", cwd) ?? preset.system,
		initial: text(pick("instructions", "INSTRUCTIONS"), "instructions", cwd) ?? preset.initial,
		update: text(pick("updateInstructions", "UPDATE_INSTRUCTIONS"), "updateInstructions", cwd) ?? preset.update,
		transcript: text(pick("transcriptInstructions", "TRANSCRIPT_INSTRUCTIONS"), "transcriptInstructions", cwd) ?? preset.transcript,
	};
	const model = pick("model", "MODEL");
	if (model !== undefined && model !== "" && model !== "session" && (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model))) {
		throw new Error("backgroundCompaction.model must be provider/modelId or session");
	}
	return {
		enabled: bool(env[ENV] ?? raw.enabled, "enabled") ?? true,
		trigger: number(pick("trigger", "TRIGGER"), "trigger", 0.05, 1, false) ?? 0.7,
		minTokens: number(pick("minTokens", "MIN_TOKENS"), "minTokens", 0, 10_000_000) ?? 16_000,
		swap: oneOf(pick("swap", "SWAP"), "swap", ["threshold", "ready"] as const) ?? "threshold",
		model: model && model !== "session" ? (model as string) : undefined,
		thinking: oneOf(pick("thinking", "THINKING"), "thinking", THINKING) ?? "session",
		request: oneOf(pick("request", "REQUEST"), "request", ["serialized", "transcript", "auto"] as const) ?? "auto",
		prompts,
		promptName,
		focus: text(pick("focus", "FOCUS"), "focus", cwd),
		keepRecentTokens: number(pick("keepRecentTokens", "KEEP_RECENT_TOKENS"), "keepRecentTokens", 0, 10_000_000),
		maxStaleTokens: number(pick("maxStaleTokens", "MAX_STALE_TOKENS"), "maxStaleTokens", 0, 10_000_000),
		maxSwapRatio: number(pick("maxSwapRatio", "MAX_SWAP_RATIO"), "maxSwapRatio", 0.05, 1, false) ?? 0.5,
		toolResultChars: number(pick("toolResultChars", "TOOL_RESULT_CHARS"), "toolResultChars", 100, 1_000_000) ?? 16_000,
		maxTokens: number(pick("maxTokens", "MAX_TOKENS"), "maxTokens", 256, 1_000_000),
		timeoutMs: number(pick("timeoutMs", "TIMEOUT_MS"), "timeoutMs", 1000, 3_600_000) ?? 300_000,
		trace: typeof env[`${ENV}_TRACE`] === "string" && env[`${ENV}_TRACE`] ? env[`${ENV}_TRACE`] : undefined,
	};
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** Pi's effective compaction settings for a model: model override, then ordinary setting, then default. */
export function compactionSettings(settings: unknown, model?: { provider: string; id: string }): CompactionSettings {
	const compaction = (settings as { compaction?: Raw } | undefined)?.compaction ?? {};
	const overrides = (compaction.modelOverrides ?? {}) as Record<string, Raw | undefined>;
	const override = model ? overrides[`${model.provider}/${model.id}`] : undefined;
	const tokens = (key: string, fallback: number) => {
		const value = override?.[key] ?? compaction[key];
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
	};
	return {
		enabled: compaction.enabled !== false,
		reserveTokens: tokens("reserveTokens", 16384),
		keepRecentTokens: tokens("keepRecentTokens", 20000),
	};
}
