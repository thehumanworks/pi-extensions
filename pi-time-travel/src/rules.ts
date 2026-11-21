import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { globToRegExp } from "./glob.ts";

export type Source = "text" | "thinking" | "tool";
export type InterruptMode = "always" | "prose-only" | "tool-only" | "never";
export const INTERRUPT_MODES: readonly InterruptMode[] = ["always", "prose-only", "tool-only", "never"];

/** What a rule watches. `tools` holds tool names (lowercase) mapped to optional path globs; `"*"` is every tool. */
export interface Scope {
	text: boolean;
	thinking: boolean;
	tools: Map<string, RegExp[] | undefined>;
}

/**
 * A rule file in omp's TTSR format: YAML frontmatter, then the corrective instruction.
 * The file name is the rule name.
 */
export interface Rule {
	name: string;
	path: string;
	description?: string;
	/** Regex triggers. For a `question` rule they only pre-filter what goes to the judge. */
	conditions: RegExp[];
	/** Judged in natural language after an output completes. */
	question?: string;
	scope: Scope;
	/** Path gate: at least one candidate path must match. */
	globs: RegExp[];
	interruptMode?: InterruptMode;
	/** Also deliver the body up front, in the system prompt. */
	alwaysApply: boolean;
	/** Paths the agent created this session do not count, so it may edit its own new files (see NewFiles). */
	ignoreNewFiles: boolean;
	body: string;
}

export interface RuleSet {
	rules: Rule[];
	warnings: string[];
}

const RULE_EXTENSIONS = new Set([".md", ".mdc"]);

function asList(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** A JS regex source, or `/source/flags`. Stateful flags are dropped. */
export function compileCondition(source: string): RegExp {
	const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
	const [pattern, flags] = literal ? [literal[1]!, literal[2]!] : [source, ""];
	return new RegExp(pattern, flags.replace(/[gy]/g, ""));
}

/** Splits on commas outside parentheses, so `tool:edit(a/**, b/**)` stays one token. */
function splitScope(value: string): string[] {
	const tokens: string[] = [];
	let depth = 0;
	let current = "";
	for (const c of value) {
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		if (c === "," && depth === 0) {
			tokens.push(current);
			current = "";
		} else current += c;
	}
	tokens.push(current);
	return tokens;
}

export function parseScope(value: unknown, warn: (message: string) => void): Scope | undefined {
	const tokens = asList(value).flatMap((token) => (typeof token === "string" ? splitScope(token) : [String(token)]));
	if (tokens.length === 0) return { text: true, thinking: false, tools: new Map([["*", undefined]]) };
	const scope: Scope = { text: false, thinking: false, tools: new Map() };
	for (const raw of tokens) {
		const token = raw.trim();
		if (!token) continue;
		if (token === "text") scope.text = true;
		else if (token === "thinking") scope.thinking = true;
		else if (token === "tool" || token === "toolcall") scope.tools.set("*", undefined);
		else {
			const tool = /^(?:tool|toolcall):([^()\s]+)\s*(?:\((.+)\))?$/s.exec(token);
			if (!tool) {
				warn(`unknown scope "${token}"`);
				continue;
			}
			const name = tool[1]!.toLowerCase();
			const globs = tool[2] ? tool[2].split(/\s*,\s*/).map(globToRegExp) : undefined;
			const previous = scope.tools.get(name);
			scope.tools.set(name, globs && previous ? [...previous, ...globs] : globs && !scope.tools.has(name) ? globs : undefined);
		}
	}
	if (!scope.text && !scope.thinking && scope.tools.size === 0) return undefined;
	return scope;
}

function splitFrontmatter(content: string): { data: unknown; body: string } {
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	if (!match) return { data: {}, body: content.trim() };
	return { data: parseYaml(match[1]!) ?? {}, body: content.slice(match[0].length).trim() };
}

/** Parses one rule file. Invalid parts are warned about and ignored, like omp does. */
export function parseRule(name: string, path: string, content: string): { rule?: Rule; warnings: string[] } {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(`${name}: ${message}`);
	let data: unknown;
	let body: string;
	try {
		({ data, body } = splitFrontmatter(content));
	} catch (error) {
		warn(`invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`);
		return { warnings };
	}
	const meta = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

	const conditions: RegExp[] = [];
	for (const condition of asList(meta.condition)) {
		if (typeof condition !== "string") {
			warn("condition must be a string or a list of strings");
			continue;
		}
		try {
			conditions.push(compileCondition(condition));
		} catch (error) {
			warn(`invalid regex condition ${JSON.stringify(condition)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (meta.astCondition !== undefined) warn("astCondition is not supported here; ignored");
	const question = typeof meta.question === "string" && meta.question.trim() ? meta.question.trim() : undefined;
	const alwaysApply = meta.alwaysApply === true;
	const ignoreNewFiles = meta.ignoreNewFiles === true;
	if (meta.ignoreNewFiles !== undefined && typeof meta.ignoreNewFiles !== "boolean") warn("ignoreNewFiles must be true or false");

	let interruptMode: InterruptMode | undefined;
	if (meta.interruptMode !== undefined) {
		if (INTERRUPT_MODES.includes(meta.interruptMode as InterruptMode)) interruptMode = meta.interruptMode as InterruptMode;
		else warn(`unknown interruptMode ${JSON.stringify(meta.interruptMode)}; using the configured default`);
	}

	const globs: RegExp[] = [];
	for (const glob of asList(meta.globs)) {
		if (typeof glob === "string") globs.push(globToRegExp(glob));
		else warn("globs must be strings");
	}

	const scope = parseScope(meta.scope, warn);
	if (!body) {
		warn("empty body; ignored");
		return { warnings };
	}
	if (conditions.length === 0 && !question && !alwaysApply) {
		warn("no usable condition, question, or alwaysApply; ignored");
		return { warnings };
	}
	if (!scope) {
		warn("scope reaches no stream; ignored");
		return { warnings };
	}
	return {
		rule: {
			name,
			path,
			description: typeof meta.description === "string" ? meta.description : undefined,
			conditions,
			question,
			scope,
			globs,
			interruptMode,
			alwaysApply,
			ignoreNewFiles,
			body,
		},
		warnings,
	};
}

/** Whether the rule triggers dynamically, as opposed to only applying up front. */
export function isTriggered(rule: Rule): boolean {
	return rule.conditions.length > 0 || rule.question !== undefined;
}

export interface DiscoverOptions {
	cwd: string;
	home: string;
	/** Read project rule directories. Off for untrusted projects. */
	project: boolean;
	extraDirs?: string[];
	/** Also read omp rule files (`.omp/rules`, `~/.omp/agent/rules`) that have a trigger. */
	omp?: boolean;
}

/** Directories from `cwd` up to the repository root (or filesystem root), nearest first. */
function ancestors(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

/** Rule directories in precedence order: the first rule with a given name wins. */
export function ruleDirectories(options: DiscoverOptions): Array<{ dir: string; omp: boolean }> {
	const dirs: Array<{ dir: string; omp: boolean }> = [];
	const project = options.project ? ancestors(options.cwd) : [];
	for (const dir of project) dirs.push({ dir: join(dir, ".agents", "ttsr"), omp: false });
	for (const dir of options.extraDirs ?? []) dirs.push({ dir: resolve(options.cwd, dir), omp: false });
	dirs.push({ dir: join(options.home, ".agents", "ttsr"), omp: false });
	if (options.omp) {
		for (const dir of project) dirs.push({ dir: join(dir, ".omp", "rules"), omp: true });
		dirs.push({ dir: join(options.home, ".omp", "agent", "rules"), omp: true });
	}
	// The same directory can appear twice when cwd is under home.
	const seen = new Set<string>();
	return dirs.filter(({ dir }) => (seen.has(dir) ? false : (seen.add(dir), true)));
}

export function loadRules(options: DiscoverOptions, disabled: readonly string[] = []): RuleSet {
	const rules = new Map<string, Rule>();
	const warnings: string[] = [];
	for (const { dir, omp } of ruleDirectories(options)) {
		let names: string[];
		try {
			if (!statSync(dir).isDirectory()) continue;
			names = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const file of names) {
			if (!RULE_EXTENSIONS.has(extname(file))) continue;
			const name = basename(file, extname(file));
			if (rules.has(name) || disabled.includes(name)) continue;
			const path = join(dir, file);
			let content: string;
			try {
				content = readFileSync(path, "utf8");
			} catch (error) {
				warnings.push(`${name}: unreadable: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const parsed = parseRule(name, path, content);
			// omp rules without a trigger are omp's always-on rulebook, not stream rules.
			if (omp && parsed.rule && !isTriggered(parsed.rule)) continue;
			warnings.push(...parsed.warnings);
			if (parsed.rule) rules.set(name, parsed.rule);
		}
	}
	return { rules: [...rules.values()], warnings };
}
