import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { piStoredApiKey } from "./credentials.ts";
import { INTERRUPT_MODES, type InterruptMode } from "./rules.ts";

export type ContextMode = "discard" | "keep";
export type RepeatMode = "always" | "once" | "after-gap";
export type JudgeMode = "auto" | "on" | "off";
export type JudgeApi = "system-one" | "openai-decisions";

export interface JudgeConfig {
	/** `auto` judges when the model has credentials; `on` also warns when it has none; `off` never judges. */
	mode: JudgeMode;
	/** Provider and classifier model id, as Pi names them. */
	provider: string;
	model: string;
	/** Claude Code hook only (Pi resolves these itself): wire protocol, endpoint, and API key variable. */
	api?: JudgeApi;
	baseUrl?: string;
	apiKeyEnv?: string;
	/** Probability at or above which the judge's yes counts. */
	threshold: number;
	/** A judged `question` violation interrupts like a regex match, instead of only warning. */
	blocking: boolean;
	/** Ask the judge to confirm each regex match before acting on it. */
	confirm: boolean;
	timeoutMs: number;
}

export interface Config {
	enabled: boolean;
	/** Pi only. `discard` withdraws the violating response from the model's context; `keep` leaves it and adds the correction. */
	contextMode: ContextMode;
	interruptMode: InterruptMode;
	/** `always` acts on every violation; `once` per rule per session (omp's default); `after-gap` again after `repeatGap` turns. */
	repeatMode: RepeatMode;
	repeatGap: number;
	/** Pi only. Withdraw-and-resume at most this many times per agent run; later violations are still blocked. */
	maxRewindsPerRun: number;
	/** Quote the violating excerpt in the correction. */
	showExcerpt: boolean;
	disabledRules: string[];
	/** Extra rule directories, after the project's and before the user's. */
	ruleDirs: string[];
	importOmpRules: boolean;
	/** Append a JSON line per check and per action here. */
	logFile?: string;
	judge: JudgeConfig;
}

/**
 * The decision model defaults to GPT-6 Luna through Vercel AI Gateway. Change `judge.provider`
 * and `judge.model` in the user config to use another classifier.
 */
export const DEFAULTS: Config = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "always",
	repeatGap: 10,
	maxRewindsPerRun: 3,
	showExcerpt: true,
	disabledRules: [],
	ruleDirs: [],
	importOmpRules: false,
	judge: {
		mode: "auto",
		provider: "vercel-ai-gateway",
		model: "openai/gpt-6-luna-decisions",
		threshold: 0.85,
		blocking: false,
		confirm: false,
		timeoutMs: 8000,
	},
};

/** HTTP endpoints for the Claude Code hook, which has no Pi model registry. */
export const JUDGE_ENDPOINTS: Record<string, { api: JudgeApi; baseUrl: string; apiKeyEnv: string }> = {
	"vercel-ai-gateway": { api: "system-one", baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1", apiKeyEnv: "AI_GATEWAY_API_KEY" },
	openrouter: { api: "system-one", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
	typesafe: { api: "system-one", baseUrl: "https://api.typesafe.ai/v1", apiKeyEnv: "TYPESAFE_API_KEY" },
	openai: { api: "openai-decisions", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
};

/** Settings a cloned repository must not control: where requests and credentials go, and which files are read or written. */
const USER_ONLY = new Set(["ruleDirs", "logFile", "importOmpRules"]);
const USER_ONLY_JUDGE = new Set(["provider", "model", "api", "baseUrl", "apiKeyEnv"]);

export interface ConfigLayer {
	path: string;
	trusted: boolean;
	/** Warn when the file is missing. */
	required?: boolean;
}

export interface LoadedConfig {
	config: Config;
	warnings: string[];
	/** Files that contributed, in merge order. */
	sources: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Nearest `.agents/ttsr/config.json` from `cwd` up to the repository root. */
export function projectConfigPath(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		const path = join(dir, ".agents", "ttsr", "config.json");
		if (existsSync(path)) return path;
		if (existsSync(join(dir, ".git"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function apply(config: Config, raw: Record<string, unknown>, layer: ConfigLayer, warn: (message: string) => void): void {
	const where = layer.path;
	for (const [key, value] of Object.entries(raw)) {
		if (!layer.trusted && USER_ONLY.has(key)) {
			warn(`${where}: "${key}" is only read from user configuration; ignored`);
			continue;
		}
		switch (key) {
			case "enabled":
			case "showExcerpt":
			case "importOmpRules":
				if (typeof value === "boolean") config[key] = value;
				else warn(`${where}: ${key} must be true or false`);
				break;
			case "contextMode":
				if (value === "discard" || value === "keep") config.contextMode = value;
				else warn(`${where}: contextMode must be "discard" or "keep"`);
				break;
			case "interruptMode":
				if (INTERRUPT_MODES.includes(value as InterruptMode)) config.interruptMode = value as InterruptMode;
				else warn(`${where}: interruptMode must be one of ${INTERRUPT_MODES.join(", ")}`);
				break;
			case "repeatMode":
				if (value === "always" || value === "once" || value === "after-gap") config.repeatMode = value;
				else warn(`${where}: repeatMode must be "always", "once", or "after-gap"`);
				break;
			case "repeatGap":
			case "maxRewindsPerRun":
				if (typeof value === "number" && Number.isInteger(value) && value >= 0) config[key] = value;
				else warn(`${where}: ${key} must be a whole number`);
				break;
			case "disabledRules":
			case "ruleDirs":
				if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
					config[key] = key === "ruleDirs" ? value.map((dir) => resolve(dirname(where), dir)) : [...value];
				} else warn(`${where}: ${key} must be a list of strings`);
				break;
			case "logFile":
				if (typeof value === "string" && value) config.logFile = resolve(dirname(where), value);
				else warn(`${where}: logFile must be a path`);
				break;
			case "judge":
				if (isObject(value)) applyJudge(config.judge, value, layer, warn);
				else warn(`${where}: judge must be an object`);
				break;
			case "$schema":
				break;
			default:
				warn(`${where}: unknown setting "${key}"`);
		}
	}
}

function applyJudge(judge: JudgeConfig, raw: Record<string, unknown>, layer: ConfigLayer, warn: (message: string) => void): void {
	const where = `${layer.path}: judge`;
	for (const [key, value] of Object.entries(raw)) {
		if (!layer.trusted && USER_ONLY_JUDGE.has(key)) {
			warn(`${where}.${key} is only read from user configuration; ignored`);
			continue;
		}
		switch (key) {
			case "mode":
				if (value === "auto" || value === "on" || value === "off") judge.mode = value;
				else warn(`${where}.mode must be "auto", "on", or "off"`);
				break;
			case "provider":
			case "model":
			case "baseUrl":
			case "apiKeyEnv":
				if (typeof value === "string" && value) judge[key] = value;
				else warn(`${where}.${key} must be a non-empty string`);
				break;
			case "api":
				if (value === "system-one" || value === "openai-decisions") judge.api = value;
				else warn(`${where}.api must be "system-one" or "openai-decisions"`);
				break;
			case "threshold":
				if (typeof value === "number" && value > 0 && value <= 1) judge.threshold = value;
				else warn(`${where}.threshold must be a number above 0 and at most 1`);
				break;
			case "blocking":
			case "confirm":
				if (typeof value === "boolean") judge[key] = value;
				else warn(`${where}.${key} must be true or false`);
				break;
			case "timeoutMs":
				if (typeof value === "number" && value > 0) judge.timeoutMs = value;
				else warn(`${where}.timeoutMs must be a positive number`);
				break;
			default:
				warn(`${where}: unknown setting "${key}"`);
		}
	}
}

export interface LoadConfigOptions {
	cwd: string;
	home: string;
	env: NodeJS.ProcessEnv;
	/** Read the project's config. Off for untrusted projects. */
	project: boolean;
}

/** Defaults, then `~/.agents/ttsr/config.json`, then the project's, then `$PI_TIME_TRAVEL_CONFIG`, then env switches. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const config: Config = { ...DEFAULTS, disabledRules: [], ruleDirs: [], judge: { ...DEFAULTS.judge } };
	const warnings: string[] = [];
	const sources: string[] = [];
	const layers: ConfigLayer[] = [{ path: join(options.home, ".agents", "ttsr", "config.json"), trusted: true }];
	const project = options.project ? projectConfigPath(options.cwd) : undefined;
	if (project && project !== layers[0]!.path) layers.push({ path: project, trusted: false });
	if (options.env.PI_TIME_TRAVEL_CONFIG) layers.push({ path: resolve(options.cwd, options.env.PI_TIME_TRAVEL_CONFIG), trusted: true, required: true });

	for (const layer of layers) {
		if (!existsSync(layer.path)) {
			if (layer.required) warnings.push(`${layer.path}: not found`);
			continue;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(layer.path, "utf8"));
		} catch (error) {
			warnings.push(`${layer.path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!isObject(raw)) {
			warnings.push(`${layer.path}: must contain a JSON object`);
			continue;
		}
		apply(config, raw, layer, (message) => warnings.push(message));
		sources.push(layer.path);
	}
	if (options.env.PI_TIME_TRAVEL_LOG) config.logFile = resolve(options.cwd, options.env.PI_TIME_TRAVEL_LOG);
	if (options.env.PI_TIME_TRAVEL === "off" || options.env.PI_TIME_TRAVEL === "0") config.enabled = false;
	return { config, warnings, sources };
}

/**
 * The hook's HTTP endpoint for the configured judge, or why there is none. The key comes from
 * `judge.apiKeyEnv` when set; otherwise from Pi's stored credentials, like Pi itself, and then
 * the provider's usual environment variable.
 */
export function judgeEndpoint(judge: JudgeConfig, env: NodeJS.ProcessEnv, home: string): { api: JudgeApi; baseUrl: string; apiKey: string; model: string } | { error: string } {
	const known = JUDGE_ENDPOINTS[judge.provider];
	const api = judge.api ?? known?.api;
	const baseUrl = judge.baseUrl ?? known?.baseUrl;
	const apiKeyEnv = judge.apiKeyEnv ?? known?.apiKeyEnv;
	if (!api || !baseUrl || !apiKeyEnv) return { error: `no endpoint known for judge provider "${judge.provider}"; set judge.api, judge.baseUrl, and judge.apiKeyEnv` };
	const apiKey = judge.apiKeyEnv ? env[judge.apiKeyEnv] : (piStoredApiKey(judge.provider, home, env) ?? env[apiKeyEnv]);
	if (!apiKey) return { error: `no API key: neither Pi's stored ${judge.provider} key nor ${apiKeyEnv} is set` };
	return { api, baseUrl, apiKey, model: judge.model };
}
